// Runs the real `omp` binary with this plugin loaded, against a scripted OpenAI-compatible model.
// The unit tests cover the plugin's logic. This is the check that OMP actually loads the plugin,
// emits tool_call before the write and tool_result after it, and that those events reach the hook,
// also when OMP runs as an ACP agent and hands the write to the editor.
// Skipped when `omp` is not installed. OMP_BIN names a binary that is not on the PATH.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';

const PLUGIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.mjs');
const OMP = process.env.OMP_BIN || 'omp';
const skip = spawnSync(OMP, ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'omp is not installed (OMP_BIN names it)';

const text = (/** @type {Buffer | null | undefined} */ bytes) => bytes?.toString('utf8');

/**
 * @typedef {object} BodyEdit an edit in a mode whose tool takes a body
 * @property {string} mode the edit mode OMP runs in
 * @property {string} input the body the model sends, with the project folder in place of `{project}`
 * @property {string} [read] a file the model reads first, putting the tag `read` shows for it in
 *   place of `{tag}` in the body, as a hashline edit must
 */

/**
 * A scripted model. A prompt to replace the file calls `write`, and one to edit it calls `edit` with
 * the body of `edit`. A tool result other than that read ends the turn. Requests with no tools (a
 * title, a side question) get plain text.
 * @param {import('node:test').TestContext} t
 * @param {BodyEdit} [edit]
 */
function fakeModel(t, edit) {
  /** @type {string[]} */
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] }));
        return;
      }
      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1) ?? {};
      const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string') : [];
      const transcript = messages.map((message) => messageText(message?.content)).join('\n');
      seen.push(transcript);
      const reply = replyFor(last, tools, edit);
      const payload = body.stream ? streamOf(reply) : JSON.stringify(completionOf(reply));
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('fake model has no port'));
      t.after(() => new Promise((done) => server.close(() => done())));
      resolve({ port: address.port, seen });
    });
  });
}

/** @param {unknown} content */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part !== null && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('');
}

/**
 * @param {{ role?: string, content?: unknown, tool_call_id?: string }} last
 * @param {string[]} tools
 * @param {BodyEdit} [edit]
 * @returns {{ text: string } | { tool: string, args: Record<string, unknown> }}
 */
function replyFor(last, tools, edit) {
  if (last.role === 'tool') {
    if (edit?.read === undefined || last.tool_call_id !== 'call_read') return { text: 'done' };
    const tag = /#([0-9A-F]{4})\]/.exec(messageText(last.content))?.[1] ?? 'none';
    return { tool: 'edit', args: { input: edit.input.replace('{tag}', tag) } };
  }
  // The last message, not the transcript: a later prompt in the same session must not write again.
  const asked = messageText(last.content);
  if (tools.includes('write') && asked.includes('replace the file')) {
    return { tool: 'write', args: { path: 'a.txt', content: 'new\n' } };
  }
  if (tools.includes('edit') && edit !== undefined && asked.includes('edit the file')) {
    return edit.read === undefined ? { tool: 'edit', args: { input: edit.input } } : { tool: 'read', args: { path: edit.read } };
  }
  return { text: 'pong' };
}

/** @param {{ text: string } | { tool: string, args: Record<string, unknown> }} reply */
function completionOf(reply) {
  const message = 'text' in reply
    ? { role: 'assistant', content: reply.text }
    : {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call_${reply.tool}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
      };
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 0,
    model: 'fake-model',
    choices: [{ index: 0, message, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** @param {{ text: string } | { tool: string, args: Record<string, unknown> }} reply */
function streamOf(reply) {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model' };
  const delta = 'text' in reply
    ? { role: 'assistant', content: reply.text }
    : {
        role: 'assistant',
        tool_calls: [{ index: 0, id: `call_${reply.tool}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
      };
  const finish = 'text' in reply ? 'stop' : 'tool_calls';
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {BodyEdit} [edit]
 */
async function sandbox(t, edit) {
  const base = tempDir(t, 'omp-e2e-');
  const home = join(base, 'home');
  const project = join(base, 'project');
  const agentDir = join(home, '.omp', 'agent');
  const storeDir = join(base, 'store');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'old\n');
  const model = await fakeModel(t, edit && { ...edit, input: edit.input.replaceAll('{project}', project) });
  writeFileSync(
    join(agentDir, 'models.yml'),
    [
      'providers:',
      '  fake:',
      `    baseUrl: http://127.0.0.1:${model.port}/v1`,
      '    auth: none',
      '    api: openai-completions',
      '    models:',
      '      - id: fake-model',
      '        name: Fake Model',
      '        reasoning: false',
      '',
    ].join('\n'),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    PI_CONFIG_DIR: '.omp',
    PI_CODING_AGENT_DIR: agentDir,
    PI_NO_TITLE: '1',
    CLAUDE_PENDING_EDITS_DIR: storeDir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(edit === undefined ? {} : { PI_EDIT_VARIANT: edit.mode }),
  };
  return { project, storeDir, model, env };
}

/**
 * @param {ReturnType<typeof sandbox> extends Promise<infer T> ? T : never} box
 * @param {string[]} args
 */
function runOmp(box, args) {
  const child = spawn(OMP, args, { cwd: box.project, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 75_000);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, seen: box.model.seen.join('\n---\n') });
    });
  });
}

// This plugin and nothing else from the private home. Both the print and the ACP launch use them.
const pluginOnly = [
  '--model',
  'fake/fake-model',
  '--extension',
  PLUGIN,
  '--no-extensions',
  '--no-skills',
  '--no-rules',
  '--no-lsp',
  '--no-context-files',
];
const launch = ['-p', ...pluginOnly, '--auto-approve', '--approval-mode', 'yolo', '--max-time', '60s'];

/**
 * Starts `omp acp` and plays the editor: it advertises fs.writeTextFile, so OMP hands every write
 * to it, and it saves each one to disk the way VS Code saves the buffer.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof sandbox> extends Promise<infer T> ? T : never} box
 */
function acpEditor(t, box) {
  const child = spawn(OMP, ['acp', ...pluginOnly], { cwd: box.project, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  /** @type {{ path: string, content: string }[]} */
  const writes = [];
  /** @type {Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  let lastId = 0;
  const send = (/** @type {object} */ message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  /** @type {Record<string, (params: any) => unknown>} */
  const answers = {
    'fs/write_text_file': ({ path, content }) => {
      writes.push({ path, content });
      writeFileSync(path, content);
      return {};
    },
    'fs/read_text_file': ({ path }) => ({ content: readFileSync(path, 'utf8') }),
    'session/request_permission': ({ options }) => ({
      outcome: { outcome: 'selected', optionId: options.find((/** @type {{ kind: string }} */ option) => option.kind.startsWith('allow')).optionId },
    }),
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
      const caller = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) caller?.reject(new Error(`${JSON.stringify(message.error)}\nstderr:\n${stderr}`));
      else caller?.resolve(message.result);
    } else if (message.id !== undefined) {
      const answer = answers[message.method];
      send(answer ? { id: message.id, result: answer(message.params) } : { id: message.id, error: { code: -32601, message: `${message.method} is not handled` } });
    }
  });
  child.on('exit', (code) => {
    for (const caller of waiting.values()) caller.reject(new Error(`omp acp exited ${code}\nstderr:\n${stderr}`));
    waiting.clear();
  });
  return {
    writes,
    /**
     * @param {string} method
     * @param {object} params
     * @returns {Promise<any>}
     */
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++lastId;
        waiting.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

test('an OMP write becomes pending from the exact pre-edit bytes', { skip, timeout: 90_000 }, async (t) => {
  const box = await sandbox(t);
  const run = await runOmp(box, [...launch, '--no-session', 'replace the file']);

  const store = openStore(box.storeDir);
  const entry = store.readEntry(store.idFor(join(box.project, 'a.txt')));
  assert.equal(run.code, 0, `omp exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nseen:\n${run.seen}`);
  assert.equal(readFileSync(join(box.project, 'a.txt'), 'utf8'), 'new\n');
  assert.equal(text(entry?.base), 'old\n');
  assert.equal(entry?.existed, true);
  assert.deepEqual(entry?.sessionDirs, [box.project]);
});

// Each body edits a file with a `[build]` line next to a `build` folder. Read as a hashline header,
// that line names the folder, and the hook logs that the folder is not a regular file.
const bodyEdits = {
  apply_patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n [build]\n-old\n+new\n*** End Patch\n',
  sloppy: '*** Edit File: a.txt\n*** Find\n[build]\nold\n*** Replace\n[build]\nnew\n',
};
for (const [mode, input] of Object.entries(bodyEdits)) {
  test(`an OMP edit in ${mode} mode is pending for the file it names, and only that file`, { skip, timeout: 90_000 }, async (t) => {
    const box = await sandbox(t, { mode, input });
    const file = join(box.project, 'a.txt');
    writeFileSync(file, '[build]\nold\n');
    mkdirSync(join(box.project, 'build'));
    const run = await runOmp(box, [...launch, '--no-session', 'edit the file']);

    const store = openStore(box.storeDir);
    const errors = join(box.storeDir, 'errors.log');
    assert.equal(run.code, 0, `omp exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nseen:\n${run.seen}`);
    assert.equal(readFileSync(file, 'utf8'), '[build]\nnew\n');
    assert.equal(text(store.readEntry(store.idFor(file))?.base), '[build]\nold\n');
    assert.equal(existsSync(errors) ? readFileSync(errors, 'utf8') : '', '');
  });
}

// Paths OMP's edit tool reads as `a.txt`: a `read` header pasted as the path, and the stray marks
// models put in front of a path.
const pathForms = {
  'a pasted read header': '[a.txt#1A2B]',
  'a stray colon': ':./a.txt',
  'a stray @': '@{project}/a.txt',
  'a file URL': 'file://{project}/a.txt',
};
for (const [form, path] of Object.entries(pathForms)) {
  test(`an OMP edit of ${form} is pending for the file OMP edits`, { skip, timeout: 90_000 }, async (t) => {
    const box = await sandbox(t, { mode: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch\n` });
    const file = join(box.project, 'a.txt');
    const run = await runOmp(box, [...launch, '--no-session', 'edit the file']);

    const store = openStore(box.storeDir);
    assert.equal(run.code, 0, `omp exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nseen:\n${run.seen}`);
    assert.equal(readFileSync(file, 'utf8'), 'new\n', `OMP did not edit a.txt\nseen:\n${run.seen}`);
    assert.equal(text(store.readEntry(store.idFor(file))?.base), 'old\n');
  });
}

test('an OMP edit of a missing path is pending for the one file OMP edits in its place', { skip, timeout: 90_000 }, async (t) => {
  // When the path does not exist, OMP edits the one file in the folder whose path ends with it. Its
  // search skips a folder a `.ignore` file names, which git still lists.
  const box = await sandbox(t, { mode: 'apply_patch', input: '*** Begin Patch\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch\n' });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: box.project }).status, 0);
  const file = join(box.project, 'sub', 'b.txt');
  const skipped = join(box.project, 'vendor', 'b.txt');
  for (const path of [file, skipped]) {
    mkdirSync(dirname(path));
    writeFileSync(path, 'old\n');
  }
  writeFileSync(join(box.project, '.ignore'), 'vendor/\n');
  const run = await runOmp(box, [...launch, '--no-session', 'edit the file']);

  const store = openStore(box.storeDir);
  assert.equal(run.code, 0, `omp exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nseen:\n${run.seen}`);
  assert.equal(readFileSync(file, 'utf8'), 'new\n', `OMP did not edit sub/b.txt\nseen:\n${run.seen}`);
  assert.equal(readFileSync(skipped, 'utf8'), 'old\n');
  assert.equal(text(store.readEntry(store.idFor(file))?.base), 'old\n');
  assert.equal(store.readEntry(store.idFor(skipped)), null);
});

test('an OMP hashline edit is pending for the quoted file it names and the quoted file it moves to', { skip, timeout: 90_000 }, async (t) => {
  // `read` shows the header unquoted. OMP also takes the path in quotes, and asks for a destination
  // with a space to be quoted.
  const box = await sandbox(t, { mode: 'hashline', read: 'a b.txt', input: '["a b.txt"#{tag}]\nPUT 1.=1:\n+new\nMV "c d.txt"\n' });
  const source = join(box.project, 'a b.txt');
  const destination = join(box.project, 'c d.txt');
  writeFileSync(source, 'old\n');
  const run = await runOmp(box, [...launch, '--no-session', 'edit the file']);

  const store = openStore(box.storeDir);
  assert.equal(run.code, 0, `omp exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nseen:\n${run.seen}`);
  assert.equal(existsSync(destination) && readFileSync(destination, 'utf8'), 'new\n', `the edit did not land\nseen:\n${run.seen}`);
  assert.equal(existsSync(source), false);
  assert.equal(text(store.readEntry(store.idFor(source))?.base), 'old\n');
  assert.equal(store.readEntry(store.idFor(destination))?.existed, false);
});

test('a discard is told to the same OMP session on its next prompt', { skip, timeout: 90_000 }, async (t) => {
  const box = await sandbox(t);
  const first = await runOmp(box, [...launch, 'hello']);
  assert.equal(first.code, 0, `first prompt exited ${first.code}\nstderr:\n${first.stderr}\nseen:\n${first.seen}`);

  openStore(box.storeDir).appendDiscard({ path: join(box.project, 'a.txt'), scope: 'file' });
  box.model.seen.length = 0;
  const second = await runOmp(box, [...launch, '--continue', 'and now']);

  assert.equal(second.code, 0, `second prompt exited ${second.code}\nstderr:\n${second.stderr}\nseen:\n${second.seen}`);
  assert.match(second.seen, /a\.txt: discarded all pending changes in this file/);
  assert.equal(readFileSync(join(box.project, 'a.txt'), 'utf8'), 'old\n');
});

test('a write OMP hands to an ACP editor is pending, and a discard reaches the next prompt', { skip, timeout: 90_000 }, async (t) => {
  const box = await sandbox(t);
  const editor = acpEditor(t, box);
  const file = join(box.project, 'a.txt');
  await editor.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  const { sessionId } = await editor.request('session/new', { cwd: box.project, mcpServers: [] });

  await editor.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'replace the file' }] });
  const store = openStore(box.storeDir);
  assert.deepEqual(editor.writes, [{ path: file, content: 'new\n' }]);
  assert.equal(text(store.readEntry(store.idFor(file))?.base), 'old\n');

  // What Discard does in the editor: put the pre-edit bytes back, then leave a note for the agent.
  writeFileSync(file, 'old\n');
  store.appendDiscard({ path: file, scope: 'file' });
  box.model.seen.length = 0;
  await editor.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'and now' }] });
  assert.match(box.model.seen.join('\n'), /a\.txt: discarded all pending changes in this file/);
  assert.equal(editor.writes.length, 1);
});
