import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import * as vscode from 'vscode';
import { openStore } from '../../../claude-plugin/store.mjs';
import type { ExtensionApi } from '../../src/extension.ts';
import type { PendingFile } from '../../src/pending.ts';
import type { BlockTarget, FileTarget } from '../../src/targets.ts';

export const EXTENSION_ID = 'local.claude-pending-edits';

export async function extensionApi(): Promise<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, 'the extension is installed in the test host');
  return extension.isActive ? extension.exports : extension.activate();
}

/** The store the extension host was started with, never the real one. */
export function store() {
  const root = process.env.CLAUDE_PENDING_EDITS_DIR;
  assert.ok(root?.includes(`${sep}.vscode-test${sep}`), `tests must run against a scratch store, not ${root}`);
  return openStore(root);
}

export function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test host opened a workspace folder');
  return folder.uri.fsPath;
}

export const inWorkspace = (relativePath: string) => join(workspaceDir(), relativePath);

let seeded = 0;
// Every test file is its own bundle with its own copy of this module and its own counter, in one extension host and one workspace.
const bundle = randomBytes(4).toString('hex');

/**
 * Every seeded file gets a directory of its own. VS Code keeps a document that
 * was opened through the API alive for 3 minutes after its editor closes, so a
 * test that reused `a.txt` could meet the previous test's text instead of its own.
 */
const freshPath = (relativePath: string) => inWorkspace(join(`case-${bundle}-${++seeded}`, relativePath));

/**
 * A file Claude edited: `after` is on disk, `before` is the baseline the hook would have stored.
 * `sessionDir` is the folder the session that edited it was started in; without one the entry is
 * like those made before sessions were recorded.
 */
export function seedEdited(relativePath: string, before: string | Buffer, after: string | Buffer, sessionDir?: string): string {
  const path = freshPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  assert.ok(store().createEntry({ path, existed: true, base: Buffer.from(before), sessionDir }), 'a new entry was created');
  return path;
}

/** A file Claude created. */
export function seedCreated(relativePath: string, content: string | Buffer): string {
  const path = freshPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  assert.ok(store().createEntry({ path, existed: false, base: null }), 'a new entry was created');
  return path;
}

/**
 * Where files outside the window's folder are seeded: next to the workspace, so
 * that a test can never touch anything real, and removed by `reset`.
 */
const elsewhereDir = () => join(dirname(workspaceDir()), `outside-of-${basename(workspaceDir())}`);

/**
 * A file Claude edited outside the folder this window has open. `sessionDir` is where the session
 * that edited it was started: this window's folder unless said otherwise, and null for an entry
 * made before sessions were recorded.
 */
export function seedEditedElsewhere(relativePath: string, before: string, after: string, sessionDir: string | null = workspaceDir()): string {
  const path = join(elsewhereDir(), `case-${bundle}-${++seeded}`, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  assert.ok(store().createEntry({ path, existed: true, base: Buffer.from(before), sessionDir: sessionDir ?? undefined }), 'a new entry was created');
  return path;
}

export const read = (path: string) => readFileSync(path, 'utf8');

/** What the store holds as the file's baseline, or undefined when it has no entry. */
export function storedBaseline(path: string): string | undefined {
  const entries = store();
  return entries.readEntry(entries.idFor(path))?.base?.toString('utf8');
}

export const hasEntry = (path: string) => store().readMeta(store().idFor(path)) !== null;

/** Fails at the call, with the model's reason, when an operation was refused. */
export function assertOk(result: unknown): void {
  assert.deepEqual(result, { ok: true });
}

export async function waitFor(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function open(path: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  return vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Leaves the host as it found it: no open editors, no unsaved work, no
 * entries, no files. Unsaved documents are saved first because closing one
 * asks a question that nobody is there to answer.
 */
export async function reset(api: ExtensionApi): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.files.saveAll');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const entries = store();
  for (const { id } of entries.listEntries()) entries.removeEntry(id);
  for (const name of readdirSync(workspaceDir())) rmSync(join(workspaceDir(), name), { recursive: true, force: true });
  rmSync(elsewhereDir(), { recursive: true, force: true });
  api.prompts.confirmDiscard = async () => true;
  await api.model.refreshAll();
  await waitFor('the model to forget everything', () => api.model.files().length === 0);
}

/** Waits for the one pending file there should be and returns it. */
export async function onlyPendingFile(api: ExtensionApi): Promise<PendingFile> {
  await waitFor('the file to be pending', () => api.model.files().length === 1);
  return api.model.files()[0]!;
}

/** The pending file at `path`, found by its entry id so that a path the model stores in canonical form still matches. */
export const pendingAt = (api: ExtensionApi, path: string): PendingFile | undefined => api.model.fileById(store().idFor(path));

export const fileTarget = (file: PendingFile): FileTarget => ({ kind: 'file', id: file.id });

export function blockTarget(file: PendingFile, index: number): BlockTarget {
  const block = file.state.blocks[index];
  assert.ok(block, `the file has a block ${index}`);
  return { kind: 'block', id: file.id, block };
}

/**
 * The folder files are moved into when trashed, where a test can look; undefined
 * where the platform's trash is not a folder the config can redirect.
 */
export function trashedFilesFolder(): string | undefined {
  const data = process.env.XDG_DATA_HOME;
  return process.platform === 'linux' && data?.includes(`${sep}.vscode-test${sep}`) ? join(data, 'Trash', 'files') : undefined;
}

/** Whether this machine can move files to a trash from the test workspace; some CI images cannot. */
export async function trashWorks(): Promise<boolean> {
  const probe = inWorkspace('.trash-probe');
  writeFileSync(probe, 'x');
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(probe), { useTrash: true });
    return true;
  } catch {
    rmSync(probe, { force: true });
    return false;
  }
}
