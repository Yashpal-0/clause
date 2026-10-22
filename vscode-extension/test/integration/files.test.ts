import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { BASELINE_SCHEME } from '../../src/ui/diff.ts';
import { extensionApi, inWorkspace, open, pendingAt, reset, seedEdited, seedEditedElsewhere, sleep, store, waitFor } from './helpers.ts';

const BEFORE = 'one\ntwo\nthree\nfour\n';
// Each file's first change is on a line of its own (zero-based 1, 3 and 0), so that a cursor on the wrong file's line shows.
const AFTER_AT_1 = 'one\nTWO\nthree\nfour\n';
const AFTER_AT_3 = 'one\ntwo\nthree\nFOUR\n';
const AFTER_AT_0 = 'ONE\ntwo\nthree\nfour\n';
const AFTER = AFTER_AT_1;

describe('when Claude first changed a file', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('is on every pending file, as the store recorded it', async () => {
    const first = seedEdited('first.txt', BEFORE, AFTER);
    await sleep(5);
    const second = seedEdited('second.txt', BEFORE, AFTER);
    await waitFor('both files', () => api.model.files().length === 2);

    for (const path of [first, second]) {
      const file = pendingAt(api, path);
      assert.ok(file, `${path} is pending`);
      assert.equal(file.createdAt, store().readEntry(file.id)?.createdAt);
    }
    assert.ok(pendingAt(api, first)!.createdAt < pendingAt(api, second)!.createdAt, 'the file seeded first is the older');
  });
});

describe('Review Next File and Review Previous File', () => {
  let api: ExtensionApi;
  const messages: string[] = [];
  const realTell = vscode.window.showInformationMessage;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    messages.length = 0;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    };
  });
  afterEach(async () => {
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = realTell;
    await reset(api);
  });

  const uriOf = (path: string) => vscode.Uri.file(path).toString();
  const shown = () => vscode.window.activeTextEditor?.document.uri.toString();
  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  const textTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText);

  /** Three files Claude changed, in this order, a moment apart so that the store dates them differently. */
  async function seedThree() {
    const a = seedEdited('a.txt', BEFORE, AFTER_AT_1);
    await sleep(5);
    const b = seedEdited('b.txt', BEFORE, AFTER_AT_3);
    await sleep(5);
    const c = seedEdited('c.txt', BEFORE, AFTER_AT_0);
    await waitFor('the three files', () => [a, b, c].every((path) => pendingAt(api, path) !== undefined));
    return { a, b, c };
  }

  /** An editor with nothing pending in it, to start from. */
  async function openPlain(): Promise<vscode.TextEditor> {
    const path = inWorkspace('plain.txt');
    writeFileSync(path, 'nothing\nto see\n');
    return open(path);
  }

  /** Runs `command` `times` times, waiting for each file to open, and lists where it landed. */
  async function stops(command: string, times: number): Promise<{ uri: string | undefined; line: number | undefined }[]> {
    const landed: { uri: string | undefined; line: number | undefined }[] = [];
    for (let step = 0; step < times; step++) {
      const before = shown();
      await vscode.commands.executeCommand(command);
      await waitFor('the next file to be shown', () => shown() !== before || times === 1);
      landed.push({ uri: shown(), line: vscode.window.activeTextEditor?.selection.active.line });
    }
    return landed;
  }

  it('opens the file Claude changed first, with the cursor on its first change, from an editor with nothing pending', async () => {
    const { a } = await seedThree();
    await openPlain();

    await vscode.commands.executeCommand('claudePending.nextFile');

    await waitFor('the file to open', () => shown() === uriOf(a));
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, 1);
  });

  it('goes on through the files in the order Claude changed them, and from the last one round to the first', async () => {
    const { a, b, c } = await seedThree();
    await openPlain();

    const landed = await stops('claudePending.nextFile', 4);

    assert.deepEqual(landed, [
      { uri: uriOf(a), line: 1 },
      { uri: uriOf(b), line: 3 },
      { uri: uriOf(c), line: 0 },
      { uri: uriOf(a), line: 1 },
    ]);
  });

  it('goes the other way with Review Previous File, and from the first one round to the last', async () => {
    const { a, b, c } = await seedThree();
    await openPlain();

    const landed = await stops('claudePending.previousFile', 4);

    assert.deepEqual(landed.map((stop) => stop.uri), [uriOf(c), uriOf(b), uriOf(a), uriOf(c)]);
    assert.deepEqual(landed.map((stop) => stop.line), [0, 3, 1, 0]);
  });

  it('follows when Claude first changed a file, not its path: a file that was kept and changed again comes last', async () => {
    const { a, b, c } = await seedThree();
    const id = store().idFor(a);
    await sleep(5);
    store().removeEntry(id);
    assert.ok(store().createEntry({ path: a, existed: true, base: Buffer.from(BEFORE) }), 'Claude changes it again');
    await waitFor('the file to be dated again', () => pendingAt(api, a)?.createdAt === store().readEntry(id)?.createdAt && api.model.files().length === 3);
    await openPlain();

    const landed = await stops('claudePending.nextFile', 3);

    assert.deepEqual(landed.map((stop) => stop.uri), [uriOf(b), uriOf(c), uriOf(a)]);
  });

  it('skips a file this window does not list, whichever editor it starts from', async () => {
    const hidden = seedEditedElsewhere('other.txt', BEFORE, AFTER, null);
    await sleep(5);
    const { a, c } = await seedThree();
    await waitFor('all four files to be known', () => api.model.files().length === 4);

    await openPlain();
    await vscode.commands.executeCommand('claudePending.nextFile');
    await waitFor('the first file this window lists', () => shown() === uriOf(a));

    await open(hidden);
    await vscode.commands.executeCommand('claudePending.previousFile');
    await waitFor('the last file this window lists', () => shown() === uriOf(c));
  });

  it('opens the diff of a file that is gone, as Show does', async () => {
    const a = seedEdited('a.txt', BEFORE, AFTER_AT_1);
    await sleep(5);
    const gone = seedEdited('gone.txt', BEFORE, AFTER_AT_3);
    await waitFor('both files', () => api.model.files().length === 2);
    rmSync(gone);
    await waitFor('the file to show as deleted', () => pendingAt(api, gone)?.state.situation === 'deleted');
    await open(a);

    await vscode.commands.executeCommand('claudePending.nextFile');

    await waitFor('the diff editor', () => activeTab()?.input instanceof vscode.TabInputTextDiff);
    const diff = activeTab()!.input as vscode.TabInputTextDiff;
    assert.equal(diff.original.scheme, BASELINE_SCHEME);
    assert.equal(diff.original.query, pendingAt(api, gone)?.id);
  });

  it('goes on from the diff of a file that is gone to the file after it, and back to the one before it', async () => {
    const a = seedEdited('a.txt', BEFORE, AFTER_AT_1);
    await sleep(5);
    const gone = seedEdited('gone.txt', BEFORE, AFTER_AT_3);
    await sleep(5);
    const c = seedEdited('c.txt', BEFORE, AFTER_AT_0);
    await waitFor('the three files', () => [a, gone, c].every((path) => pendingAt(api, path) !== undefined));
    rmSync(gone);
    await waitFor('the file to show as deleted', () => pendingAt(api, gone)?.state.situation === 'deleted');
    const isDiff = () => activeTab()?.input instanceof vscode.TabInputTextDiff;

    await open(a);
    await vscode.commands.executeCommand('claudePending.nextFile');
    await waitFor('the diff of the file that is gone', isDiff);
    await vscode.commands.executeCommand('claudePending.nextFile');
    await waitFor('the file after it', () => shown() === uriOf(c));

    await open(a);
    await vscode.commands.executeCommand('claudePending.nextFile');
    await waitFor('the diff of the file that is gone', isDiff);
    await vscode.commands.executeCommand('claudePending.previousFile');
    await waitFor('the file before it', () => shown() === uriOf(a));
  });

  it('opens each file as a preview tab, so that going through the files leaves one tab and not a pile', async () => {
    await seedThree();
    await openPlain();

    await stops('claudePending.nextFile', 3);

    assert.equal(activeTab()?.isPreview, true);
    // The editor the walk started from, which was opened to stay, and the one preview tab.
    assert.equal(textTabs().length, 2);
  });

  it('tells the user, and opens nothing, when nothing is pending', async () => {
    await vscode.commands.executeCommand('claudePending.nextFile');
    await vscode.commands.executeCommand('claudePending.previousFile');

    assert.deepEqual(messages, ['Nothing is pending.', 'Nothing is pending.']);
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 0, 'nothing was opened');
  });

  it('tells the user the file is the only one, from that file, and opens it from anywhere else', async () => {
    const only = seedEdited('only.txt', BEFORE, AFTER);
    await waitFor('the file', () => api.model.files().length === 1);
    await open(only);

    await vscode.commands.executeCommand('claudePending.nextFile');
    await vscode.commands.executeCommand('claudePending.previousFile');

    assert.deepEqual(messages, ['This is the only file with pending changes.', 'This is the only file with pending changes.']);
    assert.equal(shown(), uriOf(only));

    await openPlain();
    await vscode.commands.executeCommand('claudePending.nextFile');
    await waitFor('the only file to open', () => shown() === uriOf(only));
    assert.equal(messages.length, 2, 'nothing more was said');
  });
});
