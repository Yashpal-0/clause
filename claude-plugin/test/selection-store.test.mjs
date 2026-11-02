import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';

test('selection store writes, reads, expires, and clears workspace selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'clause-test-store-'));
  try {
    const store = openStore(root);
    const workspace = '/data/projects/my-app';
    const selection = {
      filePath: '/data/projects/my-app/src/index.ts',
      startLine: 10,
      endLine: 20,
      lineCount: 11,
      text: 'const a = 1;\nconst b = 2;\n',
    };

    assert.equal(store.readSelection(workspace), null);

    store.writeSelection(workspace, selection);
    const read = store.readSelection(workspace);
    assert.ok(read !== null);
    assert.equal(read.filePath, selection.filePath);
    assert.equal(read.startLine, 10);
    assert.equal(read.endLine, 20);
    assert.equal(read.lineCount, 11);
    assert.equal(read.text, selection.text);
    assert.equal(typeof read.updatedAt, 'number');

    // Expired selection returns null
    const stale = store.readSelection(workspace, { now: Date.now() + 600_000, maxAgeMs: 300_000 });
    assert.equal(stale, null);

    // Clear selection
    assert.equal(store.clearSelection(workspace), true);
    assert.equal(store.readSelection(workspace), null);
    // Second clear returns false
    assert.equal(store.clearSelection(workspace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
