import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { MAX_TEXT_BYTES } from '../../src/state.ts';
import { assertOk, extensionApi, fileTarget, hasEntry, onlyPendingFile, open, reset, seedEdited } from './helpers.ts';

type Outcome = { ok: boolean; reason?: string };

// "café\n" in Latin-1, where the é is a single byte that is not valid UTF-8; Claude then added a second one.
const LATIN1_BASELINE = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
const LATIN1_CURRENT = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]);

/** What cannot be compared line by line, so that it can only be kept or discarded as a whole. */
const CASES = [
  { name: 'not UTF-8', file: 'latin1.txt', baseline: LATIN1_BASELINE, current: LATIN1_CURRENT },
  { name: 'binary', file: 'data.bin', baseline: Buffer.from([0x00, 0x01, 0x02, 0x03]), current: Buffer.from([0x00, 0x01, 0x02, 0x04]) },
  { name: 'over the size limit', file: 'big.txt', baseline: Buffer.alloc(MAX_TEXT_BYTES + 1, 'a'), current: Buffer.alloc(MAX_TEXT_BYTES + 1, 'b') },
  { name: 'a notebook', file: 'notes.ipynb', baseline: Buffer.from('{"cells": []}\n'), current: Buffer.from('{"cells": [1]}\n') },
];

const holdsBytes = (path: string, expected: Buffer) => assert.ok(readFileSync(path).equals(expected), `${path} holds the expected bytes`);

for (const { name, file, baseline, current } of CASES) {
  describe(`a file that is ${name}`, () => {
    let api: ExtensionApi;

    before(async () => {
      api = await extensionApi();
    });
    afterEach(() => reset(api));

    it('is pending as a whole, with no blocks to list', async () => {
      seedEdited(file, baseline, current);

      const pending = await onlyPendingFile(api);

      assert.equal(pending.state.granularity, 'file');
      assert.deepEqual(pending.state.blocks, []);
      assert.deepEqual(api.model.counts(), { pending: 1, files: 1 });
      assert.deepEqual(api.tree.getChildren(fileTarget(pending)), []);
      assert.equal(api.tree.getTreeItem(fileTarget(pending)).collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    it('is given back byte for byte when discarded', async () => {
      const path = seedEdited(file, baseline, current);
      const pending = await onlyPendingFile(api);

      assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(pending)));

      holdsBytes(path, baseline);
      assert.equal(hasEntry(path), false);
    });

    it('is left as it is when kept', async () => {
      const path = seedEdited(file, baseline, current);
      const pending = await onlyPendingFile(api);

      assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(pending)));

      holdsBytes(path, current);
      assert.equal(hasEntry(path), false);
    });

    it('has no block for a block command to act on', async () => {
      const path = seedEdited(file, baseline, current);
      const pending = await onlyPendingFile(api);
      const block = { kind: 'changed', baseStart: 0, baseEnd: 1, curStart: 0, curEnd: 1 };

      for (const command of ['clause.keepBlock', 'clause.discardBlock']) {
        const result = await vscode.commands.executeCommand<Outcome>(command, { kind: 'block', id: pending.id, block });
        assert.equal(result.ok, false, command);
      }

      holdsBytes(path, current);
      assert.equal(hasEntry(path), true);
    });
  });
}

describe('a file that is not UTF-8, open in the editor', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const lensesOf = (editor: vscode.TextEditor) => vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri);

  it('has one bar for the whole file, and none for blocks', async () => {
    const path = seedEdited('latin1.txt', LATIN1_BASELINE, LATIN1_CURRENT);
    await onlyPendingFile(api);
    const editor = await open(path);

    const lenses = await lensesOf(editor);

    assert.deepEqual(
      lenses.map((lens) => [lens.range.start.line, lens.command?.title]),
      [
        [0, 'Claude changed this file'],
        [0, '$(discard) Discard'],
        [0, '$(check) Keep'],
        [0, '$(diff) Diff'],
      ],
    );
    assert.deepEqual(
      lenses.map((lens) => lens.command?.command),
      ['', 'clause.discardFile', 'clause.keepFile', 'clause.openDiff'],
    );
  });

  it('is discarded whole by the bar, and gets its bytes back', async () => {
    const path = seedEdited('latin1.txt', LATIN1_BASELINE, LATIN1_CURRENT);
    await onlyPendingFile(api);
    const lenses = await lensesOf(await open(path));
    const undo = lenses.find((lens) => lens.command?.command === 'clause.discardFile')!.command!;

    assertOk(await vscode.commands.executeCommand(undo.command, ...(undo.arguments ?? [])));

    holdsBytes(path, LATIN1_BASELINE);
    assert.equal(hasEntry(path), false);
  });
});
