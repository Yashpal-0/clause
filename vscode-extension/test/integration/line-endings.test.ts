import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, onlyPendingFile, open, read, reset, seedEdited } from './helpers.ts';

// The same change as everywhere else (line 2 changed, a line added at the end), in a file with Windows line endings.
const BEFORE = 'one\r\ntwo\r\nthree\r\nfour\r\n';
const AFTER = 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n';

describe('a file with Windows line endings', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  async function seedPending() {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    assert.equal(file.state.blocks.length, 2, 'line endings do not make the lines differ');
    return { path, file };
  }

  describe('that is closed', () => {
    it('keeps its line endings when a changed block is discarded', async () => {
      const { path, file } = await seedPending();

      assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 0)));

      assert.equal(read(path), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    });

    it('keeps its line endings when an added block is discarded', async () => {
      const { path, file } = await seedPending();

      assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 1)));

      assert.equal(read(path), 'one\r\nTWO\r\nthree\r\nfour\r\n');
    });

    it('is given back byte for byte when the whole file is discarded', async () => {
      const { path, file } = await seedPending();

      assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(file)));

      assert.equal(read(path), BEFORE);
    });
  });

  describe('that is open', () => {
    async function openPending() {
      const { path, file } = await seedPending();
      const editor = await open(path);
      assert.equal(editor.document.eol, vscode.EndOfLine.CRLF);
      return { path, file, editor };
    }

    it('keeps its line endings, in the editor and on disk, when a block is discarded', async () => {
      const { path, file, editor } = await openPending();

      assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 0)));

      assert.equal(editor.document.eol, vscode.EndOfLine.CRLF);
      assert.equal(editor.document.getText(), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
      assert.equal(read(path), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    });

    it('keeps its line endings, in the editor and on disk, when the whole file is discarded', async () => {
      const { path, file, editor } = await openPending();

      assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(file)));

      assert.equal(editor.document.eol, vscode.EndOfLine.CRLF);
      assert.equal(editor.document.getText(), BEFORE);
      assert.equal(read(path), BEFORE);
    });
  });
});
