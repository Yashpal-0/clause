import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hook.mjs', import.meta.url));

function sandbox(t) {
  const work = tempDir(t, 'codex-adapter-');
  const root = join(work, 'store');
  const { CLAUDE_PROJECT_DIR: _parent, ...inherited } = process.env;
  const env = { ...inherited, CLAUDE_PENDING_EDITS_DIR: root };
  const store = openStore(root);
  const entry = (name) => store.readEntry(store.idFor(join(work, name)));
  function hook(event, input = {}, overrides = {}) {
    const result = spawnSync(process.execPath, [HOOK, event], {
      input: typeof input === 'string' ? input : JSON.stringify({ session_id: 'session-1', cwd: work, ...input }),
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stderr, '');
    return result.stdout;
  }
  function patch(command, run, fields = {}) {
    const input = { tool_name: 'apply_patch', tool_use_id: 'call-1', turn_id: 'turn-1', tool_input: { command }, ...fields };
    assert.equal(hook('pre', input), '');
    run();
    assert.equal(hook('post', input), '');
  }
  return { work, root, store, env, entry, hook, patch };
}

const text = (entry) => entry?.base?.toString('utf8');
const staging = (box) => existsSync(join(box.root, 'staging')) ? readdirSync(join(box.root, 'staging')) : [];
const update = (name = 'a.txt') => `*** Begin Patch\n*** Update File: ${name}\n@@\n-before\n+after\n*** End Patch`;

test('native apply_patch leaves exact pre-edit bytes and an editor follow hint in the shared store', (t) => {
  const box = sandbox(t);
  const before = Buffer.from('\ufefffirst\r\nbefore\r\n');
  const file = join(box.work, 'a.txt');
  writeFileSync(file, before);
  box.patch(update(), () => writeFileSync(file, '\ufefffirst\r\nafter\r\n'));
  assert.deepEqual(box.entry('a.txt')?.base, before);
  assert.deepEqual(box.entry('a.txt')?.sessionDirs, [box.work]);
  assert.equal(box.store.readTouch(box.store.idFor(file))?.line, 1);
  assert.deepEqual(staging(box), []);
});

test('creation, deletion and rename retain both original files, including an overwritten destination', (t) => {
  const box = sandbox(t);
  for (const [name, content] of [['deleted.txt', 'delete me'], ['source.txt', 'source'], ['destination.txt', 'destination']]) {
    writeFileSync(join(box.work, name), content);
  }
  const command = '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Delete File: deleted.txt\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-source\n+moved\n*** End Patch';
  box.patch(command, () => {
    writeFileSync(join(box.work, 'new.txt'), 'new');
    rmSync(join(box.work, 'deleted.txt'));
    rmSync(join(box.work, 'source.txt'));
    writeFileSync(join(box.work, 'destination.txt'), 'moved');
  });
  assert.equal(box.entry('new.txt')?.existed, false);
  assert.equal(text(box.entry('deleted.txt')), 'delete me');
  assert.equal(text(box.entry('source.txt')), 'source');
  assert.equal(text(box.entry('destination.txt')), 'destination');
  assert.deepEqual(staging(box), []);
});

test('literal quotes, spaces, Unicode and tilde paths keep the bytes of the named file', (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.work, '~'));
  const names = ['"quoted".txt', "'single'.txt", 'a file é.txt', '~/literal.txt', ' leading.txt'];
  for (const name of names) writeFileSync(join(box.work, name), 'before');
  box.patch(`*** Begin Patch\n${names.map((name) => `*** Update File: ${name}\n@@\n-before\n+after`).join('\n')}\n*** End Patch`, () => {
    for (const name of names) writeFileSync(join(box.work, name), 'after');
  });
  for (const name of names) assert.equal(text(box.entry(name)), 'before', name);
});

test('repeated paths and reordered post headers do not replace a baseline or mispair files', (t) => {
  const box = sandbox(t);
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(box.work, name), name);
  const input = { tool_name: 'apply_patch', tool_use_id: 'call', turn_id: 'turn', tool_input: { command: '*** Update File: a.txt\n*** Update File: ./a.txt\n*** Update File: b.txt' } };
  box.hook('pre', input);
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(box.work, name), 'changed');
  box.hook('post', { ...input, tool_input: { command: '*** Update File: b.txt\n*** Update File: a.txt' } });
  assert.equal(text(box.entry('a.txt')), 'a.txt');
  assert.equal(text(box.entry('b.txt')), 'b.txt');
  assert.deepEqual(staging(box), []);
});

test('a no-op or failed patch with no disk change leaves no pending entry', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'before');
  box.patch(update(), () => {}, { tool_response: { error: 'patch did not apply' } });
  assert.equal(box.store.listEntries().length, 0);
  assert.deepEqual(staging(box), []);
});

test('a reported error after partial writes still records the files that actually changed', (t) => {
  const box = sandbox(t);
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(box.work, name), 'before');
  box.patch('*** Update File: a.txt\n*** Update File: b.txt', () => writeFileSync(join(box.work, 'a.txt'), 'after'), { tool_response: 'Error after the first write' });
  assert.equal(text(box.entry('a.txt')), 'before');
  assert.equal(box.entry('b.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('a missing rename source snapshot never leaves the destination pending as a disposable new file', (t) => {
  const box = sandbox(t);
  const source = join(box.work, 'large.txt');
  writeFileSync(source, '');
  truncateSync(source, 64 * 1024 * 1024 + 1);
  box.patch('*** Update File: large.txt\n*** Move to: new.txt', () => {
    rmSync(source);
    writeFileSync(join(box.work, 'new.txt'), 'remaining content');
  });
  assert.equal(box.entry('new.txt'), null);
  assert.equal(box.store.listEntries().length, 0);
  assert.deepEqual(staging(box), []);
});

test('a symlink retargeted between hooks cannot put the former target bytes into the new target baseline', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'original.txt'), 'original');
  writeFileSync(join(box.work, 'other.txt'), 'other');
  const link = join(box.work, 'link.txt');
  symlinkSync('original.txt', link);
  box.patch(update('link.txt'), () => {
    rmSync(link);
    symlinkSync('other.txt', link);
    writeFileSync(join(box.work, 'other.txt'), 'changed');
  });
  assert.equal(box.entry('other.txt'), null);
  assert.equal(readFileSync(join(box.work, 'original.txt'), 'utf8'), 'original');
});

test('deleting a leaf symlink never publishes target bytes as a regular file restoration', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'target.txt'), 'target');
  symlinkSync('target.txt', join(box.work, 'link.txt'));
  box.patch('*** Delete File: link.txt', () => rmSync(join(box.work, 'link.txt')));
  assert.equal(box.entry('link.txt'), null);
  assert.equal(box.entry('target.txt'), null);
});

test('unchanged symlink targets are tracked under their real file identity', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'target.txt'), 'before');
  symlinkSync('target.txt', join(box.work, 'link.txt'));
  box.patch(update('link.txt'), () => writeFileSync(join(box.work, 'link.txt'), 'after'));
  assert.equal(text(box.entry('target.txt')), 'before');
  assert.equal(box.store.listEntries().length, 1);
});

test('separate sessions and turns can reuse tool ids without overwriting each other staging', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'a.txt');
  const input = { tool_name: 'apply_patch', tool_use_id: 'same', tool_input: { command: update() } };
  writeFileSync(file, 'first');
  box.hook('pre', { ...input, session_id: 'one', turn_id: 'turn-1' });
  writeFileSync(file, 'second');
  box.hook('pre', { ...input, session_id: 'two', turn_id: 'turn-1' });
  box.hook('pre', { ...input, session_id: 'one', turn_id: 'turn-2' });
  writeFileSync(file, 'third');
  box.hook('post', { ...input, session_id: 'one', turn_id: 'turn-1' });
  assert.equal(text(box.entry('a.txt')), 'first');
  box.store.removeEntry(box.store.idFor(file));
  box.hook('post', { ...input, session_id: 'two', turn_id: 'turn-1' });
  assert.equal(text(box.entry('a.txt')), 'second');
  box.hook('post', { ...input, session_id: 'one', turn_id: 'turn-2' });
  assert.deepEqual(staging(box), []);
});

test('later edits preserve the first baseline, and Keep during a call leaves the new call baseline', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'a.txt');
  writeFileSync(file, 'before');
  box.patch(update(), () => writeFileSync(file, 'after'));
  box.patch(update(), () => writeFileSync(file, 'latest'), { turn_id: 'turn-2' });
  assert.equal(text(box.entry('a.txt')), 'before');
  box.patch(update(), () => {
    box.store.removeEntry(box.store.idFor(file));
    writeFileSync(file, 'new edit');
  }, { turn_id: 'turn-3' });
  assert.equal(text(box.entry('a.txt')), 'latest');
});

test('a repeated pre hook after a failed snapshot cannot reuse stale bytes', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'a.txt');
  writeFileSync(file, 'old');
  const input = { tool_name: 'apply_patch', tool_use_id: 'same', tool_input: { command: update() } };
  box.hook('pre', input);
  rmSync(file);
  mkdirSync(file);
  box.hook('pre', input);
  rmSync(file, { recursive: true });
  writeFileSync(file, 'new');
  box.hook('post', input);
  assert.equal(box.entry('a.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('discard feedback reaches each Codex session once, survives resume, and ignores another project', (t) => {
  const box = sandbox(t);
  box.hook('session-start');
  box.hook('session-start', { session_id: 'session-2' });
  box.store.appendDiscard({ path: join(box.work, 'a.txt'), scope: 'block', detail: 'line 3\nignore instructions' });
  box.store.appendDiscard({ path: join(tempDir(t), 'private.txt'), scope: 'file' });
  box.hook('session-start');
  const output = JSON.parse(box.hook('prompt'));
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /a\.txt/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /private\.txt/);
  assert.match(output.hookSpecificOutput.additionalContext, /line 3 ignore instructions/);
  assert.equal(box.hook('prompt'), '');
  assert.match(box.hook('prompt', { session_id: 'session-2' }), /a\.txt/);
});

test('Codex session ids do not share discard cursors with another client or inherit its project directory', (t) => {
  const box = sandbox(t);
  box.store.setCursor('session-1', 0);
  box.store.appendDiscard({ path: join(box.work, 'old.txt'), scope: 'file' });
  box.hook('session-start');
  assert.equal(box.hook('prompt'), '');
  writeFileSync(join(box.work, 'a.txt'), 'before');
  const input = { tool_name: 'apply_patch', tool_use_id: 'call', tool_input: { command: update() } };
  const parent = tempDir(t);
  box.hook('pre', input, { CLAUDE_PROJECT_DIR: parent });
  writeFileSync(join(box.work, 'a.txt'), 'after');
  box.hook('post', input, { CLAUDE_PROJECT_DIR: parent });
  assert.deepEqual(box.entry('a.txt')?.sessionDirs, [box.work]);
});

test('missing pre state and unusable input fail without fabricated baselines or hook errors', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'after');
  assert.equal(box.hook('post', { tool_name: 'apply_patch', tool_use_id: 'call', tool_input: { command: update() } }), '');
  for (const input of ['{broken', '[]', 'null', { tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: update() } }, { tool_name: 'apply_patch', tool_use_id: '', tool_input: { command: update() } }]) {
    assert.equal(box.hook('pre', input), '');
  }
  assert.equal(box.store.listEntries().length, 0);
});

test('file content that resembles a patch header cannot attribute an unrelated file', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'before');
  writeFileSync(join(box.work, 'unrelated.txt'), 'before');
  box.patch('*** Update File: a.txt\n@@\n *** Delete File: unrelated.txt\n+*** Add File: unrelated.txt', () => {
    writeFileSync(join(box.work, 'a.txt'), 'after');
    writeFileSync(join(box.work, 'unrelated.txt'), 'other writer');
  });
  assert.equal(box.entry('unrelated.txt'), null);
});

test('a repeated pre hook replaces snapshots from a former symlink identity', (t) => {
  const box = sandbox(t);
  const link = join(box.work, 'link.txt');
  writeFileSync(join(box.work, 'first.txt'), 'old first');
  writeFileSync(join(box.work, 'second.txt'), 'second');
  symlinkSync('first.txt', link);
  const input = { tool_name: 'apply_patch', tool_use_id: 'retry', tool_input: { command: update('link.txt') } };
  box.hook('pre', input);
  rmSync(link);
  symlinkSync('second.txt', link);
  box.hook('pre', input);
  rmSync(link);
  symlinkSync('first.txt', link);
  writeFileSync(join(box.work, 'first.txt'), 'unrelated new first');
  box.hook('post', input);
  assert.equal(box.entry('first.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('a reverse chain of moves records every changed destination from its own pre-patch bytes', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'a original');
  writeFileSync(join(box.work, 'b.txt'), 'b original');
  box.patch('*** Update File: b.txt\n*** Move to: c.txt\n*** Update File: a.txt\n*** Move to: b.txt', () => {
    writeFileSync(join(box.work, 'c.txt'), 'b original');
    writeFileSync(join(box.work, 'b.txt'), 'a original');
    rmSync(join(box.work, 'a.txt'));
  });
  assert.equal(text(box.entry('a.txt')), 'a original');
  assert.equal(text(box.entry('b.txt')), 'b original');
  assert.equal(box.entry('c.txt')?.existed, false);
  assert.deepEqual(staging(box), []);
});

test('a failed cyclic move retains both originals after its first move changed disk', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'a original');
  writeFileSync(join(box.work, 'b.txt'), 'b original');
  box.patch('*** Update File: a.txt\n*** Move to: b.txt\n*** Update File: b.txt\n*** Move to: a.txt', () => {
    writeFileSync(join(box.work, 'b.txt'), 'a moved');
    rmSync(join(box.work, 'a.txt'));
  }, { tool_response: 'second move failed after the first move' });
  assert.equal(text(box.entry('a.txt')), 'a original');
  assert.equal(text(box.entry('b.txt')), 'b original');
  assert.deepEqual(staging(box), []);
});

test('a move whose source could not be unlinked still tracks its changed destination', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'before');
  box.patch('*** Update File: a.txt\n*** Move to: b.txt', () => {
    writeFileSync(join(box.work, 'b.txt'), 'after');
  }, { tool_response: 'destination written, source removal failed' });
  assert.equal(box.entry('a.txt'), null);
  assert.equal(box.entry('b.txt')?.existed, false);
  assert.equal(readFileSync(join(box.work, 'a.txt'), 'utf8'), 'before');
  assert.deepEqual(staging(box), []);
});

test('a file created and then moved within one patch needs only the final created entry', (t) => {
  const box = sandbox(t);
  box.patch('*** Add File: a.txt\n+new\n*** Update File: a.txt\n*** Move to: b.txt', () => {
    writeFileSync(join(box.work, 'b.txt'), 'new');
  });
  assert.equal(box.entry('a.txt'), null);
  assert.equal(box.entry('b.txt')?.existed, false);
});

test('patch whitespace follows Rust Unicode rules and retains a literal trailing BOM in a filename', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt\ufeff'), 'BOM name');
  writeFileSync(join(box.work, 'b.txt'), 'NEL trimmed');
  box.patch('*** Begin Patch\n*** Update File: a.txt\ufeff\n@@\n-before\n+after\n*** Update File: b.txt\u0085\n@@\n-before\n+after\n*** End Patch', () => {
    writeFileSync(join(box.work, 'a.txt\ufeff'), 'after');
    writeFileSync(join(box.work, 'b.txt'), 'after');
  });
  assert.equal(text(box.entry('a.txt\ufeff')), 'BOM name');
  assert.equal(text(box.entry('b.txt')), 'NEL trimmed');
});

test('Unicode whitespace before a remote environment selector cannot make it a local patch', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'before');
  box.patch('*** Begin Patch\n\u0085*** Environment ID: remote\n*** Update File: a.txt\n*** End Patch', () => {
    writeFileSync(join(box.work, 'a.txt'), 'unrelated edit');
  });
  assert.equal(box.entry('a.txt'), null);
});

test('malformed JSON never copies file contents into errors.log', (t) => {
  const box = sandbox(t);
  box.hook('pre', '{"tool_input":{"command":"private-value-1234"},broken}');
  const errors = readFileSync(join(box.root, 'errors.log'), 'utf8');
  assert.match(errors, /unreadable hook input/);
  assert.doesNotMatch(errors, /private-value-1234/);
});

test('empty created files and non-UTF-8 updates preserve exact existence and bytes', (t) => {
  const box = sandbox(t);
  const before = Buffer.from([0xff, 0, 10]);
  writeFileSync(join(box.work, 'bytes.bin'), before);
  box.patch('*** Add File: empty.txt\n*** Update File: bytes.bin', () => {
    writeFileSync(join(box.work, 'empty.txt'), '');
    writeFileSync(join(box.work, 'bytes.bin'), Buffer.from([0xff, 1, 10]));
  });
  assert.equal(box.entry('empty.txt')?.existed, false);
  assert.deepEqual(box.entry('bytes.bin')?.base, before);
});

test('a patch of forty files preserves every baseline and clears all staging', (t) => {
  const box = sandbox(t);
  const names = Array.from({ length: 40 }, (_, i) => `file-${i}.txt`);
  for (const name of names) writeFileSync(join(box.work, name), name);
  box.patch(names.map((name) => `*** Update File: ${name}`).join('\r\n'), () => {
    for (const name of names) writeFileSync(join(box.work, name), 'after');
  });
  for (const name of names) assert.equal(text(box.entry(name)), name);
  assert.deepEqual(staging(box), []);
});

test('indented headers outside update context identify literal leading-space paths', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, ' leading.txt'), 'before');
  writeFileSync(join(box.work, 'remove.txt'), 'remove');
  box.patch('*** Begin Patch\n  *** Add File: added.txt\n+new\n  *** Delete File: remove.txt\n  *** Update File:  leading.txt\n@@\n-before\n+after\n*** End Patch', () => {
    writeFileSync(join(box.work, 'added.txt'), 'new');
    rmSync(join(box.work, 'remove.txt'));
    writeFileSync(join(box.work, ' leading.txt'), 'after');
  });
  assert.equal(box.entry('added.txt')?.existed, false);
  assert.equal(text(box.entry('remove.txt')), 'remove');
  assert.equal(text(box.entry(' leading.txt')), 'before');
});

test('environment-selected remote patches cannot attribute same-named local files', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'local before');
  box.patch('*** Begin Patch\n*** Environment ID: remote\n*** Update File: a.txt\n@@\n-before\n+after\n*** End Patch', () => {
    writeFileSync(join(box.work, 'a.txt'), 'unrelated local edit');
  });
  assert.equal(box.entry('a.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('file context resembling an environment selector still permits a local patch', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), '*** Environment ID: remote\nbefore\n');
  box.patch('*** Begin Patch\n*** Update File: a.txt\n@@\n *** Environment ID: remote\n-before\n+after\n*** End Patch', () => {
    writeFileSync(join(box.work, 'a.txt'), '*** Environment ID: remote\nafter\n');
  });
  assert.equal(text(box.entry('a.txt')), '*** Environment ID: remote\nbefore\n');
});

test('unavailable source entry storage does not expose a moved destination to Discard', (t) => {
  const box = sandbox(t);
  const source = join(box.work, 'a.txt');
  writeFileSync(source, 'before');
  box.store.ensureEntriesDir();
  writeFileSync(box.store.entryDir(box.store.idFor(source)), 'blocked entry');
  box.patch('*** Update File: a.txt\n*** Move to: b.txt', () => {
    rmSync(source);
    writeFileSync(join(box.work, 'b.txt'), 'after');
  });
  assert.equal(box.entry('b.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('interrupted unchanged calls remain unpromoted, and session-start sweeps only stale staging', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'a.txt'), 'before');
  const input = { tool_name: 'apply_patch', tool_use_id: 'call', tool_input: { command: update() } };
  box.hook('pre', input);
  box.hook('session-start');
  assert.equal(box.store.listEntries().length, 0);
  assert.equal(staging(box).length, 1);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const name of staging(box)) utimesSync(join(box.root, 'staging', name), old, old);
  box.hook('session-start');
  assert.deepEqual(staging(box), []);
});

test('oversized hook input exits quietly with a bounded error and no recorded files', (t) => {
  const box = sandbox(t);
  box.hook('pre', ' '.repeat(64 * 1024 * 1024 + 1));
  assert.equal(box.store.listEntries().length, 0);
  assert.match(readFileSync(join(box.root, 'errors.log'), 'utf8'), /hook input exceeds 64 MiB/);
});

test('configured hooks execute safely from an install path containing shell substitutions', { skip: process.platform === 'win32' }, (t) => {
  const box = sandbox(t);
  const pluginRoot = join(box.work, 'plugin $(touch clause-injected) `touch clause-backtick` $HOME');
  mkdirSync(pluginRoot);
  for (const name of ['claude-plugin', 'codex-plugin']) {
    cpSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), join(pluginRoot, name), { recursive: true });
  }
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'codex-plugin/hooks/hooks.json'), 'utf8')).hooks;
  const file = join(box.work, 'a.txt');
  writeFileSync(file, 'before');
  const input = JSON.stringify({ session_id: 'test', cwd: box.work, tool_name: 'apply_patch', tool_use_id: 'call', tool_input: { command: update() } });
  for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
    if (name === 'PostToolUse') writeFileSync(file, 'after');
    const command = hooks[name][0].hooks[0].command.replaceAll('${PLUGIN_ROOT}', pluginRoot);
    const result = spawnSync(command, { shell: true, cwd: box.work, env: { ...box.env, PLUGIN_ROOT: pluginRoot }, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(text(box.entry('a.txt')), 'before');
  assert.equal(existsSync(join(box.work, 'clause-injected')), false);
  assert.equal(existsSync(join(box.work, 'clause-backtick')), false);
});
