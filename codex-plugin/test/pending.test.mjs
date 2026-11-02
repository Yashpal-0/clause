import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../../claude-plugin/store.mjs';
import { tempDir } from '../../claude-plugin/test/helpers.mjs';
import { completedPaths, readCalls, removeCall, saveCall, sessionRoot } from '../pending.mjs';

function sandbox(t) {
  const work = tempDir(t, 'codex-pending-');
  const store = openStore(join(work, 'store'));
  const transcriptPath = join(work, 'rollout.jsonl');
  writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"test"}}\n');
  const call = {
    key: 'stage-call', cwd: work, root: work, callId: 'call-1', transcriptPath,
    files: [{ path: join(work, 'a.txt'), key: 'stage-file', identity: 'a'.repeat(64) }], moves: [],
  };
  return { work, store, transcriptPath, call };
}

test('saved calls retain the pre-call transcript offset across store reopenings and sessions', (t) => {
  const box = sandbox(t);
  const offset = statSync(box.transcriptPath).size;
  const call = saveCall(box.store, 'session/../one', box.call);
  appendFileSync(box.transcriptPath, '{"type":"event_msg","payload":{"type":"ignored"}}\n');
  assert.equal(call.offset, offset);
  assert.deepEqual(readCalls(openStore(box.store.root), 'session/../one'), [call]);
  assert.deepEqual(readCalls(box.store, 'session-two'), []);
  const dir = join(box.store.root, 'codex-calls', createHash('sha256').update('session/../one').digest('hex'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of readdirSync(dir)) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(box.store.root, 'one')));
});

test('session root remains the first folder when a later call runs from a different directory', (t) => {
  const box = sandbox(t);
  const other = join(box.work, 'nested');
  mkdirSync(other);
  assert.equal(sessionRoot(box.store, 'one', box.work), box.work);
  assert.equal(sessionRoot(openStore(box.store.root), 'one', other), box.work);
  const call = saveCall(box.store, 'one', { ...box.call, cwd: other, root: other });
  assert.equal(call.root, box.work);
  assert.equal(sessionRoot(box.store, 'one'), box.work);
});

test('removing one call preserves another call and its session root', (t) => {
  const box = sandbox(t);
  const first = saveCall(box.store, 'one', box.call);
  const second = saveCall(box.store, 'one', { ...box.call, key: 'stage-other', callId: 'call-2' });
  removeCall(box.store, 'one', first.key);
  removeCall(box.store, 'one', first.key);
  assert.deepEqual(readCalls(box.store, 'one'), [second]);
  assert.equal(sessionRoot(box.store, 'one'), box.work);
});

test('malformed and oversized call metadata cannot publish a usable call', (t) => {
  const box = sandbox(t);
  assert.throws(() => saveCall(box.store, 'one', { ...box.call, cwd: 'relative' }), /invalid Codex call metadata/);
  assert.throws(() => saveCall(box.store, 'one', { ...box.call, callId: 'x'.repeat(8192) }), /invalid Codex call metadata/);
  const saved = saveCall(box.store, 'one', box.call);
  const dir = join(box.store.root, 'codex-calls', createHash('sha256').update('one').digest('hex'));
  const name = readdirSync(dir).find((name) => name !== 'session.json');
  assert.ok(name);
  writeFileSync(join(dir, name), '{"private":"not valid JSON');
  assert.deepEqual(readCalls(box.store, 'one'), []);
  writeFileSync(join(dir, name), ' '.repeat(4 * 1024 * 1024 + 1));
  assert.deepEqual(readCalls(box.store, 'one'), []);
  assert.equal(readFileSync(join(dir, 'session.json'), 'utf8').includes(saved.root), true);
});

test('unavailable transcript evidence never turns a changed user file into an agent completion', (t) => {
  const box = sandbox(t);
  const call = saveCall(box.store, 'one', { ...box.call, transcriptPath: null });
  writeFileSync(call.files[0].path, 'user content');
  assert.equal(completedPaths(call), null);
});

test('corrupt session metadata never lets a resumed call replace the original root', (t) => {
  const box = sandbox(t);
  sessionRoot(box.store, 'one', box.work);
  const dir = join(box.store.root, 'codex-calls', createHash('sha256').update('one').digest('hex'));
  const path = join(dir, 'session.json');
  writeFileSync(path, '{"root":"relative"}');
  assert.throws(() => sessionRoot(box.store, 'one', join(box.work, 'other')), /invalid Codex session root/);
  assert.equal(readFileSync(path, 'utf8'), '{"root":"relative"}');
});
