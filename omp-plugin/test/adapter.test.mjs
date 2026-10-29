import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';
import clause, { editedPaths, hashlinePaths, patchPaths, resolveTarget, runHook, sloppyPaths } from '../index.mjs';

/**
 * Loads the extension against a stand-in for OMP and a scratch store. The extension starts the real
 * hook, which reads the store's location from the environment.
 * @param {import('node:test').TestContext} t
 * @param {{ sessionId?: string, claudeProjectDir?: string, seed?: (root: string) => void }} [options]
 */
function start(t, { sessionId = 'ses_1', claudeProjectDir, seed = () => {} } = {}) {
  const root = join(tempDir(t), 'store');
  const work = tempDir(t);
  setEnv(t, 'CLAUDE_PENDING_EDITS_DIR', root);
  setEnv(t, 'CLAUDE_PROJECT_DIR', claudeProjectDir);
  seed(root);

  /** @type {Map<string, (event: any, ctx: any) => Promise<any>>} */
  const handlers = new Map();
  /** @type {{ message: string, type?: string }[]} */
  const notices = [];
  clause({
    on: (name, handler) => void handlers.set(name, handler),
  });
  const ctx = {
    cwd: work,
    ui: { notify: (message, type) => void notices.push({ message, type }) },
    sessionManager: { getSessionId: () => sessionId },
  };
  return { root, work, store: openStore(root), handlers, notices, ctx };
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
 * One tool call the way OMP reports it: `tool_call`, the tool's own effect on disk, then `tool_result`.
 * @param {ReturnType<typeof start>} env
 */
async function call(env, { tool, input, id = 'call_1', run = () => {}, isError = false, sessionId }) {
  const ctx = sessionId === undefined ? env.ctx : { ...env.ctx, sessionManager: { getSessionId: () => sessionId } };
  const event = { toolName: tool, toolCallId: id, input };
  await env.handlers.get('tool_call')?.(event, ctx);
  await run();
  await env.handlers.get('tool_result')?.({ ...event, isError }, ctx);
}

/** @param {ReturnType<typeof start>} env @param {string} path */
const entryOf = (env, path) => env.store.readEntry(env.store.idFor(path));

/** @param {string} root */
const stagingLeft = (root) => (existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []);

const text = (/** @type {Buffer | null | undefined} */ bytes) => bytes?.toString('utf8');

test('a replace edit leaves the exact pre-edit bytes as the baseline and records where the session started', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'alpha\nbeta\ngamma\n');

  await call(env, {
    tool: 'edit',
    input: { path: file, old_string: 'beta', new_string: 'BETA' },
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

test('a relative path is resolved against the session folder, and a patch rename tracks both files', async (t) => {
  const env = await start(t);
  const relative = join(env.work, 'sub', 'b.txt');
  const source = join(env.work, 'mv.txt');
  const dest = join(env.work, 'moved.txt');
  mkdirSync(join(env.work, 'sub'));
  writeFileSync(relative, 'one\n');
  writeFileSync(source, 'keep\n');

  await call(env, {
    tool: 'edit',
    id: 'call_rel',
    input: { path: 'sub/b.txt', old_string: 'one', new_string: 'two' },
    run: () => writeFileSync(relative, 'two\n'),
  });
  await call(env, {
    tool: 'edit',
    id: 'call_mv',
    input: { path: 'mv.txt', edits: [{ op: 'update', rename: 'moved.txt', diff: '@@\n' }] },
    run: () => {
      writeFileSync(dest, 'keep\n');
      rmSync(source);
    },
  });

  assert.equal(text(entryOf(env, relative)?.base), 'one\n');
  assert.equal(text(entryOf(env, source)?.base), 'keep\n');
  assert.equal(entryOf(env, dest)?.existed, false);
});

test('hashline and apply-patch name every file they can change, and a line of file text does not', async (t) => {
  const env = await start(t);
  const hashed = join(env.work, 'a b.ts');
  const bare = join(env.work, 'b.ts');
  const moved = join(env.work, 'next.ts');
  const added = join(env.work, 'add.txt');
  const updated = join(env.work, 'upd.txt');
  writeFileSync(hashed, 'one\n');
  writeFileSync(bare, 'two\n');
  writeFileSync(updated, 'old\n');

  const hashline = ['[a b.ts#1A2B]', 'PUT 1:', '+ONE', '[b.ts]', 'PUT 1:', '+TWO', 'MV next.ts'].join('\n');
  await call(env, {
    tool: 'edit',
    id: 'call_hash',
    input: { input: hashline },
    run: () => {
      writeFileSync(hashed, 'ONE\n');
      writeFileSync(bare, 'TWO\n');
      writeFileSync(moved, 'TWO\n');
    },
  });
  const apply = ['*** Begin Patch', '*** Add File: add.txt', '+new', '*** Update File: upd.txt', '@@', '-old', '+new', '*** End Patch'].join('\n');
  await call(env, {
    tool: 'edit',
    id: 'call_apply',
    input: { input: apply },
    run: () => {
      writeFileSync(added, 'new\n');
      writeFileSync(updated, 'new\n');
    },
  });

  assert.equal(text(entryOf(env, hashed)?.base), 'one\n');
  assert.equal(text(entryOf(env, bare)?.base), 'two\n');
  assert.equal(entryOf(env, moved)?.existed, false);
  assert.equal(entryOf(env, added)?.existed, false);
  assert.equal(text(entryOf(env, updated)?.base), 'old\n');
  assert.deepEqual(stagingLeft(env.root), []);
});

test('an edit that changes nothing, or fails before it writes, leaves no entry and no staging', async (t) => {
  const env = await start(t);
  const same = join(env.work, 'same.txt');
  const untouched = join(env.work, 'untouched.txt');
  writeFileSync(same, 'same\n');
  writeFileSync(untouched, 'one\n');

  await call(env, { tool: 'write', id: 'call_same', input: { path: same, content: 'same\n' }, run: () => writeFileSync(same, 'same\n') });
  await call(env, { tool: 'edit', id: 'call_err', isError: true, input: { path: untouched, old_string: 'zzz', new_string: 'y' } });

  assert.deepEqual(env.store.listEntries(), []);
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a call that reports an error after it changed the file still shows the change', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, {
    tool: 'edit',
    isError: true,
    input: { path: file, old_string: 'one', new_string: 'two' },
    run: () => writeFileSync(file, 'two\n'),
  });

  assert.equal(text(entryOf(env, file)?.base), 'one\n');
});

test('a second tool_call for the same id snapshots the file again, so a change in between is the baseline', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'v0\n');
  const event = { toolName: 'write', toolCallId: 'call_1', input: { path: file, content: 'v2\n' } };

  await env.handlers.get('tool_call')?.(event, env.ctx);
  writeFileSync(file, 'v0-other\n');
  await env.handlers.get('tool_call')?.(event, env.ctx);
  writeFileSync(file, 'v2\n');
  await env.handlers.get('tool_result')?.(event, env.ctx);

  assert.equal(text(entryOf(env, file)?.base), 'v0-other\n');
  assert.deepEqual(stagingLeft(env.root), []);
});

test('a revised tool_call drops the paths it no longer names', async (t) => {
  const env = await start(t);
  const first = join(env.work, 'first.txt');
  const second = join(env.work, 'second.txt');
  writeFileSync(first, 'a\n');
  writeFileSync(second, 'b\n');

  await env.handlers.get('tool_call')?.({ toolName: 'write', toolCallId: 'call_1', input: { path: first, content: 'A\n' } }, env.ctx);
  await env.handlers.get('tool_call')?.({ toolName: 'write', toolCallId: 'call_1', input: { path: second, content: 'B\n' } }, env.ctx);
  writeFileSync(second, 'B\n');
  await env.handlers.get('tool_result')?.({ toolName: 'write', toolCallId: 'call_1', input: { path: second, content: 'B\n' } }, env.ctx);

  assert.equal(entryOf(env, first), null);
  assert.equal(text(entryOf(env, second)?.base), 'b\n');
  assert.deepEqual(stagingLeft(env.root), []);
});

test('the folder a parent Claude Code session was started in does not become the session folder', async (t) => {
  const env = await start(t, { claudeProjectDir: tempDir(t) });
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'write', input: { path: file, content: 'two\n' }, run: () => writeFileSync(file, 'two\n') });

  assert.deepEqual(entryOf(env, file)?.sessionDirs, [env.work]);
});

test('bash, read, scratch urls and unusable input are ignored, and a handler error does not reject', async (t) => {
  const env = await start(t);
  const file = join(env.work, 'a.txt');
  writeFileSync(file, 'one\n');

  await call(env, { tool: 'bash', input: { command: 'echo hi > x' } });
  await call(env, { tool: 'read', input: { path: file } });
  await call(env, { tool: 'ast_edit', input: { paths: ['src/**/*.ts'] } });
  await call(env, { tool: 'edit', input: { path: 'local://PLAN.md', old_string: 'a', new_string: 'b' } });
  await call(env, { tool: 'write', input: { path: 'conflict://1', content: 'x' } });
  await call(env, { tool: 'edit', input: { path: 42 } });
  await call(env, { tool: 'write', input: { path: '' } });
  await env.handlers.get('tool_call')?.({ toolName: 'edit', toolCallId: '', input: { path: file } }, env.ctx);
  await env.handlers.get('tool_result')?.({ toolName: 'edit', toolCallId: 'never-staged', input: { path: file } }, env.ctx);
  // A broken context must not reject: OMP blocks the edit when tool_call throws.
  await env.handlers.get('tool_call')?.({ toolName: 'write', toolCallId: 'call_throw', input: { path: file, content: 'two\n' } }, null);

  assert.deepEqual(env.store.listEntries(), []);
  assert.deepEqual(stagingLeft(env.root), []);
  assert.match(readFileSync(join(env.root, 'errors.log'), 'utf8'), /omp tool_call/);
});

test('session_start sweeps staging left behind, and says so when Node cannot be started, without rejecting', async (t) => {
  const env = await start(t, {
    seed: (root) => {
      const leftover = join(root, 'staging', 'interrupted');
      mkdirSync(leftover, { recursive: true });
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(leftover, twoDaysAgo, twoDaysAgo);
    },
  });

  await env.handlers.get('session_start')?.({}, env.ctx);
  assert.deepEqual(stagingLeft(env.root), []);
  assert.deepEqual(env.notices, []);

  setEnv(t, 'CLAUSE_NODE', join(tempDir(t), 'no-such-node'));
  await env.handlers.get('session_start')?.({}, env.ctx);
  assert.equal(env.notices.length, 1);
  assert.match(env.notices[0].message, /CLAUSE_NODE/);
  assert.equal(env.notices[0].type, 'error');
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

test('a discard reaches the next prompt once, and a revived agent does not consume it', async (t) => {
  const env = await start(t);
  const prompt = (reason = 'prompt') => env.handlers.get('before_agent_start')?.({ reason, prompt: 'hi' }, env.ctx);

  assert.equal(await prompt(), undefined);

  env.store.appendDiscard({ path: join(env.work, 'a.txt'), scope: 'file' });
  env.store.appendDiscard({ path: join(tempDir(t), 'elsewhere.txt'), scope: 'file' });
  assert.equal(await prompt('revive'), undefined);

  const note = await prompt();
  assert.match(note.message.content, /a\.txt: discarded all pending changes in this file/);
  assert.doesNotMatch(note.message.content, /elsewhere\.txt/);
  assert.equal(note.message.display, false);
  assert.equal(note.message.customType, 'clause-discard');

  assert.equal(await prompt(), undefined);
});

test('hashlinePaths and patchPaths list the files a body names', () => {
  assert.deepEqual(hashlinePaths('[src/a.ts#1a2b]\nPUT 1:\n+x\n[b.ts]\nMV next.ts\n+[not a header]\n'), ['src/a.ts', 'b.ts', 'next.ts']);
  assert.deepEqual(hashlinePaths('[a b.ts#1A2B]\r\nPUT 1:\r\n'), ['a b.ts']);
  assert.deepEqual(hashlinePaths('PUT 1:\n+x'), []);

  const body = ['*** Begin Patch', '*** Add File: "quoted name.txt"', "*** Update File: 'single.txt'", '*** Move to: moved.txt', '*** Delete File: gone.txt', '*** End Patch'];
  assert.deepEqual(patchPaths(body.join('\n')), ['quoted name.txt', 'single.txt', 'moved.txt', 'gone.txt']);
  assert.deepEqual(patchPaths(body.join('\r\n')), ['quoted name.txt', 'single.txt', 'moved.txt', 'gone.txt']);
  assert.deepEqual(patchPaths('*** Add File: '), []);
});

test('hashlinePaths cleans a path the way OMP does before it edits the file', () => {
  const body = ['[app/[slug]/page.tsx#1A2B]', 'MV "e f.tsx"', '[*** Begin Patch] [g.ts#1A2B]', '[*** Update File: h.ts#1a2b ]', '[*** End Patch]'];
  assert.deepEqual(hashlinePaths(body.join('\n')), ['app/[slug]/page.tsx', 'e f.tsx', 'g.ts', 'h.ts']);
});

test('sloppyPaths lists the files a sloppy body names', () => {
  const body = [
    '*** Begin Patch',
    '*** Edit File: src/a.ts',
    '*** Find',
    'old',
    '*** Replace',
    'new',
    '*** Edit File:',
    '*** Find',
    'more',
    '*** Replace',
    'less',
    '*** edit file: b.ts all',
    '*** Find',
    'x',
    '*** Insert After',
    'y',
    '*** Edit File: " all " all',
    '*** Find',
    'p',
    '*** Replace',
    'q',
    '*** Edit File c.ts',
    '*** Find',
    'r',
    '*** Replace',
    's',
    '*** End Patch',
  ];
  assert.deepEqual(sloppyPaths(body.join('\n')), ['src/a.ts', 'b.ts', ' all ', 'c.ts']);
  assert.deepEqual(sloppyPaths(body.join('\r\n')), ['src/a.ts', 'b.ts', ' all ', 'c.ts']);
  assert.deepEqual(sloppyPaths('*** Edit File: all\n*** Edit File: "unclosed\n*** Edit Files: d.ts\n[e.ts]'), []);
});

test('editedPaths reads a body with the parser for its own format', () => {
  // A hunk's context line and a raw sloppy line look like hashline `[path]` headers. For the sloppy
  // body, OMP's own scan for those headers also puts the line in `path`.
  const patch = ['*** Begin Patch', '*** Update File: Cargo.toml', '@@', ' [dependencies]', '-a = "1"', '+a = "2"', '*** End Patch'];
  assert.deepEqual(editedPaths('edit', { input: patch.join('\n') }, '/work'), ['/work/Cargo.toml']);

  const sloppy = ['*** Edit File: setup.cfg', '*** Find', '[metadata]', '*** Insert After', 'name = x'];
  assert.deepEqual(editedPaths('edit', { input: sloppy.join('\n'), path: 'metadata', paths: ['metadata'] }, '/work'), ['/work/setup.cfg']);

  const hashline = ['*** Begin Patch', '[src/a.ts#1A2B]', 'PUT 1:', '+[x]', '*** End Patch'];
  assert.deepEqual(editedPaths('edit', { input: hashline.join('\n'), path: 'src/a.ts', paths: ['src/a.ts'] }, '/work'), ['/work/src/a.ts']);

  // OMP edits the file without the quotes. Its `path` hint for the same header is not read for a body.
  assert.deepEqual(editedPaths('edit', { input: '["a b.ts"#1A2B]\nPUT 1:\n+x\nMV \'c d.ts\'\n', path: 'a b.ts' }, '/work'), ['/work/a b.ts', '/work/c d.ts']);
});

test('resolveTarget resolves a tool path against the session folder', () => {
  assert.equal(resolveTarget('/work', 'a/b.txt', '/home/u'), '/work/a/b.txt');
  assert.equal(resolveTarget('/work', '/abs/c.txt', '/home/u'), '/abs/c.txt');
  assert.equal(resolveTarget('/work', '~', '/home/u'), '/home/u');
  assert.equal(resolveTarget('/work', '~/d.txt', '/home/u'), '/home/u/d.txt');
  // OMP reads `~name` as a folder in the home folder, not as another user's home.
  assert.equal(resolveTarget('/work', '~other/e.txt', '/home/u'), '/home/u/other/e.txt');
});

test('resolveTarget reads a path the way OMP does before it changes the file', () => {
  // A `read` header pasted as the path, and the stray marks models put in front of a path.
  assert.equal(resolveTarget('/work', '[a/b.txt#1A2B]', '/home/u'), '/work/a/b.txt');
  assert.equal(resolveTarget('/work', '[a#b.txt]', '/home/u'), '/work/[a#b.txt]');
  assert.equal(resolveTarget('/work', ':/abs/c.txt', '/home/u'), '/abs/c.txt');
  assert.equal(resolveTarget('/work', ':./c.txt', '/home/u'), '/work/c.txt');
  assert.equal(resolveTarget('/work', '@/abs/c.txt', '/home/u'), '/abs/c.txt');
  assert.equal(resolveTarget('/work', '@~/d.txt', '/home/u'), '/home/u/d.txt');
  assert.equal(resolveTarget('/work', '@f.txt', '/home/u'), '/work/@f.txt');
  assert.equal(resolveTarget('/work', 'file:///abs/a%20b.txt', '/home/u'), '/abs/a b.txt');
  assert.equal(resolveTarget('/work', 'a\u00a0b.txt', '/home/u'), '/work/a b.txt');
  assert.equal(resolveTarget('/work', '[local://PLAN.md#ABCD]', '/home/u'), undefined);
});

test('editedPaths ignores tools and urls that are not workspace files', () => {
  assert.deepEqual(editedPaths('bash', { command: 'rm x' }, '/work'), []);
  assert.deepEqual(editedPaths('edit', { input: '[local://PLAN.md#ABCD]\n[real.ts#ABCD]\n' }, '/work'), ['/work/real.ts']);
  assert.deepEqual(editedPaths('edit', { path: 'conflict://1' }, '/work'), []);
  assert.deepEqual(editedPaths('edit', { path: 'file:///abs/a.ts', old_string: 'a', new_string: 'b' }, '/work'), ['/abs/a.ts']);
  assert.deepEqual(editedPaths('read', { path: 'a.txt' }, '/work'), []);
});
