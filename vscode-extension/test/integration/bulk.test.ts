import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, extensionApi, hasEntry, read, reset, seedCreated, seedEdited, seedEditedElsewhere, store, waitFor } from './helpers.ts';

type Outcome = { ok: boolean; reason?: string };

// Claude changed line 2 and added a line at the end: two blocks.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

describe('Keep All and Discard All', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** Two files in the window's folder (three changes) and one outside it, changed by a session started in it (one change). */
  async function seedScene() {
    const files = {
      inside: seedEdited('a.txt', BEFORE, AFTER),
      alsoInside: seedEdited('b.txt', 'x\ny\n', 'x\nY\n'),
      outside: seedEditedElsewhere('o.txt', 'o\n', 'O\n'),
    };
    await waitFor('the three files to be pending', () => api.model.files().length === 3);
    return files;
  }

  /** Makes the confirmation answer `answer` and records what it was asked. */
  function confirmationAnswers(answer: boolean) {
    const asked: Array<{ message: string; detail: string }> = [];
    api.prompts.confirmDiscard = async (message, detail) => {
      asked.push({ message, detail });
      return answer;
    };
    return asked;
  }

  describe('Keep All', () => {
    it('keeps the files in this folder and leaves the ones outside it pending', async () => {
      const { inside, alsoInside, outside } = await seedScene();

      assertOk(await vscode.commands.executeCommand('claudePending.keepAll'));

      assert.equal(hasEntry(inside), false);
      assert.equal(hasEntry(alsoInside), false);
      assert.equal(hasEntry(outside), true);
      assert.equal(read(inside), AFTER);
      assert.equal(read(alsoInside), 'x\nY\n');
      assert.deepEqual(api.model.counts(), { pending: 1, files: 1 });
    });

    it('keeps only the ones outside the folder when called on their group', async () => {
      const { inside, alsoInside, outside } = await seedScene();

      assertOk(await vscode.commands.executeCommand('claudePending.keepAll', { kind: 'group' }));

      assert.equal(hasEntry(outside), false);
      assert.equal(hasEntry(inside), true);
      assert.equal(hasEntry(alsoInside), true);
      assert.equal(read(outside), 'O\n');
      assert.deepEqual(api.model.counts(), { pending: 3, files: 2 });
    });
  });

  describe('Discard All', () => {
    it('discards the files in this folder and leaves the ones outside it pending', async () => {
      const { inside, alsoInside, outside } = await seedScene();

      assertOk(await vscode.commands.executeCommand('claudePending.discardAll'));

      assert.equal(read(inside), BEFORE);
      assert.equal(read(alsoInside), 'x\ny\n');
      assert.equal(hasEntry(inside), false);
      assert.equal(hasEntry(alsoInside), false);
      assert.equal(read(outside), 'O\n');
      assert.equal(hasEntry(outside), true);
    });

    it('discards only the ones outside the folder when called on their group', async () => {
      const { inside, alsoInside, outside } = await seedScene();

      assertOk(await vscode.commands.executeCommand('claudePending.discardAll', { kind: 'group' }));

      assert.equal(read(outside), 'o\n');
      assert.equal(hasEntry(outside), false);
      assert.equal(read(inside), AFTER);
      assert.equal(read(alsoInside), 'x\nY\n');
      assert.equal(hasEntry(inside), true);
    });

    it('asks first, saying how many files and changes it would revert', async () => {
      await seedScene();
      const asked = confirmationAnswers(true);

      assertOk(await vscode.commands.executeCommand('claudePending.discardAll'));

      assert.deepEqual(asked, [{ message: 'Discard pending changes in 2 files?', detail: '3 changes will be reverted.' }]);
    });

    it('says "file" and "change" for one of each', async () => {
      seedEdited('a.txt', 'a\n', 'A\n');
      await waitFor('the file to be pending', () => api.model.files().length === 1);
      const asked = confirmationAnswers(true);

      assertOk(await vscode.commands.executeCommand('claudePending.discardAll'));

      assert.deepEqual(asked, [{ message: 'Discard pending changes in 1 file?', detail: '1 change will be reverted.' }]);
    });

    it('warns that the files Claude created go to the trash', async () => {
      seedEdited('a.txt', BEFORE, AFTER);
      seedCreated('new.txt', 'hello\n');
      await waitFor('the two files to be pending', () => api.model.files().length === 2);
      // Declined, so that the question is all this test asks of the trash.
      const asked = confirmationAnswers(false);

      await vscode.commands.executeCommand('claudePending.discardAll');

      assert.deepEqual(asked, [
        { message: 'Discard pending changes in 2 files?', detail: '3 changes will be reverted. 1 file Claude created will be moved to the trash.' },
      ]);
    });

    it('changes nothing, and tells Claude nothing, when the answer is no', async () => {
      const { inside, alsoInside, outside } = await seedScene();
      const asked = confirmationAnswers(false);
      const logged = store().logSize();

      const result = await vscode.commands.executeCommand<Outcome | undefined>('claudePending.discardAll');

      assert.equal(result, undefined);
      assert.equal(asked.length, 1);
      assert.equal(read(inside), AFTER);
      assert.equal(read(alsoInside), 'x\nY\n');
      assert.equal(read(outside), 'O\n');
      assert.deepEqual(api.model.counts(), { pending: 4, files: 3 });
      assert.equal(store().logSize(), logged, 'nothing was written to the discard log');
    });
  });

  describe('where nothing is pending in this window', () => {
    it('does nothing, and does not ask, when only files outside the folder are pending', async () => {
      const outside = seedEditedElsewhere('o.txt', 'o\n', 'O\n');
      await waitFor('the file to be pending', () => api.model.files().length === 1);
      const asked = confirmationAnswers(true);

      assert.equal(await vscode.commands.executeCommand('claudePending.keepAll'), undefined);
      assert.equal(await vscode.commands.executeCommand('claudePending.discardAll'), undefined);

      assert.deepEqual(asked, []);
      assert.equal(read(outside), 'O\n');
      assert.equal(hasEntry(outside), true);
    });

    it('does nothing, and does not ask, when nothing is pending anywhere', async () => {
      const asked = confirmationAnswers(true);

      assert.equal(await vscode.commands.executeCommand('claudePending.keepAll'), undefined);
      assert.equal(await vscode.commands.executeCommand('claudePending.discardAll'), undefined);

      assert.deepEqual(asked, []);
    });
  });

  it('goes on with the other files when one is no longer tracked, and says which it could not find', async () => {
    const path = seedEdited('a.txt', 'a\n', 'A\n');
    await waitFor('the file to be pending', () => api.model.files().length === 1);
    const unknown = '0'.repeat(64);

    const result = await api.model.discardFiles([unknown, store().idFor(path)]);

    assert.deepEqual(result, { ok: false, reason: `${unknown}: Claude is no longer tracking this file.` });
    assert.equal(read(path), 'a\n');
    assert.equal(hasEntry(path), false);
  });
});
