import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { extensionApi, onlyPendingFile, open, read, store, storedBaseline, waitFor } from '../helpers.ts';
import { AFTER, BEFORE, FILE_WITH_TYPING, restartFile } from './shared.ts';

// The first of two runs of the editor that share a workspace, user data and store (see .vscode-test.mjs).
// It leaves its work behind on purpose, with no reset: reopen.test.ts checks what the second run finds.
describe('before the editor is closed with changes still pending', () => {
  it('has a file Claude changed, and typing by the user between Claude\'s blocks, saved', async () => {
    const api = await extensionApi();
    const path = restartFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, AFTER);
    assert.ok(store().createEntry({ path, existed: true, base: Buffer.from(BEFORE) }), 'Claude started an entry');
    await onlyPendingFile(api);
    const editor = await open(path);

    await editor.edit((edit) => edit.insert(new vscode.Position(4, 0), 'my '));
    await waitFor('the typing to become a block', () => api.model.files()[0]?.state.blocks.length === 3);
    assert.equal(await editor.document.save(), true);

    assert.equal(read(path), FILE_WITH_TYPING);
    assert.equal(storedBaseline(path), BEFORE, 'typing does not enter the baseline');
    assert.equal(api.model.files()[0]?.state.blocks.length, 3);
  });
});
