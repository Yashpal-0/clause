import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';
import { cleanPath, extractTarget, getSessionId, getWorkspaceDir, isFailedToolCall } from '../hook.mjs';

const HOOK = fileURLToPath(new URL('../hook.mjs', import.meta.url));

function sandbox(t) {
  const work = tempDir(t, 'agy-adapter-');
  const root = join(work, 'store');
  const { CLAUDE_PROJECT_DIR: _parent, ...inherited } = process.env;
  const env = { ...inherited, CLAUDE_PENDING_EDITS_DIR: root };
  const store = openStore(root);
  const entry = (name) => store.readEntry(store.idFor(join(work, name)));

  function hook(event, input = {}) {
    const defaultPayload = {
      conversationId: 'test-conv-1',
      workspacePaths: [work],
      stepIdx: 1,
    };
    const payload = typeof input === 'string' ? input : JSON.stringify({ ...defaultPayload, ...input });
    const result = spawnSync(process.execPath, [HOOK, event], {
      input: payload,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout;
  }

  function toolCycle(toolName, args, run, extra = {}) {
    const input = {
      toolCall: { name: toolName, args },
      ...extra,
    };
    const preOut = hook('pre', input);
    assert.deepEqual(JSON.parse(preOut || '{}'), { decision: 'allow' });
    if (run) run();
    const postOut = hook('post', input);
    assert.deepEqual(JSON.parse(postOut || '{}'), {});
  }

  return { work, root, store, env, entry, hook, toolCycle };
}

const staging = (box) => existsSync(join(box.root, 'staging')) ? readdirSync(join(box.root, 'staging')) : [];
const text = (entry) => entry?.base?.toString('utf8');

test('cleanPath strips whitespace and quotes', () => {
  assert.equal(cleanPath('  hello.txt  '), 'hello.txt');
  assert.equal(cleanPath('"quoted.txt"'), 'quoted.txt');
  assert.equal(cleanPath("'single.txt'"), 'single.txt');
  assert.equal(cleanPath('   '), null);
  assert.equal(cleanPath(null), null);
  assert.equal(cleanPath(undefined), null);
  assert.equal(cleanPath(123), null);
});

test('getSessionId prefixes conversationId or falls back', () => {
  assert.equal(getSessionId({ conversationId: 'abc-123' }), 'agy-abc-123');
  assert.equal(getSessionId({ conversationId: '' }), 'agy-default');
  assert.equal(getSessionId({}), 'agy-default');
});

test('getWorkspaceDir retrieves first workspace path or cwd', () => {
  assert.equal(getWorkspaceDir({ workspacePaths: ['/tmp/project'] }), '/tmp/project');
  assert.equal(getWorkspaceDir({ cwd: '/tmp/cwd' }), '/tmp/cwd');
});

test('extractTarget extracts path and key from tracked tools', () => {
  const ws = '/tmp/project';
  const targetWrite = extractTarget({
    conversationId: 'c1',
    stepIdx: 5,
    toolCall: { name: 'write_file', args: { Path: 'src/main.js' } },
  }, ws);
  assert.equal(targetWrite?.path, join(ws, 'src/main.js'));
  assert.match(targetWrite?.key ?? '', /^agy-[0-9a-f]{32}$/);

  const targetNamespaced = extractTarget({
    conversationId: 'c1',
    stepIdx: 5,
    toolCall: { name: 'default_api:edit_file', args: { path: '/tmp/other.txt' } },
  }, ws);
  assert.equal(targetNamespaced?.path, '/tmp/other.txt');

  const untracked = extractTarget({
    toolCall: { name: 'read_file', args: { Path: 'test.txt' } },
  }, ws);
  assert.equal(untracked, null);
});

test('write_file creating a new file leaves entry with existed: false', (t) => {
  const box = sandbox(t);
  const target = join(box.work, 'created.txt');

  box.toolCycle('write_file', { Path: 'created.txt' }, () => {
    writeFileSync(target, 'hello from agy\n');
  });

  const entry = box.entry('created.txt');
  assert.equal(entry?.existed, false);
  assert.equal(entry?.base, null);
  assert.deepEqual(entry?.sessionDirs, [box.work]);
  assert.deepEqual(staging(box), []);
});

test('write_file updating an existing file records exact baseline', (t) => {
  const box = sandbox(t);
  const target = join(box.work, 'file.txt');
  const initial = 'line 1\nline 2\nline 3\n';
  writeFileSync(target, initial);

  box.toolCycle('write_file', { Path: 'file.txt' }, () => {
    writeFileSync(target, 'line 1\nmodified line 2\nline 3\n');
  });

  const entry = box.entry('file.txt');
  assert.equal(entry?.existed, true);
  assert.equal(text(entry), initial);
  assert.deepEqual(entry?.sessionDirs, [box.work]);

  const touch = box.store.readTouch(box.store.idFor(target));
  assert.equal(touch?.line, 1);
  assert.deepEqual(staging(box), []);
});

test('edit_file modifying a file records exact baseline and touched line', (t) => {
  const box = sandbox(t);
  const target = join(box.work, 'app.py');
  const initial = 'def test():\n    return False\n';
  writeFileSync(target, initial);

  box.toolCycle('edit_file', { Path: target, Target: 'False', Replacement: 'True' }, () => {
    writeFileSync(target, 'def test():\n    return True\n');
  });

  const entry = box.entry('app.py');
  assert.equal(entry?.existed, true);
  assert.equal(text(entry), initial);
  const touch = box.store.readTouch(box.store.idFor(target));
  assert.equal(touch?.line, 1);
  assert.deepEqual(staging(box), []);
});

test('tool call failure drops staging without creating an entry', (t) => {
  const box = sandbox(t);
  const target = join(box.work, 'failed.txt');
  writeFileSync(target, 'original\n');

  const input = {
    toolCall: { name: 'edit_file', args: { Path: 'failed.txt' } },
  };

  const preOut = box.hook('pre', input);
  assert.deepEqual(JSON.parse(preOut), { decision: 'allow' });
  assert.equal(staging(box).length, 1);

  const postOut = box.hook('post', { ...input, error: 'Target string not found' });
  assert.deepEqual(JSON.parse(postOut), {});

  assert.equal(box.entry('failed.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('no-op edit leaves no pending entry', (t) => {
  const box = sandbox(t);
  const target = join(box.work, 'noop.txt');
  writeFileSync(target, 'same\n');

  box.toolCycle('write_file', { Path: 'noop.txt' }, () => {
    // Left completely unchanged
  });

  assert.equal(box.entry('noop.txt'), null);
  assert.deepEqual(staging(box), []);
});

test('untracked tools are allowed and ignored', (t) => {
  const box = sandbox(t);
  box.toolCycle('read_file', { Path: 'anything.txt' });
  box.toolCycle('run_command', { CommandLine: 'npm test' });
  assert.deepEqual(staging(box), []);
  assert.equal(box.store.listEntries().length, 0);
});

test('prompt injects ephemeralMessage when pending changes are discarded', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'discarded.txt');
  writeFileSync(file, 'original');

  box.toolCycle('write_file', { Path: 'discarded.txt' }, () => {
    writeFileSync(file, 'changed');
  });
  assert.notEqual(box.entry('discarded.txt'), null);

  // Initialize cursor on prompt
  const initPrompt = box.hook('prompt');
  assert.deepEqual(JSON.parse(initPrompt), {});

  // Simulate user discarding file in VS Code
  box.store.appendDiscard({
    path: file,
    scope: 'file',
    detail: 'discarded all',
  });

  const promptWithDiscard = box.hook('prompt');
  const parsed = JSON.parse(promptWithDiscard);
  assert.ok(Array.isArray(parsed?.injectSteps));
  assert.equal(parsed.injectSteps.length, 1);
  assert.match(parsed.injectSteps[0].ephemeralMessage, /The user reviewed pending changes/);
  assert.match(parsed.injectSteps[0].ephemeralMessage, /discarded\.txt/);

  // Next prompt should be caught up
  const followUp = box.hook('prompt');
  assert.deepEqual(JSON.parse(followUp), {});
});

test('discards outside workspace are not announced', (t) => {
  const box = sandbox(t);
  box.hook('prompt'); // init cursor

  box.store.appendDiscard({
    path: '/other/path/outside.txt',
    scope: 'file',
  });

  const out = box.hook('prompt');
  assert.deepEqual(JSON.parse(out), {});
});

test('SessionStart sweeps stale staging and initializes session cursor', (t) => {
  const box = sandbox(t);
  const out = box.hook('session-start');
  assert.deepEqual(JSON.parse(out), {});
});

test('malformed and empty inputs exit 0 with safe responses', (t) => {
  const box = sandbox(t);
  const preBad = box.hook('pre', 'invalid json {{{');
  assert.deepEqual(JSON.parse(preBad), { decision: 'allow' });

  const postBad = box.hook('post', '');
  assert.deepEqual(JSON.parse(postBad), {});

  const promptBad = box.hook('prompt', 'null');
  assert.deepEqual(JSON.parse(promptBad), {});
});

test('edge: file:// URI in Path with percent-encoding', (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.work, 'my dir'), { recursive: true });
  const file = join(box.work, 'my dir', 'file name.txt');
  const fileUri = `file://${box.work}/my%20dir/file%20name.txt`;
  writeFileSync(file, 'initial content');

  box.toolCycle('write_file', { Path: fileUri }, () => {
    writeFileSync(file, 'updated content');
  });

  const entry = box.store.readEntry(box.store.idFor(file));
  assert.equal(text(entry), 'initial content');
  assert.deepEqual(staging(box), []);
});

test('edge: input.error as an object drops staging even if disk changed', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'err_obj_disk.txt');
  writeFileSync(file, 'base');

  const input = {
    stepIdx: 10,
    toolCall: { name: 'edit_file', args: { Path: file } },
  };

  box.hook('pre', input);
  assert.equal(staging(box).length, 1);

  writeFileSync(file, 'partial corrupted modification');
  box.hook('post', { ...input, error: { message: 'Internal error' } });
  assert.equal(staging(box).length, 0);
  assert.equal(box.entry('err_obj_disk.txt'), null);
});

test('edge: input.status === "ERROR" drops staging', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'status_err.txt');
  writeFileSync(file, 'base');

  const input = {
    stepIdx: 11,
    toolCall: { name: 'edit_file', args: { Path: file } },
  };

  box.hook('pre', input);
  assert.equal(staging(box).length, 1);

  box.hook('post', { ...input, status: 'ERROR' });
  assert.equal(staging(box).length, 0);
  assert.equal(box.entry('status_err.txt'), null);
});

test('edge: non-ASCII / Unicode and spaces in file paths', (t) => {
  const box = sandbox(t);
  const name = 'folder with spaces/file 🚀 é.txt';
  const full = join(box.work, name);
  mkdirSync(join(box.work, 'folder with spaces'), { recursive: true });
  writeFileSync(full, 'initial unicode content\n');

  box.toolCycle('edit_file', { Path: full }, () => {
    writeFileSync(full, 'updated unicode content\n');
  });

  const entry = box.store.readEntry(box.store.idFor(full));
  assert.equal(text(entry), 'initial unicode content\n');
  assert.deepEqual(staging(box), []);
});

test('edge: write_file append mode preserves initial content as baseline', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'append.log');
  writeFileSync(file, 'line 1\n');

  box.toolCycle('write_file', { Path: 'append.log', Append: true, Content: 'line 2\n' }, () => {
    writeFileSync(file, 'line 1\nline 2\n');
  });

  const entry = box.entry('append.log');
  assert.equal(text(entry), 'line 1\n');
  assert.deepEqual(staging(box), []);
});

test('edge: alternative argument names and mixed case tool names', (t) => {
  const box = sandbox(t);
  const file = join(box.work, 'alt.txt');
  writeFileSync(file, 'v1');

  box.toolCycle('default_api:WRITE_FILE', { targetFile: 'alt.txt' }, () => {
    writeFileSync(file, 'v2');
  });

  const entry = box.entry('alt.txt');
  assert.equal(text(entry), 'v1');
  assert.deepEqual(staging(box), []);
});

test('edge: invalid and degenerate tool call args never crash', (t) => {
  const box = sandbox(t);
  assert.deepEqual(JSON.parse(box.hook('pre', { toolCall: null })), { decision: 'allow' });
  assert.deepEqual(JSON.parse(box.hook('post', { toolCall: null })), {});

  assert.deepEqual(JSON.parse(box.hook('pre', { toolCall: { name: 'write_file', args: null } })), { decision: 'allow' });
  assert.deepEqual(JSON.parse(box.hook('post', { toolCall: { name: 'write_file', args: null } })), {});

  assert.deepEqual(JSON.parse(box.hook('pre', { toolCall: { name: 'write_file', args: { Path: 12345 } } })), { decision: 'allow' });
  assert.deepEqual(JSON.parse(box.hook('post', { toolCall: { name: 'write_file', args: { Path: 12345 } } })), {});

  assert.deepEqual(JSON.parse(box.hook('pre', { toolCall: { name: 'write_file', args: { Path: 'file://' } } })), { decision: 'allow' });
  assert.deepEqual(JSON.parse(box.hook('post', { toolCall: { name: 'write_file', args: { Path: 'file://' } } })), {});

  assert.deepEqual(staging(box), []);
});

test('edge: multiple tool calls in same step with distinct toolCall id or paths', (t) => {
  const box = sandbox(t);
  const fileA = join(box.work, 'a.txt');
  const fileB = join(box.work, 'b.txt');
  writeFileSync(fileA, 'initial a\n');
  writeFileSync(fileB, 'initial b\n');

  const callA = {
    stepIdx: 20,
    toolCall: { id: 'call-1', name: 'write_file', args: { Path: 'a.txt' } },
  };
  const callB = {
    stepIdx: 20,
    toolCall: { id: 'call-2', name: 'write_file', args: { Path: 'b.txt' } },
  };

  box.hook('pre', callA);
  box.hook('pre', callB);
  assert.equal(staging(box).length, 2);

  writeFileSync(fileA, 'modified a\n');
  writeFileSync(fileB, 'modified b\n');

  box.hook('post', callA);
  box.hook('post', callB);

  assert.equal(text(box.entry('a.txt')), 'initial a\n');
  assert.equal(text(box.entry('b.txt')), 'initial b\n');
  assert.deepEqual(staging(box), []);
});
