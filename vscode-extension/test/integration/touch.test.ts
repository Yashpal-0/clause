import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { PendingModel, type PendingTouch } from '../../src/pending.ts';
import { extensionApi, reset, seedEdited, sleep, store, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end: two blocks.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// The model batches the store's events for 50 ms; this is long enough to be sure it has had its say.
const QUIET_MS = 300;

describe('telling when Claude has just edited a pending file', () => {
  let api: ExtensionApi;
  let touches: PendingTouch[];
  let subscription: vscode.Disposable;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    touches = [];
    subscription = api.model.onDidTouch((touch) => touches.push(touch));
  });
  afterEach(async () => {
    subscription.dispose();
    await reset(api);
  });

  /** Seeds a pending file and waits until the model has reported it, so that the next step starts from a quiet model. */
  async function seedAndSettle(tool: string, line: number): Promise<{ path: string; id: string }> {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const id = store().idFor(path);
    assert.ok(store().touch(id, { tool, line }));
    await waitFor('the first touch', () => touches.length > 0);
    await sleep(QUIET_MS);
    touches.length = 0;
    return { path, id };
  }

  it('reports a file that appears without a touched record as touched at its first line', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const id = store().idFor(path);

    await waitFor('the touch', () => touches.length > 0);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, [{ id, line: 0 }]);
  });

  it('reports a file that appears with its touched record once, at the line the record names', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const id = store().idFor(path);
    assert.ok(store().touch(id, { tool: 'toolu_1', line: 4 }));

    await waitFor('the touch', () => touches.length > 0);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, [{ id, line: 4 }]);
  });

  it('reports each later edit of Claude, once, and not a record for an edit it has already reported', async () => {
    const { id } = await seedAndSettle('toolu_1', 4);

    assert.ok(store().touch(id, { tool: 'toolu_2', line: 1 }));
    await waitFor('the second edit', () => touches.length === 1);
    assert.ok(store().touch(id, { tool: 'toolu_2', line: 9 }));
    await sleep(QUIET_MS);
    assert.ok(store().touch(id, { tool: 'toolu_3', line: 2 }));
    await waitFor('the third edit', () => touches.length === 2);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, [
      { id, line: 1 },
      { id, line: 2 },
    ]);
  });

  it('notes the records that exist when the model starts, and reports only the edits after them', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const id = store().idFor(path);
    assert.ok(store().touch(id, { tool: 'toolu_old', line: 3 }));
    const model = new PendingModel(store(), () => {});
    const seen: PendingTouch[] = [];
    model.onDidTouch((touch) => seen.push(touch));
    try {
      model.start();
      await sleep(QUIET_MS);
      assert.deepEqual(seen, [], 'opening a window reports nothing');

      assert.ok(store().touch(id, { tool: 'toolu_new', line: 1 }));
      await waitFor('the new edit', () => seen.length > 0);
      await sleep(QUIET_MS);
      assert.deepEqual(seen, [{ id, line: 1 }]);
    } finally {
      model.dispose();
    }
  });

  it('does not take a block kept in another window for an edit of Claude', async () => {
    const { id } = await seedAndSettle('toolu_1', 4);
    const file = api.model.fileById(id);
    assert.equal(file?.state.blocks.length, 2);

    // What another window's Keep of the first block does to the store.
    assert.ok(store().writeBase(id, Buffer.from('one\nTWO\nthree\nfour\n')));
    await waitFor('the model to take the new baseline', () => api.model.fileById(id)?.state.blocks.length === 1);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, []);
  });

  it('reports a new entry for a file that already had one as a new edit', async () => {
    const { path, id } = await seedAndSettle('toolu_1', 4);

    // Removed and created again before the model looks, so it never sees the file without an entry.
    store().removeEntry(id);
    assert.ok(store().createEntry({ path, existed: true, base: Buffer.from('one\ntwo\nthree\n') }));
    await waitFor('the touch', () => touches.length > 0);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, [{ id, line: 0 }]);
  });

  it('reports nothing when an entry goes away', async () => {
    const { id } = await seedAndSettle('toolu_1', 4);

    store().removeEntry(id);
    await waitFor('the model to forget the file', () => api.model.fileById(id) === undefined);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, []);
  });

  it('treats a record it cannot read like a missing one', async () => {
    const root = process.env.CLAUDE_PENDING_EDITS_DIR;
    assert.ok(root, 'the test host has a scratch store');
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const id = store().idFor(path);
    writeFileSync(join(root, 'entries', id, 'touched'), 'not json');

    await waitFor('the touch', () => touches.length > 0);
    await sleep(QUIET_MS);

    assert.deepEqual(touches, [{ id, line: 0 }]);
  });
});
