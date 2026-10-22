import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchDirectory } from '../../src/watch.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'claude-pending-watch-'));

/** Polls until `condition` holds; file watchers have no fixed latency. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 20) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a file created in the directory is reported by name', async () => {
  const dir = scratch();
  const names: Array<string | null> = [];
  const watch = watchDirectory(dir, (name) => names.push(name));
  assert.ok(watch);
  try {
    writeFileSync(join(dir, 'a.txt'), 'x');
    await until(() => names.includes('a.txt'), 'the event for a.txt');
  } finally {
    watch.close();
    rmSync(dir, { recursive: true });
  }
});

test('a file replaced by a rename is reported every time it is replaced', async () => {
  const dir = scratch();
  const names: Array<string | null> = [];
  const watch = watchDirectory(dir, (name) => names.push(name));
  assert.ok(watch);
  try {
    const reports = () => names.filter((name) => name === 'record').length;
    for (const round of [1, 2, 3]) {
      const before = reports();
      writeFileSync(join(dir, 'next'), String(round));
      renameSync(join(dir, 'next'), join(dir, 'record'));
      await until(() => reports() > before, `replacement ${round} of record`);
    }
  } finally {
    watch.close();
    rmSync(dir, { recursive: true });
  }
});

test('a directory that does not exist cannot be watched', () => {
  assert.equal(watchDirectory(join(scratch(), 'missing'), () => {}), undefined);
});

test('nothing is reported after the watch is closed', async () => {
  const dir = scratch();
  const names: Array<string | null> = [];
  const watch = watchDirectory(dir, (name) => names.push(name));
  assert.ok(watch);
  watch.close();
  writeFileSync(join(dir, 'a.txt'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(names, []);
  rmSync(dir, { recursive: true });
});
