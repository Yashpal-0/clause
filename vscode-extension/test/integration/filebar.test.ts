import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, extensionApi, hasEntry, pendingAt, reset, seedCreated, seedEdited, seedEditedElsewhere, sleep, waitFor } from './helpers.ts';

// The change is on line 1, so that it is no lens of the first line, where the file bar sits.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\n';

interface Item {
  readonly title: string | undefined;
  readonly command: string | undefined;
}

describe('the file bar at the top of a pending file', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** The editor refuses to ask for the lenses of a document it holds no text model of, so the document is opened first. */
  async function lensesOf(path: string): Promise<vscode.CodeLens[]> {
    const uri = vscode.Uri.file(path);
    await vscode.workspace.openTextDocument(uri);
    return vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
  }

  /** The lenses on the first line, in the order they are drawn. */
  async function barOf(path: string): Promise<Item[]> {
    const lenses = await lensesOf(path);
    return lenses.filter((lens) => lens.range.start.line === 0).map((lens) => ({ title: lens.command?.title, command: lens.command?.command }));
  }

  /** `count` files Claude changed, one after the other, so that the store dates them apart. */
  async function seedFiles(count: number): Promise<string[]> {
    const paths: string[] = [];
    for (let index = 0; index < count; index++) {
      paths.push(seedEdited(`file-${index}.txt`, BEFORE, AFTER));
      await sleep(5);
    }
    await waitFor('the files', () => paths.every((path) => pendingAt(api, path) !== undefined));
    return paths;
  }

  const bar = (position: number, total: number): Item[] => [
    { title: '$(arrow-left)', command: 'clause.previousFile' },
    { title: `File ${position} of ${total}`, command: '' },
    { title: '$(arrow-right)', command: 'clause.nextFile' },
    { title: '$(discard) Discard file', command: 'clause.discardFile' },
    { title: '$(check) Keep file Ctrl+Enter', command: 'clause.keepFile' },
    { title: 'Review Next File $(arrow-right)', command: 'clause.nextFile' },
  ];

  it('says which file of the pending ones this is, in the order Claude changed them, and offers the way on', async () => {
    const paths = await seedFiles(5);

    assert.deepEqual(await barOf(paths[0]!), bar(1, 5));
    assert.deepEqual(await barOf(paths[1]!), bar(2, 5));
    assert.deepEqual(await barOf(paths[4]!), bar(5, 5), 'the last one, which the arrows wrap from');
  });

  it('has Discard file and Keep file only, when this is the one file with pending changes', async () => {
    const [path] = await seedFiles(1);

    assert.deepEqual(await barOf(path!), [
      { title: '$(discard) Discard file', command: 'clause.discardFile' },
      { title: '$(check) Keep file Ctrl+Enter', command: 'clause.keepFile' },
    ]);
  });

  it('acts on its own file, whichever file is open', async () => {
    const [first, second] = await seedFiles(2);
    const lenses = await lensesOf(second!);
    const keep = lenses.find((lens) => lens.command?.command === 'clause.keepFile')!.command!;
    assert.deepEqual(keep.arguments, [{ kind: 'file', id: pendingAt(api, second!)!.id }]);

    assertOk(await vscode.commands.executeCommand(keep.command, ...(keep.arguments ?? [])));

    assert.equal(hasEntry(second!), false);
    assert.equal(hasEntry(first!), true);
  });

  it('counts again when a file is kept, and drops the way on when one file is left', async () => {
    const [first, second, third] = await seedFiles(3);
    assert.deepEqual(await barOf(third!), bar(3, 3));

    assertOk(await vscode.commands.executeCommand('clause.keepFile', { kind: 'file', id: pendingAt(api, first!)!.id }));
    await waitFor('the file to be gone', () => pendingAt(api, first!) === undefined);
    assert.deepEqual(await barOf(third!), bar(2, 2));

    assertOk(await vscode.commands.executeCommand('clause.keepFile', { kind: 'file', id: pendingAt(api, second!)!.id }));
    await waitFor('the file to be gone', () => pendingAt(api, second!) === undefined);
    assert.deepEqual((await barOf(third!)).map((item) => item.command), ['clause.discardFile', 'clause.keepFile']);
  });

  it('adds only the way on to a file that can only be kept whole, which has its own Discard and Keep', async () => {
    const edited = seedEdited('edited.txt', BEFORE, AFTER);
    await sleep(5);
    const created = seedCreated('created.txt', 'a\nb\n');
    await waitFor('both files', () => pendingAt(api, edited) !== undefined && pendingAt(api, created) !== undefined);

    const row = await barOf(created);

    assert.deepEqual(row.map((item) => item.command), [
      'clause.previousFile',
      '',
      'clause.nextFile',
      'clause.nextFile',
      '',
      'clause.discardFile',
      'clause.keepFile',
      'clause.openDiff',
    ]);
    assert.equal(row[1]?.title, 'File 2 of 2');
    assert.equal(row[4]?.title, 'Claude created this file');
  });

  it('leaves a file of another project with Discard file and Keep file, and does not count it', async () => {
    const [first, second] = await seedFiles(2);
    const other = seedEditedElsewhere('other.txt', BEFORE, AFTER, null);
    await waitFor('the other project\'s file to be known', () => pendingAt(api, other) !== undefined);

    assert.deepEqual((await barOf(other)).map((item) => item.command), ['clause.discardFile', 'clause.keepFile']);
    assert.equal((await barOf(first!))[1]?.title, 'File 1 of 2');
    assert.equal((await barOf(second!))[1]?.title, 'File 2 of 2');
  });

  it('is not there for a file with nothing pending', async () => {
    seedEdited('pending.txt', BEFORE, AFTER);
    await waitFor('the file', () => api.model.files().length === 1);
    const path = seedEdited('settled.txt', BEFORE, BEFORE);
    await sleep(100);

    assert.deepEqual(await lensesOf(path), []);
  });
});
