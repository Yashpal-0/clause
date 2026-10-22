import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, onlyPendingFile, open, pendingAt, reset, seedCreated, seedEdited, store, trashWorks, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// What the next prompt tells Claude comes from this log: one record for each discard, and none for anything else.
describe('the log of what was discarded', () => {
  let api: ExtensionApi;
  // The log is append-only and the tests never clear it, so each test reads what was added after its own start.
  let offset = 0;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    offset = store().logSize();
  });
  afterEach(() => reset(api));

  const records = () => store().readDiscards(offset).records;
  const scopes = () => records().map(({ scope, detail }) => [scope, detail]);

  it('gets one record for each block that is discarded, naming the block', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 0)));
    await waitFor('the added block to be the only one left', () => pendingAt(api, file.path)?.state.blocks.length === 1);
    assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(pendingAt(api, file.path)!, 0)));

    assert.deepEqual(scopes(), [
      ['block', 'Changed 1 line at line 2'],
      ['block', 'Added 1 line at line 5'],
    ]);
    assert.deepEqual(
      records().map(({ path }) => path),
      [file.path, file.path],
    );
  });

  it('gets one record, with no detail, for a whole file that is discarded', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(file)));

    assert.deepEqual(scopes(), [['file', undefined]]);
    assert.equal(records()[0]!.path, file.path);
  });

  it('gets a record for a discard made in the editor, too', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    await open(path);

    assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 0)));

    assert.deepEqual(scopes(), [['block', 'Changed 1 line at line 2']]);
  });

  it('gets a record for a file Claude created that is discarded', async function () {
    if (!(await trashWorks())) return this.skip();
    seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(file)));

    assert.deepEqual(scopes(), [['file', undefined]]);
    assert.equal(records()[0]!.path, file.path);
  });

  it('gets one record for each file of a Discard All', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    seedEdited('b.txt', 'x\ny\n', 'x\nY\n');
    await waitFor('the two files to be pending', () => api.model.files().length === 2);
    const paths = api.model.files().map((file) => file.path);

    assertOk(await vscode.commands.executeCommand('clause.discardAll'));

    assert.deepEqual(scopes(), [
      ['file', undefined],
      ['file', undefined],
    ]);
    assert.deepEqual(records().map(({ path }) => path).sort(), [...paths].sort());
  });

  it('gets no record when a block or a file is kept', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    seedEdited('b.txt', 'x\ny\n', 'x\nY\n');
    await waitFor('the two files to be pending', () => api.model.files().length === 2);
    const [first, second] = api.model.files();

    assertOk(await vscode.commands.executeCommand('clause.keepBlock', blockTarget(first!, 0)));
    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(second!)));

    assert.deepEqual(records(), []);
  });

  it('gets no record when the discard is refused', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    // A block that is not one of the file's, as one shown before the file changed would be.
    const stale = { kind: 'block', id: file.id, block: { kind: 'changed', baseStart: 0, baseEnd: 1, curStart: 0, curEnd: 1 } };

    const result = await vscode.commands.executeCommand<{ ok: boolean }>('clause.discardBlock', stale);

    assert.equal(result.ok, false);
    assert.deepEqual(records(), []);
  });
});
