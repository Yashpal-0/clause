import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';
import plugin, { patchPaths, resolveTarget, runHook } from '../index.js';

/**
 * Loads the plugin against a stand-in for OpenCode's plugin context and a scratch store. The plugin
 * starts the real hook, which reads the store's location from the environment, so the variable is
 * set for the length of the test.
 * @param {import('node:test').TestContext} t
 * @param {{ sessions?: Record<string, string>, seed?: (root: string) => void, getFails?: boolean, syntheticFails?: boolean, claudeProjectDir?: string }} [options]
 *   sessions: the folder each session was started in; any other session was started in the work folder.
 *   claudeProjectDir: what a Claude Code session that is OpenCode's parent would leave in the environment.
 */
async function start(t, { sessions = {}, seed = () => {}, getFails = false, syntheticFails = false, claudeProjectDir } = {}) {
  const root = join(tempDir(t), 'store');
  const work = tempDir(t);
  setEnv(t, 'CLAUDE_PENDING_EDITS_DIR', root);
  // A developer running these tests inside Claude Code must not decide where sessions "started".
  setEnv(t, 'CLAUDE_PROJECT_DIR', claudeProjectDir);
  seed(root);

  /** @type {Map<string, (event: any) => Promise<void>>} */
  const hooks = new Map();
  /** @type {any[]} */
  const notes = [];
  const ctx = {
    location: { directory: work },
    tool: { hook: async (/** @type {string} */ name, /** @type {any} */ callback) => void hooks.set(name, callback) },
    session: {
      get: async ({ sessionID }) => {
        if (getFails) throw new Error('session not found');
        return { id: sessionID, location: { directory: sessions[sessionID] ?? work } };
      },
      hook: async (/** @type {string} */ name, /** @type {any} */ callback) => void hooks.set(name, callback),
      synthetic: async (/** @type {any} */ message) => {
        if (syntheticFails) throw new Error('synthetic refused');
        notes.push(message);
      },
    },
  };
  await plugin.setup(ctx);
  return { root, work, store: openStore(root), hooks, notes };
}

/** @param {import('node:test').TestContext} t @param {string} name @param {string | undefined} value */
function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/**
 * One tool call the way OpenCode reports it: `execute.before`, the tool's own effect on disk, then
 * `execute.after`.
 * @param {Awaited<ReturnType<typeof start>>} env
 */
async function call(env, { tool, input, session = 'ses_1', id = 'call_1', run = () => {}, status = 'completed' }) {
  const event = { tool, sessionID: session, agent: 'build', messageID: 'msg_1', id, input };
  await env.hooks.get('execute.before')?.(event);
  await run();
  await env.hooks.get('execute.after')?.({ ...event, status });
}

/** @param {Awaited<ReturnType<typeof start>>} env @param {string} path */
const entryOf = (env, path) => env.store.readEntry(env.store.idFor(path));

/** @param {string} root */
const stagingLeft = (root) => (existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []);

const text = (/** @type {Buffer | null | undefined} */ bytes) => bytes?.toString('utf8');

test('an edit leaves the exact pre-edit bytes as the baseline and records where the session started', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'alpha\nbeta\ngamma\n');

  await call(env, {
    tool: 'edit',
    input: { path: file, oldString: 'beta', newString: 'BETA' },
    run: () => writeFileSync(file, 'alpha\nBETA\ngamma\n'),
  });

  const entry = entryOf(env, file);
  assert.equal(entry?.existed, true);
  assert.equal(text(entry?.base), 'alpha\nbeta\ngamma\n');
  assert.deepEqual(entry?.sessionDirs, [env.work]);
  assert.equal(env.store.readTouch(env.store.idFor(file))?.line, 1);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a write that creates a file records a baseline of "no file"; one that overwrites keeps the old bytes', async (t) => {
  const env = await start(t);
  const created = join(env.work, 'new.txt');
  const overwritten = join(env.work, 'old.txt');
  writeFileSync(overwritten, 'before\n');

  await call(env, { tool: 'write', id: 'call_1', input: { path: created, content: 'hello\n' }, run: () => writeFileSync(created, 'hello\n') });
  await call(env, { tool: 'write', id: 'call_2', input: { path: overwritten, content: 'after\n' }, run: () => writeFileSync(overwritten, 'after\n') });

  assert.equal(entryOf(env, created)?.existed, false);
  assert.equal(entryOf(env, created)?.base, null);
  assert.equal(text(entryOf(env, overwritten)?.base), 'before\n');
});

test('a relative path is resolved against the folder the session was started in, not the process folder', async (t) => {
  const other = tempDir(t);
  const env = await start(t, { sessions: { ses_2: other } });
  const file = join(other, 'sub', 'b.txt');
  mkdirSync(join(other, 'sub'));
  writeFileSync(file, 'one\n');

  await call(env, {
    tool: 'edit',
    session: 'ses_2',
    input: { path: 'sub/b.txt', oldString: 'one', newString: 'two' },
    run: () => writeFileSync(file, 'two\n'),
  });

  assert.equal(text(entryOf(env, file)?.base), 'one\n');
  assert.deepEqual(entryOf(env, file)?.sessionDirs, [other]);
});

test('without the session record, the folder the plugin was loaded in stands in', async (t) => {
  const env = await start(t, { getFails: true });
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'edit', input: { path: 'a.txt', oldString: 'one', newString: 'two' }, run: () => writeFileSync(file, 'two\n') });

  assert.equal(text(entryOf(env, file)?.base), 'one\n');
});

test('a later edit adds to the pending file instead of replacing its baseline, and a second session folder is listed', async (t) => {
  const other = tempDir(t);
  const env = await start(t, { sessions: { ses_2: other } });
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'v0\n');

  await call(env, { tool: 'write', id: 'call_1', input: { path: file, content: 'v1\n' }, run: () => writeFileSync(file, 'v1\n') });
  await call(env, { tool: 'write', id: 'call_2', session: 'ses_2', input: { path: file, content: 'v2\n' }, run: () => writeFileSync(file, 'v2\n') });

  assert.equal(text(entryOf(env, file)?.base), 'v0\n');
  assert.deepEqual(entryOf(env, file)?.sessionDirs, [env.work, other]);
});

test('an edit that changes nothing leaves no entry behind', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'same\n');

  await call(env, { tool: 'write', input: { path: file, content: 'same\n' }, run: () => writeFileSync(file, 'same\n') });

  assert.deepEqual(env.store.listEntries(), []);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a call that fails without touching the file leaves nothing behind', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'edit', status: 'error', input: { path: file, oldString: 'zzz', newString: 'y' } });

  assert.deepEqual(env.store.listEntries(), []);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a call that reports an error after it changed the file still shows the change', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'edit', status: 'error', input: { path: file, oldString: 'one', newString: 'two' }, run: () => writeFileSync(file, 'two\n') });

  assert.equal(text(entryOf(env, file)?.base), 'one\n');
});

test('parallel calls on different files are each tracked from their own bytes', async (t) => {
  const env = await start(t);
  const a = join(env.work, 'a.txt');
  const b = join(env.work, 'b.txt');
  writeFileSync(a, 'a0\n');
  writeFileSync(b, 'b0\n');

  await Promise.all([
    call(env, { tool: 'write', id: 'call_a', input: { path: a, content: 'a1\n' }, run: () => writeFileSync(a, 'a1\n') }),
    call(env, { tool: 'write', id: 'call_b', input: { path: b, content: 'b1\n' }, run: () => writeFileSync(b, 'b1\n') }),
  ]);

  assert.equal(text(entryOf(env, a)?.base), 'a0\n');
  assert.equal(text(entryOf(env, b)?.base), 'b0\n');
});

test('a patch tracks every file it adds, updates, moves and deletes', async (t) => {
  const env = await start(t);
  const [updated, moved, movedTo, deleted, added] = ['upd.txt', 'mv.txt', 'moved.txt', 'del.txt', 'add.txt'].map((name) => join(env.work, name));
  writeFileSync(updated, 'one\ntwo\n');
  writeFileSync(moved, 'keep\n');
  writeFileSync(deleted, 'bye\n');
  const patchText = [
    '*** Begin Patch',
    '*** Add File: add.txt',
    '+new',
    '*** Update File: upd.txt',
    '@@',
    ' one',
    '-two',
    '+TWO',
    '*** Update File: mv.txt',
    '*** Move to: moved.txt',
    '@@',
    ' keep',
    '*** Delete File: del.txt',
    '*** End Patch',
  ].join('\n');

  await call(env, {
    tool: 'patch',
    input: { patchText },
    run: () => {
      writeFileSync(added, 'new\n');
      writeFileSync(updated, 'one\nTWO\n');
      writeFileSync(movedTo, 'keep\n');
      rmSync(moved);
      rmSync(deleted);
    },
  });

  assert.equal(entryOf(env, added)?.existed, false);
  assert.equal(text(entryOf(env, updated)?.base), 'one\ntwo\n');
  assert.equal(text(entryOf(env, moved)?.base), 'keep\n');
  assert.equal(entryOf(env, movedTo)?.existed, false);
  assert.equal(text(entryOf(env, deleted)?.base), 'bye\n');
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a patch that names a file twice records it once, from the original bytes', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  const patchText = ['*** Begin Patch', '*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: a.txt', '@@', '-two', '+TWO', '*** End Patch'].join('\n');

  await call(env, { tool: 'patch', input: { patchText }, run: () => writeFileSync(file, 'ONE\nTWO\n') });

  assert.equal(text(entryOf(env, file)?.base), 'one\ntwo\n');
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a patch of many files tracks every one of them', async (t) => {
  const env = await start(t);
  const files = Array.from({ length: 9 }, (_, index) => join(env.work, `f${index}.txt`));
  for (const file of files) writeFileSync(file, 'old\n');
  const patchText = ['*** Begin Patch', ...files.flatMap((file) => [`*** Update File: ${file}`, '@@', '-old', '+new']), '*** End Patch'].join('\n');

  await call(env, { tool: 'patch', input: { patchText }, run: () => files.forEach((file) => writeFileSync(file, 'new\n')) });

  for (const file of files) assert.equal(text(entryOf(env, file)?.base), 'old\n', file);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('two edits are told apart even when the model reuses a call id', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'v0\n');
  const touchAfter = async (/** @type {string} */ content) => {
    await call(env, { tool: 'write', id: 'call_0', input: { path: file, content }, run: () => writeFileSync(file, content) });
    return env.store.readTouch(env.store.idFor(file))?.tool;
  };

  const first = await touchAfter('v1\n');
  const second = await touchAfter('v2\n');

  assert.ok(first && second);
  assert.notEqual(first, second);
});

test('the folder a parent Claude Code session was started in does not become the session folder', async (t) => {
  const env = await start(t, { claudeProjectDir: tempDir(t) });
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'write', input: { path: file, content: 'two\n' }, run: () => writeFileSync(file, 'two\n') });

  assert.deepEqual(entryOf(env, file)?.sessionDirs, [env.work]);
});

test('tools that do not write files, and calls with unusable input, are ignored', async (t) => {
  const env = await start(t);

  await call(env, { tool: 'shell', input: { command: 'echo hi > x' } });
  await call(env, { tool: 'read', input: { path: 'x' } });
  await call(env, { tool: 'constructor', input: { path: 'x' } });
  await call(env, { tool: 'edit', input: { path: 42 } });
  await call(env, { tool: 'edit', input: undefined });
  await call(env, { tool: 'write', input: { path: '' } });
  await call(env, { tool: 'patch', input: { patchText: 7 } });

  assert.deepEqual(env.store.listEntries(), []);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('an after-event for a call that was never seen does nothing', async (t) => {
  const env = await start(t);
  await env.hooks.get('execute.after')?.({ tool: 'edit', sessionID: 'ses_1', messageID: 'msg_1', id: 'unseen', input: {}, status: 'completed' });
  assert.deepEqual(env.store.listEntries(), []);
});

test('loading the plugin sweeps staging left behind by interrupted edits', async (t) => {
  const env = await start(t, {
    seed: (root) => {
      const leftover = join(root, 'staging', 'interrupted');
      mkdirSync(leftover, { recursive: true });
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(leftover, twoDaysAgo, twoDaysAgo);
    },
  });
  assert.deepEqual(stagingLeft(env.root), []);
});

test('loading fails with a way out when Node cannot be started', async (t) => {
  setEnv(t, 'CLAUSE_NODE', join(tempDir(t), 'no-such-node'));
  await assert.rejects(start(t), /CLAUSE_NODE/);
});

test('a hook that hangs is killed once the timeout passes', async (t) => {
  const script = join(tempDir(t), 'node');
  writeFileSync(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  setEnv(t, 'CLAUSE_NODE', script);

  const began = Date.now();
  const result = await runHook('pre', {}, { timeoutMs: 200 });

  assert.equal(result.started, true);
  assert.ok(Date.now() - began < 5000, 'the hook was waited on past its timeout');
});

test('a discard made in the editor reaches the agent once, on its next prompt', async (t) => {
  const env = await start(t);
  const prompt = () => env.hooks.get('prompt')?.({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'hi', files: [] } });

  await prompt(); // the first sight of a session starts from now, as a resumed Claude session does
  assert.deepEqual(env.notes, []);

  env.store.appendDiscard({ path: join(env.work, 'a.txt'), scope: 'file' });
  env.store.appendDiscard({ path: join(tempDir(t), 'elsewhere.txt'), scope: 'file' });
  await prompt();

  assert.equal(env.notes.length, 1);
  assert.equal(env.notes[0].sessionID, 'ses_1');
  assert.equal(env.notes[0].resume, false);
  assert.match(env.notes[0].text, /a\.txt: discarded all pending changes in this file/);
  assert.doesNotMatch(env.notes[0].text, /elsewhere\.txt/);

  await prompt();
  assert.equal(env.notes.length, 1);
});

test('a note that cannot be added is logged and does not break the prompt', async (t) => {
  const env = await start(t, { syntheticFails: true });
  const prompt = () => env.hooks.get('prompt')?.({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'hi', files: [] } });
  await prompt();
  env.store.appendDiscard({ path: join(env.work, 'a.txt'), scope: 'file' });

  await prompt();

  assert.match(readFileSync(join(env.root, 'errors.log'), 'utf8'), /opencode prompt.*synthetic refused/s);
});

test('patchPaths lists every file a patch names, whatever wraps the patch', () => {
  const body = ['*** Begin Patch', '*** Add File: new.txt', '+hello', '*** Update File: old.txt', '*** Move to: moved.txt', '@@', '-a', '+b', '*** Delete File: gone.txt', '*** End Patch'];
  const expected = ['new.txt', 'old.txt', 'moved.txt', 'gone.txt'];

  assert.deepEqual(patchPaths(body.join('\n')), expected);
  assert.deepEqual(patchPaths(body.join('\r\n')), expected);
  assert.deepEqual(patchPaths(`cat <<'EOF'\n${body.join('\n')}\nEOF`), expected);
  assert.deepEqual(patchPaths(body.map((line) => `  ${line}`).join('\n')), expected); // OpenCode trims header lines
  assert.deepEqual(patchPaths('just some text'), []);
  assert.deepEqual(patchPaths('*** Begin Patch\n*** Add File: \n*** End Patch'), []);
});

test('resolveTarget resolves a tool path the way OpenCode does', () => {
  assert.equal(resolveTarget('/work', 'a/b.txt', '/home/u'), '/work/a/b.txt');
  assert.equal(resolveTarget('/work', '../x.txt', '/home/u'), '/x.txt');
  assert.equal(resolveTarget('/work', '/abs/c.txt', '/home/u'), '/abs/c.txt');
  assert.equal(resolveTarget('/work', '~', '/home/u'), '/home/u');
  assert.equal(resolveTarget('/work', '~/d.txt', '/home/u'), '/home/u/d.txt');
  assert.equal(resolveTarget('/work', '~other/e.txt', '/home/u'), '/work/~other/e.txt');
});
