import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { BASELINE_SCHEME } from '../../src/ui/diff.ts';
import { ExplorerMarks } from '../../src/ui/explorer.ts';
import { assertOk, extensionApi, inWorkspace, open, pendingAt, reset, seedEdited, seedEditedElsewhere, sleep, store, waitFor, workspaceDir } from './helpers.ts';

// Lines 1 and 5 are Claude's; the unchanged lines between them keep your typing at line 5 from joining the block at line 1.
const BEFORE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
const ONE_BLOCK = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n';

/** Everything a provider announces, as the paths of the files it names; `'all'` for an announcement that names none. */
function listen(marks: ExplorerMarks) {
  const announced: (string[] | 'all')[] = [];
  const subscription = marks.onDidChangeFileDecorations((change) => {
    announced.push(change === undefined ? 'all' : [change].flat().map((uri) => uri.fsPath));
  });
  return { announced, stop: () => subscription.dispose() };
}

const sorted = (announcement: string[] | 'all') => (announcement === 'all' ? announcement : [...announcement].sort());

/** What marking these files names: each file, the folder it sits in and the workspace folder. Seeded files sit directly in a folder of their own under the workspace folder. */
const marked = (...files: string[]) => [...new Set([...files, ...files.map((file) => dirname(file)), workspaceDir()])].sort();

/** Changes a user setting and waits until the extension host has heard of the change; an unchanged value would never be heard of. */
async function setUserSetting(section: string, key: string, value: unknown): Promise<void> {
  const heardOf = new Promise<void>((resolve) => {
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${section}.${key}`)) {
        subscription.dispose();
        resolve();
      }
    });
  });
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
  await heardOf;
}

describe('the mark on files that have changes waiting', () => {
  let api: ExtensionApi;
  let heard: ReturnType<typeof listen>;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    heard = listen(api.explorer);
  });
  afterEach(async () => {
    heard.stop();
    await reset(api);
  });

  const decorationOf = (path: string) => api.explorer.provideFileDecoration(vscode.Uri.file(path));

  /** The path the model keeps the file under, which is the one it names in an announcement. */
  async function pendingPath(path: string): Promise<string> {
    await waitFor(`${path} to be pending`, () => pendingAt(api, path) !== undefined);
    return pendingAt(api, path)!.uri.fsPath;
  }

  it('marks a file that has a change waiting, and asks for its folders to be marked too', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    await pendingPath(path);

    const decoration = decorationOf(path);

    assert.equal(decoration?.badge, '◆');
    assert.equal(decoration?.tooltip, '1 change waiting for Keep or Discard');
    assert.equal(decoration?.color?.id, 'claudePending.explorerForeground');
    assert.equal(decoration?.propagate, true);
  });

  it('says how many changes are waiting in the file', async () => {
    const path = seedEdited('a.txt', BEFORE, 'one\nTWO\nthree\nfour\nfive\nSIX\nseven\n');
    await pendingPath(path);

    assert.equal(decorationOf(path)?.tooltip, '2 changes waiting for Keep or Discard');
  });

  it('marks nothing but files that have a change waiting', async () => {
    const pending = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const settled = seedEdited('b.txt', BEFORE, BEFORE);
    const plain = inWorkspace('plain.txt');
    writeFileSync(plain, 'no entry\n');
    await pendingPath(pending);
    // The settled file's entry has to have been read, or its silence would only mean the model had not got to it yet.
    await api.model.refreshAll();

    assert.ok(decorationOf(pending), 'control: the file with a change waiting is marked');
    assert.equal(decorationOf(settled), undefined, 'a file with nothing left to decide');
    assert.equal(decorationOf(plain), undefined, 'a file Claude has not touched');
    assert.equal(decorationOf(dirname(settled)), undefined, 'a folder with nothing waiting in it');
    const quiet = inWorkspace('quiet');
    mkdirSync(quiet);
    assert.equal(decorationOf(quiet), undefined, 'a folder next to the one with a change waiting');
    const before = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(pending).path, query: pendingAt(api, pending)!.id });
    assert.equal(api.explorer.provideFileDecoration(before), undefined, 'the "before" side of a diff');
    assert.equal(api.explorer.provideFileDecoration(vscode.Uri.parse('untitled:Untitled-1')), undefined, 'a file that has no place on disk');
  });

  it('colours the folders above a file that has a change waiting, up to the workspace folder, and gives them no badge', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    await pendingPath(path);
    await waitFor('the file to be announced', () => heard.announced.length > 0);

    // The colour is the folder's own: a folder that only inherited the files' marks would take the colour of whichever decoration VS Code asked first, git's included.
    for (const folder of [dirname(path), workspaceDir()]) {
      const decoration = decorationOf(folder);
      assert.equal(decoration?.color?.id, 'claudePending.explorerForeground', `the colour of ${folder}`);
      assert.equal(decoration?.badge, undefined, `no badge on ${folder}`);
    }
    assert.equal(decorationOf(dirname(workspaceDir())), undefined, 'the folder that holds the workspace folder');
    const inAnotherScheme = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(dirname(path)).path });
    assert.equal(api.explorer.provideFileDecoration(inAnotherScheme), undefined, 'a folder in another scheme');
  });

  it('does not colour the folders of a file outside the workspace folders', async () => {
    const outside = seedEditedElsewhere('c.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(outside);
    await waitFor('the file to be announced', () => heard.announced.length > 0);
    await sleep(300);

    assert.ok(decorationOf(outside), 'control: the file itself is marked');
    assert.equal(decorationOf(dirname(outside)), undefined);
    assert.equal(decorationOf(dirname(dirname(outside))), undefined, 'the folder that holds it and sits next to the workspace folder');
    assert.equal(decorationOf(workspaceDir()), undefined, 'the workspace folder, which holds none of the pending files');
    assert.deepEqual(heard.announced.map(sorted), [[named]]);
  });

  it('keeps a folder coloured until the last file in it has nothing waiting', async () => {
    const first = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const second = join(dirname(first), 'b.txt');
    writeFileSync(second, ONE_BLOCK);
    assert.ok(store().createEntry({ path: second, existed: true, base: Buffer.from(BEFORE) }), 'a second entry in the same folder');
    const firstNamed = await pendingPath(first);
    const secondNamed = await pendingPath(second);
    await waitFor('both files to be announced', () => {
      const names = new Set(heard.announced.flat());
      return names.has(firstNamed) && names.has(secondNamed);
    });
    heard.announced.length = 0;

    assertOk(await api.model.keepFile(pendingAt(api, first)!.id));
    await waitFor('the first keep to be announced', () => heard.announced.length > 0);

    assert.ok(decorationOf(dirname(first)), 'one file in the folder still has a change waiting');
    assert.ok(decorationOf(workspaceDir()));

    heard.announced.length = 0;
    assertOk(await api.model.keepFile(pendingAt(api, second)!.id));
    await waitFor('the second keep to be announced', () => heard.announced.length > 0);

    assert.equal(decorationOf(dirname(first)), undefined);
    assert.equal(decorationOf(workspaceDir()), undefined);
  });

  it('names a file when it becomes pending, with the folders it sits in, and nothing else', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(path);

    await waitFor('the file to be announced', () => heard.announced.length > 0);
    await sleep(300);

    assert.deepEqual(heard.announced.map(sorted), [marked(named)]);
  });

  it('names a file again when the number of changes waiting in it changes', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(path);
    const editor = await open(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;

    await editor.edit((edit) => edit.replace(new vscode.Range(5, 0, 5, 3), 'SIX'));

    await waitFor('the second change to be announced', () => heard.announced.length > 0);
    assert.deepEqual(heard.announced, [[named]]);
    assert.equal(decorationOf(path)?.tooltip, '2 changes waiting for Keep or Discard');
  });

  it('does not name a file again while the number of changes waiting in it stays the same', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    await pendingPath(path);
    const editor = await open(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;
    // The model reports only when the shape of the blocks changes, so the edit has to make the block longer: typing inside it
    // would never reach the provider, and the test would pass whatever the provider did with it.
    let reports = 0;
    const subscription = api.model.onDidChange(() => reports++);

    try {
      await editor.edit((edit) => edit.insert(new vscode.Position(1, 3), '\nTWO AND A HALF'));
      await waitFor('the model to report the longer block', () => reports > 0);
      await sleep(300);
    } finally {
      subscription.dispose();
    }

    assert.equal(api.model.fileForUri(vscode.Uri.file(path))?.state.pending, 1, 'control: one change, only longer');
    assert.deepEqual(heard.announced, []);
  });

  it('names a file when its last change is kept, and the mark goes', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;

    assertOk(await api.model.keepFile(pendingAt(api, path)!.id));

    await waitFor('the keep to be announced', () => heard.announced.length > 0);
    assert.deepEqual(heard.announced.map(sorted), [marked(named)]);
    assert.equal(decorationOf(path), undefined);
    assert.equal(decorationOf(dirname(path)), undefined, 'the folder it sat in has nothing waiting any more');
  });

  it('names a file whose entry another window removed, and the mark goes', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;

    store().removeEntry(store().idFor(path));

    await waitFor('the removal to be announced', () => heard.announced.length > 0);
    assert.deepEqual(heard.announced.map(sorted), [marked(named)]);
    assert.equal(decorationOf(path), undefined);
    assert.equal(decorationOf(dirname(path)), undefined, 'the folder it sat in has nothing waiting any more');
  });

  it('names the files that are already pending when it starts, the first time the model reports', async () => {
    const early = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const earlyNamed = await pendingPath(early);
    // A second set of marks, as at startup: it has announced nothing yet.
    const late = new ExplorerMarks(api.model);
    const lateHeard = listen(late);
    try {
      const later = seedEdited('b.txt', BEFORE, ONE_BLOCK);
      const laterNamed = await pendingPath(later);

      await waitFor('both files to be announced', () => lateHeard.announced.flat().length >= 2);
      await sleep(300);
      assert.deepEqual([...new Set(lateHeard.announced.flat())].sort(), marked(earlyNamed, laterNamed));
    } finally {
      lateHeard.stop();
      late.dispose();
    }
  });

  it('can announce every mark again, for a registration that starts with none of them cached', async () => {
    const first = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const second = seedEdited('b.txt', BEFORE, ONE_BLOCK);
    const firstNamed = await pendingPath(first);
    const secondNamed = await pendingPath(second);
    await waitFor('both files to be announced', () => {
      const names = new Set(heard.announced.flat());
      return names.has(firstNamed) && names.has(secondNamed);
    });
    heard.announced.length = 0;

    api.explorer.announceAll();

    assert.deepEqual(heard.announced.map(sorted), [marked(firstNamed, secondNamed)]);
  });

  // Git registers its own decorations after ours when it opens a repository or when its decorations are switched on, and VS Code
  // lets the newest registration win a tie. The marks register again behind git, so that they are the newest.
  it('announces every mark again when git switches its own decorations, because that is when the marks register again', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    const named = await pendingPath(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;

    try {
      await setUserSetting('git', 'decorations.enabled', false);
      await waitFor('every mark to be announced again', () => heard.announced.length > 0);
      assert.deepEqual(heard.announced.map(sorted), [marked(named)]);
    } finally {
      await setUserSetting('git', 'decorations.enabled', undefined);
    }
  });

  it('does not announce anything again when a setting that has nothing to do with git changes', async () => {
    const path = seedEdited('a.txt', BEFORE, ONE_BLOCK);
    await pendingPath(path);
    await waitFor('the first announcement', () => heard.announced.length > 0);
    heard.announced.length = 0;

    try {
      await setUserSetting('editor.minimap', 'enabled', false);
      await sleep(300);
      assert.deepEqual(heard.announced, []);
    } finally {
      await setUserSetting('editor.minimap', 'enabled', undefined);
    }
  });
});
