import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CODEX = process.env.CLAUSE_CODEX_BIN ?? 'codex';
const available = spawnSync(CODEX, ['--version'], { encoding: 'utf8' });

function command(args, { cwd, env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(CODEX, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('close', () => clearTimeout(timer));
  });
}

async function fixture(t, actions) {
  const root = tempDir(t, 'clause-codex-e2e-$() `"-');
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const work = join(root, 'work');
  const storeRoot = join(root, 'store');
  const capture = join(root, 'events.jsonl');
  for (const dir of [codexHome, work]) mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
    CLAUDE_PENDING_EDITS_DIR: storeRoot, CLAUSE_CAPTURE: capture,
    TMPDIR: root, XDG_CONFIG_HOME: join(home, '.config'), CLAUSE_NODE: process.execPath,
    CLAUSE_CAPTURE_RUNNER: join(root, 'record.mjs') };
  const recorder = join(root, 'record.mjs');
  writeFileSync(recorder, `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.CLAUSE_CAPTURE, readFileSync(0, 'utf8') + '\\n');\n`);
  const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
    .map((event) => [event, [{ hooks: [{ type: 'command', command: '"$CLAUSE_NODE" "$CLAUSE_CAPTURE_RUNNER"' }] }]]));
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks }));
  const requests = [];
  let actionIndex = 0;
  let serverError = null;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const action = actions[actionIndex++];
      assert.ok(action, `unexpected model request ${actionIndex}`);
      const id = `response-${actionIndex}`;
      const output = action(body, actionIndex);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'connection': 'close' });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
      for (const item of output) send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) {
      serverError = error;
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const bundled = spawnSync(CODEX, ['debug', 'models', '--bundled'], { env, encoding: 'utf8' });
  assert.equal(bundled.status, 0, bundled.stderr);
  const model = JSON.parse(bundled.stdout).models.find((candidate) => candidate.apply_patch_tool_type === 'freeform');
  const catalogPath = join(root, 'models.json');
  writeFileSync(catalogPath, JSON.stringify({ models: [{ ...model, slug: 'clause-fixture', tool_mode: 'direct',
    use_responses_lite: false, base_instructions: 'Use the requested tools.', experimental_supported_tools: [] }] }));
  writeFileSync(join(codexHome, 'config.toml'), `model = "clause-fixture"
model_catalog_json = '${catalogPath}'
model_provider = "fixture"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[features]
code_mode = false
code_mode_host = false
multi_agent = false
hooks = true
plugins = true
`);
  const options = { cwd: work, env };
  {
    const marketplace = join(root, 'marketplace');
    for (const path of ['.codex-plugin/plugin.json', '.agents/plugins/marketplace.json',
      'codex-plugin/hook.mjs', 'codex-plugin/hooks/hooks.json',
      'claude-plugin/hook.mjs', 'claude-plugin/store.mjs', 'claude-plugin/reverse-diff.mjs']) {
      mkdirSync(join(marketplace, path, '..'), { recursive: true });
      cpSync(join(REPO, path), join(marketplace, path));
    }
    const added = await command(['plugin', 'marketplace', 'add', marketplace, '--json'], options);
    assert.equal(added.status, 0, added.stderr);
    const catalog = JSON.parse(readFileSync(join(marketplace, '.agents/plugins/marketplace.json'), 'utf8'));
    const installed = await command(['plugin', 'add', `${catalog.plugins[0].name}@${catalog.name}`, '--json'], options);
    assert.equal(installed.status, 0, installed.stderr);
    const installedPath = JSON.parse(installed.stdout).installedPath;
    assert.ok(installedPath.startsWith(root));
    assert.ok(existsSync(installedPath));
  }
  const run = (prompt, session) => command(['exec', ...(session ? ['resume', session] : []),
    '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json',
    '-c', 'sandbox_mode="danger-full-access"', ...(session ? [] : ['-C', work]), prompt], options);
  const events = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const completions = () => {
    const path = events().find((event) => event.transcript_path)?.transcript_path;
    return path && existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((row) => ['function_call_output', 'custom_tool_call_output', 'item_completed'].includes(row.payload?.type)) : [];
  };
  return { work, home, store: openStore(storeRoot), defaultStore: openStore(join(home, '.claude', 'pending-edits')),
    requests, events, completions, run,
    checkError: () => { if (serverError) throw serverError; },
    checkServer: () => { if (serverError) throw serverError; assert.equal(actionIndex, actions.length); } };
}

function patchCall(patch) {
  return (body, index) => {
    assert.ok(body.tools, `missing tools: ${Object.keys(body).join(', ')}`);
    const tool = body.tools.find((candidate) => candidate.name === 'apply_patch');
    assert.ok(tool, `apply_patch absent: ${body.tools.map((candidate) => candidate.name).join(', ')}`);
    return [{ type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
      id: `item-${index}`, call_id: `call-${index}`, name: 'apply_patch',
      ...(tool.type === 'custom' ? { input: patch } : { arguments: JSON.stringify({ patch }) }) }];
  };
}

const done = () => [{ type: 'message', id: 'done', role: 'assistant',
  content: [{ type: 'output_text', text: 'Done.' }] }];

function observedTools(context) {
  return context.events().filter((event) => event.hook_event_name === 'PreToolUse' || event.hook_event_name === 'PostToolUse');
}

test('real Codex records apply_patch and sends editor discard feedback on the next prompt',
  { skip: available.status !== 0, timeout: 120_000 }, async (t) => {
    const patch = '*** Begin Patch\n*** Update File: file with \'quote\' ~.txt\n@@\n-before\n+after\n*** Add File: ~/created "quote".txt\n+created\n*** Delete File: delete.txt\n*** Update File: source.txt\n*** Move to: renamed "quote".txt\n@@\n-source\n+moved\n*** End Patch';
    const context = await fixture(t, [patchCall(patch), done, done]);
    const file = join(context.work, "file with 'quote' ~.txt");
    writeFileSync(file, 'before\n');
    writeFileSync(join(context.work, 'delete.txt'), 'deleted\n');
    writeFileSync(join(context.work, 'source.txt'), 'source\n');
    const first = await context.run('Apply the requested patch.');
    context.checkError();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(readFileSync(file, 'utf8'), 'after\n', first.stderr);
    const observed = context.events().filter((event) => event.tool_name === 'apply_patch');
    assert.equal(observed.length, 2);
    assert.equal(observed[0].tool_use_id, observed[1].tool_use_id);
    assert.equal(observed[0].tool_input.command, patch);
    assert.equal(context.store.readEntry(context.store.idFor(file))?.base?.toString(), 'before\n',
      first.stdout + JSON.stringify(context.defaultStore.listEntries()));
    const created = join(context.work, '~', 'created "quote".txt');
    assert.equal(readFileSync(created, 'utf8'), 'created\n');
    assert.equal(context.store.readEntry(context.store.idFor(created))?.existed, false);
    assert.equal(context.store.readEntry(context.store.idFor(join(context.work, 'delete.txt')))?.base?.toString(), 'deleted\n');
    assert.equal(context.store.readEntry(context.store.idFor(join(context.work, 'source.txt')))?.base?.toString(), 'source\n');
    assert.equal(context.store.readEntry(context.store.idFor(join(context.work, 'renamed "quote".txt')))?.existed, false);
    context.store.appendDiscard({ path: file, scope: 'file' });
    const session = context.events().find((event) => event.hook_event_name === 'SessionStart').session_id;
    const second = await context.run('Continue after review.', session);
    assert.equal(second.status, 0, second.stderr);
    assert.match(JSON.stringify(context.requests.at(-1).input), /discarded all pending changes/);
    context.checkServer();
  });

test('real Codex leaves failed patch validation unchanged',
  { skip: available.status !== 0, timeout: 120_000 }, async (t) => {
    const patch = '*** Begin Patch\n*** Update File: failed.txt\n@@\n-missing context\n+after\n*** End Patch';
    const context = await fixture(t, [patchCall(patch), done]);
    const file = join(context.work, 'failed.txt');
    writeFileSync(file, 'before\n');
    const result = await context.run('Apply the requested patch.');
    context.checkError();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(file, 'utf8'), 'before\n');
    assert.deepEqual(context.store.listEntries(), []);
    context.checkServer();
  });

test('real Codex records the recoverable files after a partial cyclic move fails',
  { skip: available.status !== 0, timeout: 120_000 }, async (t) => {
    const patch = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-A\n+A2\n*** Update File: b.txt\n*** Move to: a.txt\n@@\n-B\n+B2\n*** End Patch';
    const context = await fixture(t, [patchCall(patch), done]);
    const first = join(context.work, 'a.txt');
    const second = join(context.work, 'b.txt');
    writeFileSync(first, 'A\n');
    writeFileSync(second, 'B\n');
    const result = await context.run('Apply the requested patch.');
    context.checkError();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const physical = { first: existsSync(first) ? readFileSync(first, 'utf8') : null,
      second: existsSync(second) ? readFileSync(second, 'utf8') : null };
    t.diagnostic(JSON.stringify(result.stdout.trim().split('\n').map(JSON.parse).filter((row) => row.item?.type === 'file_change')));
    t.diagnostic(JSON.stringify(context.completions()));
    assert.deepEqual(physical, { first: null, second: 'A2\n' });
    assert.equal(context.store.readEntry(context.store.idFor(first))?.base?.toString(), 'A\n');
    assert.equal(context.store.readEntry(context.store.idFor(second))?.base?.toString(), 'B\n');
    context.checkServer();
  });

test('real Codex forwards an intercepted shell patch with the command working directory',
  { skip: available.status !== 0, timeout: 120_000 }, async (t) => {
    const patch = '*** Begin Patch\n*** Update File: shell.txt\n@@\n-before\n+after\n*** End Patch';
    let subdirectory;
    const shellCall = (_body, index) => [{ type: 'function_call', id: `item-${index}`,
      call_id: `call-${index}`, name: 'exec_command', arguments: JSON.stringify({
        cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`, workdir: subdirectory, login: false }) }];
    const context = await fixture(t, [shellCall, done]);
    subdirectory = join(context.work, 'sub');
    mkdirSync(subdirectory);
    const file = join(subdirectory, 'shell.txt');
    writeFileSync(file, 'before\n');
    const result = await context.run('Apply the requested shell patch.');
    context.checkError();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const pre = observedTools(context).find((event) => event.hook_event_name === 'PreToolUse');
    t.diagnostic(JSON.stringify(context.completions()));
    assert.equal(pre.tool_name, 'Bash');
    assert.equal(pre.cwd, subdirectory);
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    assert.equal(context.store.readEntry(context.store.idFor(file))?.base?.toString(), 'before\n');
    assert.deepEqual(context.store.readSessionDirs(context.store.idFor(file)), [context.work]);
    context.checkServer();
  });

test('real Codex settles a partial failure before another patch in the same turn',
  { skip: available.status !== 0, timeout: 120_000 }, async (t) => {
    const partial = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-A\n+A2\n*** Update File: b.txt\n*** Move to: a.txt\n@@\n-B\n+B2\n*** End Patch';
    const later = '*** Begin Patch\n*** Update File: b.txt\n@@\n-A2\n+A3\n*** End Patch';
    const context = await fixture(t, [patchCall(partial), patchCall(later), done]);
    const first = join(context.work, 'a.txt');
    const second = join(context.work, 'b.txt');
    writeFileSync(first, 'A\n');
    writeFileSync(second, 'B\n');
    const result = await context.run('Apply the patches in order.');
    context.checkError();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(existsSync(first), false);
    assert.equal(readFileSync(second, 'utf8'), 'A3\n');
    assert.equal(context.store.readEntry(context.store.idFor(first))?.base?.toString(), 'A\n');
    assert.equal(context.store.readEntry(context.store.idFor(second))?.base?.toString(), 'B\n');
    context.checkServer();
  });
