// Runs the real `opencode` binary with this plugin loaded, against a scripted stand-in for a model API.
// The unit tests cover the plugin's logic; this is the only test that proves OpenCode's side of the
// contract (hooks awaited, the event shapes, how it resolves paths), which is what an OpenCode update
// can change. It is skipped when OpenCode is not installed; OPENCODE_BIN names a binary off the PATH.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OPENCODE = process.env.OPENCODE_BIN || 'opencode';
const skip = spawnSync(OPENCODE, ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'opencode is not installed (OPENCODE_BIN names it)';

/** A run that never finishes is a failure to report, not a test run that hangs. */
const RUN_TIMEOUT_MS = 120_000;

const text = (/** @type {Buffer | null | undefined} */ bytes) => bytes?.toString('utf8');

/**
 * A folder to run OpenCode in, with its own home (so nothing of the developer's configuration or
 * sessions is read or written) and its own pending-edits store.
 * @param {import('node:test').TestContext} t
 */
function sandbox(t) {
  const base = tempDir(t, 'oc-e2e-');
  const project = join(base, 'project');
  mkdirSync(project);
  const store = join(base, 'store');
  return { base, project, store, entries: openStore(store) };
}

/** @param {ReturnType<typeof sandbox>} box @param {string} name @param {string} content */
function seed(box, name, content) {
  mkdirSync(dirname(join(box.project, name)), { recursive: true });
  writeFileSync(join(box.project, name), content);
}

/**
 * Answers each agent turn with the next step of `steps`: tool calls to make, or text to finish with.
 * A request that offers no tools (OpenCode asking for a session title) gets a plain reply.
 * @param {import('node:test').TestContext} t
 * @param {({ tools: { name: string, args: object }[] } | { text: string })[]} steps
 */
async function fakeModel(t, steps) {
  let next = 0;
  let callIds = 0;
  /** @type {{ role: string, content: string }[][]} what the model was sent on each agent turn */
  const turns = [];
  const chunk = (/** @type {object} */ delta, /** @type {string | null} */ finish) => ({
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => (body += part));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [] }));
      }
      const request = JSON.parse(body || '{}');
      const offered = Array.isArray(request.tools) && request.tools.length > 0;
      /** @type {object[]} */
      let chunks;
      if (!offered) {
        chunks = [chunk({ role: 'assistant', content: 'ok' }, null), chunk({}, 'stop')];
      } else {
        turns.push(request.messages.map((/** @type {any} */ m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })));
        const step = steps[next++] ?? { text: 'done' };
        chunks =
          'text' in step
            ? [chunk({ role: 'assistant', content: step.text }, null), chunk({}, 'stop')]
            : [
                chunk(
                  {
                    role: 'assistant',
                    content: null,
                    tool_calls: step.tools.map((tool, index) => ({ index, id: `call_${++callIds}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })),
                  },
                  null,
                ),
                chunk({}, 'tool_calls'),
              ];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const part of chunks) res.write(`data: ${JSON.stringify(part)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', () => listening(undefined)));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, turns };
}

/**
 * One `opencode run` in the sandbox. Models whose id starts with `gpt-` get the `patch` tool instead
 * of `edit` and `write`, so that is how a test picks the tool it exercises.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof sandbox>} box
 * @param {{ steps: Parameters<typeof fakeModel>[1], model?: 'scripted' | 'gpt-fake', resume?: boolean, prompt?: string }} options
 */
async function run(t, box, { steps, model = 'scripted', resume = false, prompt = 'go' }) {
  const { port, turns } = await fakeModel(t, steps);
  const home = join(box.base, 'home');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const limits = { tool_call: true, limit: { context: 100_000, output: 8_000 } };
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      update: 'disable',
      plugins: [PLUGIN_DIR],
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'unused' },
          models: { scripted: { name: 'Scripted', ...limits }, 'gpt-fake': { name: 'GPT Fake', ...limits } },
        },
      },
    }),
  );

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENCODE') && name !== 'CLAUDE_PROJECT_DIR'));
  const child = spawn(OPENCODE, ['run', '--standalone', '--auto', '--format', 'json', ...(resume ? ['--continue'] : []), '-m', `fake/${model}`, prompt], {
    cwd: box.project,
    // stdin is closed: OpenCode waits on it for more input when it is not a terminal.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      HOME: home,
      // OpenCode takes its working folder from $PWD, which `cwd` alone leaves pointing at the caller's.
      PWD: box.project,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      CLAUDE_PENDING_EDITS_DIR: box.store,
    },
  });
  let stderr = '';
  child.stderr.on('data', (part) => (stderr += part));
  child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
  const status = await new Promise((done) => child.on('close', done));
  clearTimeout(timer);
  assert.equal(status, 0, stderr);
  return { turns };
}

test('edits and writes by an OpenCode agent become pending from their exact pre-edit bytes', { skip }, async (t) => {
  const box = sandbox(t);
  seed(box, 'a.txt', 'alpha\nbeta\ngamma\n');
  const a = join(box.project, 'a.txt');
  const b = join(box.project, 'sub', 'b.txt');

  await run(t, box, {
    steps: [
      { tools: [{ name: 'edit', args: { path: 'a.txt', oldString: 'beta', newString: 'BETA' } }] },
      // Files an agent creates are named by absolute path in these tests: should OpenCode ever run in
      // some folder other than the sandbox, a relative path would create the file there. Edits of
      // existing files can stay relative, since they fail when the folder is wrong.
      { tools: [{ name: 'write', args: { path: b, content: 'new file\n' } }] },
      { tools: [{ name: 'edit', args: { path: 'a.txt', oldString: 'gamma', newString: 'GAMMA' } }] },
      { text: 'done' },
    ],
  });

  // Two edits, and the baseline is still the file as it was before the first one.
  assert.equal(text(box.entries.readEntry(box.entries.idFor(a))?.base), 'alpha\nbeta\ngamma\n');
  assert.deepEqual(box.entries.readEntry(box.entries.idFor(a))?.sessionDirs, [box.project]);
  assert.equal(box.entries.readTouch(box.entries.idFor(a))?.line, 2);
  assert.equal(box.entries.readEntry(box.entries.idFor(b))?.existed, false);
  assert.equal(box.entries.listEntries().length, 2);
});

test('a patch by an OpenCode agent tracks each file it adds, updates, moves and deletes', { skip }, async (t) => {
  const box = sandbox(t);
  seed(box, 'upd.txt', 'one\ntwo\n');
  seed(box, 'mv.txt', 'keep\n');
  seed(box, 'del.txt', 'bye\n');
  const at = (/** @type {string} */ name) => box.entries.readEntry(box.entries.idFor(join(box.project, name)));
  // Created files by absolute path, as in the first test.
  const patchText = [
    '*** Begin Patch',
    `*** Add File: ${join(box.project, 'add.txt')}`,
    '+new',
    '*** Update File: upd.txt',
    '@@',
    ' one',
    '-two',
    '+TWO',
    '*** Update File: mv.txt',
    `*** Move to: ${join(box.project, 'moved.txt')}`,
    '@@',
    '-keep',
    '+kept',
    '*** Delete File: del.txt',
    '*** End Patch',
  ].join('\n');

  await run(t, box, { model: 'gpt-fake', steps: [{ tools: [{ name: 'patch', args: { patchText } }] }, { text: 'done' }] });

  assert.equal(at('add.txt')?.existed, false);
  assert.equal(text(at('upd.txt')?.base), 'one\ntwo\n');
  assert.equal(text(at('mv.txt')?.base), 'keep\n');
  assert.equal(at('moved.txt')?.existed, false);
  assert.equal(text(at('del.txt')?.base), 'bye\n');
});

test('a call OpenCode reports as failed leaves nothing pending, and the next edit is still tracked', { skip }, async (t) => {
  const box = sandbox(t);
  seed(box, 'a.txt', 'alpha\nbeta\n');

  await run(t, box, {
    steps: [
      { tools: [{ name: 'edit', args: { path: 'a.txt', oldString: 'not in the file', newString: 'x' } }] },
      { tools: [{ name: 'edit', args: { path: 'a.txt', oldString: 'beta', newString: 'BETA' } }] },
      { text: 'done' },
    ],
  });

  assert.equal(box.entries.listEntries().length, 1);
  assert.equal(text(box.entries.readEntry(box.entries.idFor(join(box.project, 'a.txt')))?.base), 'alpha\nbeta\n');
  assert.equal(readdirOrEmpty(join(box.store, 'staging')).length, 0);
});

test('a discard made in the editor is put to the agent on its next prompt in that session', { skip }, async (t) => {
  const box = sandbox(t);
  seed(box, 'a.txt', 'alpha\nbeta\n');
  const a = join(box.project, 'a.txt');

  await run(t, box, {
    prompt: 'first prompt',
    steps: [{ tools: [{ name: 'edit', args: { path: 'a.txt', oldString: 'beta', newString: 'BETA' } }] }, { text: 'done' }],
  });
  box.entries.appendDiscard({ path: a, scope: 'file' });
  const { turns } = await run(t, box, { resume: true, prompt: 'second prompt', steps: [{ text: 'ok' }] });

  const sent = turns.at(-1)?.map((message) => message.content) ?? [];
  const note = sent.findIndex((content) => content.includes('discarded all pending changes in this file'));
  assert.ok(note > 0, `the note was not sent: ${JSON.stringify(sent)}`);
  assert.match(sent[note], /a\.txt/);
  assert.ok(sent.findIndex((content) => content.includes('second prompt')) > note, 'the note comes before the prompt it belongs to');
});

/** @param {string} dir */
function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
