import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, sep } from 'node:path';
import * as vscode from 'vscode';
import { openStore } from '../../claude-plugin/store.mjs';
import { Delayed } from './delayed.ts';
import { applyLineEdit, computeBlocks, discardEdit, keepBlock, keepParts, parseDoc, printDoc, type Block, type BlockPart, type Doc } from './hunks.ts';
import { anchorLine, blockLabel, findBlock } from './nav.ts';
import { KeyedQueue } from './queue.ts';
import { baselineText, computeState, decodeText, encodeText, type Current, type FileState } from './state.ts';
import { watchDirectory, type DirectoryWatch } from './watch.ts';

export type Store = ReturnType<typeof openStore>;
type StoreEntry = NonNullable<ReturnType<Store['readEntry']>>;

/** What a keep or discard did. A refusal carries the reason to show the user; nothing was changed. */
export type OpResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A file with changes of Claude's that are waiting for a decision. */
export interface PendingFile {
  readonly id: string;
  /** Canonical path, as stored. */
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly state: FileState;
  /** Where the Claude sessions that changed the file were started, oldest first. Empty for an entry made before sessions were recorded. */
  readonly sessionDirs: readonly string[];
  /** ISO timestamp of Claude's first pending change to the file; it is the order files are reviewed in. */
  readonly createdAt: string;
}

/** Claude has just edited a file that is pending. `line` is where the edit starts (0-based); 0 when the store does not say. */
export interface PendingTouch {
  readonly id: string;
  readonly line: number;
}

/** Waits for typing to pause before re-reading a file; the editor moves decorations along meanwhile. */
const REFRESH_DELAY_MS = 80;

/**
 * A file that looks fully decided is only forgotten after this long and a look
 * at the disk. Claude's write and the editor's reload of it do not arrive at
 * the same moment, and an entry removed in between would lose the edit.
 */
const CLEANUP_DELAY_MS = 1500;

/** Store events come in bursts (a baseline is written through a temporary file). */
const STORE_EVENT_DELAY_MS = 50;

const ENTRY_ID = /^[0-9a-f]{1,64}$/;

const ok: OpResult = { ok: true };
const refuse = (reason: string): OpResult => ({ ok: false, reason });
const CHANGED = refuse('The file changed since it was shown, so nothing was changed. Try again.');
const GONE = refuse('Clause is no longer tracking this file.');

interface Tracked {
  readonly id: string;
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly existed: boolean;
  /** Tells a later entry for the same file apart from this one. */
  readonly createdAt: string;
  /** The baseline bytes as last read from or written to the store. Only Keep writes them. */
  stored: Buffer | null;
  /** The edit of Claude's that the store's `touched` record named when last read; null while it had none. */
  touchedBy: string | null;
  /** The store's `sessions` record when last read. */
  sessionDirs: readonly string[];
  /**
   * Watches the entry's directory for the files in it being replaced. A recursive watch of the whole store is not
   * enough: on Linux Node follows each file by inode, so it stops reporting `touched` and `base` after their first
   * replacement by a rename.
   */
  readonly entryWatch: DirectoryWatch | undefined;
  /**
   * `stored` by line, when it is text that is compared by line. Null for a file Claude created and for baselines that
   * are only compared as a whole (notebooks, binary and non-UTF-8 files, files over 2 MB).
   */
  baseDoc: Doc | null;
  readonly bom: boolean;
  /** The open editor document, if any. */
  document: vscode.TextDocument | undefined;
  view: PendingFile | undefined;
  readonly refresh: Delayed;
  readonly cleanup: Delayed;
}

/**
 * Everything Claude changed that the user has not decided on yet, as the
 * blocks that differ from the baselines in the store. The store and the files
 * are the truth; nothing here is authoritative, so a window that closes and
 * reopens shows the same blocks.
 */
export class PendingModel implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  /** Fires whenever what is pending may have changed. */
  readonly onDidChange = this.#changed.event;
  readonly #touched = new vscode.EventEmitter<PendingTouch>();
  /** Fires once for each edit of Claude's to a pending file that happens while the model is running. */
  readonly onDidTouch = this.#touched.event;

  readonly #store: Store;
  readonly #log: (message: string) => void;
  readonly #tracked = new Map<string, Tracked>();
  readonly #queue = new KeyedQueue();
  /** Document URI to entry id: the id costs a filesystem lookup and every keystroke asks for it. */
  readonly #ids = new Map<string, string>();
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #dirWatches = new Map<string, { watch: DirectoryWatch | undefined; ids: Set<string> }>();
  readonly #storeSync = new Delayed(() => this.#guard('store sync', () => this.#runStoreSync()), STORE_EVENT_DELAY_MS);
  readonly #storeSyncIds = new Set<string>();
  #storeSyncAll = false;
  #storeWatch: DirectoryWatch | undefined;
  /** Edits found while the model starts are old news: opening a window must not open files. */
  #started = false;
  #disposed = false;

  constructor(store: Store, log: (message: string) => void) {
    this.#store = store;
    this.#log = log;
  }

  start(): void {
    this.#subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.#guard('open', () => this.#onOpen(document))),
      vscode.workspace.onDidCloseTextDocument((document) => this.#guard('close', () => this.#onClose(document))),
      vscode.workspace.onDidChangeTextDocument((event) => this.#guard('change', () => this.#onChange(event))),
      vscode.workspace.onDidSaveTextDocument((document) => this.#guard('save', () => this.#onSave(document))),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.#guard('focus', () => this.#resync());
      }),
    );
    // Entries appearing and going away; what happens inside an entry is watched per entry.
    this.#storeWatch = watchDirectory(this.#store.ensureEntriesDir(), (name) => this.#onStoreEvent(name));
    this.#syncAll();
    this.#started = true;
  }

  /** Files with something to decide, in path order. */
  files(): readonly PendingFile[] {
    return [...this.#tracked.values()]
      .flatMap((tracked) => (tracked.view !== undefined && tracked.view.state.pending > 0 ? [tracked.view] : []))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  fileForUri(uri: vscode.Uri): PendingFile | undefined {
    const id = this.#idOf(uri);
    return id === null ? undefined : this.fileById(id);
  }

  fileById(id: string): PendingFile | undefined {
    const view = this.#tracked.get(id)?.view;
    return view !== undefined && view.state.pending > 0 ? view : undefined;
  }

  /**
   * The text of the file as it was before Claude's first change, moved forward
   * by every Keep. Empty for a file Claude created, and undefined when there is
   * no baseline that can be read as text.
   */
  baselineOf(id: string): string | undefined {
    const tracked = this.#tracked.get(id);
    if (tracked === undefined) return undefined;
    if (!tracked.existed) return '';
    return tracked.baseDoc === null ? undefined : printDoc(tracked.baseDoc);
  }

  /** Blocks and files in `files`, which defaults to everything pending. */
  counts(files: readonly PendingFile[] = this.files()): { pending: number; files: number } {
    return { pending: files.reduce((sum, file) => sum + file.state.pending, 0), files: files.length };
  }

  /** Re-reads the store and every pending file now, for tests and for the user's "refresh". */
  async refreshAll(): Promise<void> {
    this.#storeSync.cancel();
    this.#syncAll();
    await Promise.all([...this.#tracked.values()].map((tracked) => this.#queue.run(tracked.id, () => this.#refreshNow(tracked))));
  }

  keepBlock(id: string, wanted: Block): Promise<OpResult> {
    return this.#locked(id, async (tracked) => {
      const snapshot = await this.#snapshot(tracked);
      const block = findBlock(snapshot.state.blocks, wanted);
      if (snapshot.state.granularity !== 'blocks' || block === undefined) return CHANGED;
      // Created and deleted files are one block, the file; keeping the last block leaves nothing to decide.
      if (snapshot.state.situation !== 'edited' || snapshot.state.blocks.length === 1) return this.#keepFileLocked(tracked);

      return this.#adoptBaseline(tracked, keepBlock(snapshot.state.base!, snapshot.state.cur!, block));
    });
  }

  /**
   * Keeps only the selected lines of the blocks `wanted` picks (see `keepParts`); the rest of each block stays
   * pending. Refused when the file no longer has the blocks the lines were picked in: the picks are line numbers,
   * and in a text that moved on they would be other lines.
   */
  keepParts(id: string, wanted: readonly BlockPart[]): Promise<OpResult> {
    return this.#locked(id, async (tracked) => {
      const { state } = await this.#snapshot(tracked);
      if (state.situation !== 'edited' || state.granularity !== 'blocks') return CHANGED;
      if (wanted.some((part) => findBlock(state.blocks, part.block) === undefined)) return CHANGED;

      const base = keepParts(state.base!, state.cur!, wanted);
      // Everything that was pending got kept: the file is settled, as when its last block is kept.
      if (computeBlocks(base, state.cur!).length === 0) return this.#keepFileLocked(tracked);
      return this.#adoptBaseline(tracked, base);
    });
  }

  keepFile(id: string): Promise<OpResult> {
    return this.#locked(id, async (tracked) => this.#keepFileLocked(tracked));
  }

  discardBlock(id: string, wanted: Block): Promise<OpResult> {
    return this.#locked(id, async (tracked) => {
      const snapshot = await this.#snapshot(tracked);
      const { state } = snapshot;
      const block = findBlock(state.blocks, wanted);
      if (state.granularity !== 'blocks' || block === undefined) return CHANGED;
      if (state.situation !== 'edited') return this.#discardFileLocked(tracked, snapshot);

      const edit = discardEdit(state.base!, state.cur!, block);
      const document = this.#openDocument(tracked);
      let result: OpResult;
      if (document !== undefined) {
        result = await this.#discardInEditor(tracked, document, snapshot, edit);
      } else {
        result = await this.#discardOnDisk(tracked, snapshot, edit);
      }
      if (!result.ok) return result;

      this.#recordDiscard(tracked, 'block', `${blockLabel(block)} at line ${anchorLine(block, state.cur!.lines.length) + 1}`);
      await this.#refreshNow(tracked);
      this.#removeIfSettled(tracked);
      return ok;
    });
  }

  discardFile(id: string): Promise<OpResult> {
    return this.#locked(id, async (tracked) => this.#discardFileLocked(tracked, await this.#snapshot(tracked)));
  }

  keepFiles(ids: readonly string[]): Promise<OpResult> {
    return this.#each(ids, (id) => this.keepFile(id));
  }

  discardFiles(ids: readonly string[]): Promise<OpResult> {
    return this.#each(ids, (id) => this.discardFile(id));
  }

  /** Stops watching. */
  dispose(): void {
    // A late store event or refreshAll() must not load entries, and start watching their files, in a closed model.
    this.#disposed = true;
    for (const tracked of [...this.#tracked.values()]) {
      tracked.refresh.cancel();
      tracked.cleanup.cancel();
      tracked.entryWatch?.close();
    }
    this.#storeSync.cancel();
    this.#storeWatch?.close();
    for (const { watch } of this.#dirWatches.values()) watch?.close();
    this.#dirWatches.clear();
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#changed.dispose();
    this.#touched.dispose();
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  #locked(id: string, operation: (tracked: Tracked) => Promise<OpResult>): Promise<OpResult> {
    return this.#queue.run(id, async () => {
      const tracked = this.#tracked.get(id);
      return tracked === undefined ? GONE : operation(tracked);
    });
  }

  /** One file after another, so that a problem with one does not stop the rest. */
  async #each(ids: readonly string[], operation: (id: string) => Promise<OpResult>): Promise<OpResult> {
    const problems: string[] = [];
    for (const id of ids) {
      const name = basename(this.#tracked.get(id)?.path ?? id);
      const result = await operation(id);
      if (!result.ok) problems.push(`${name}: ${result.reason}`);
    }
    return problems.length === 0 ? ok : refuse(problems.join('\n'));
  }

  /** Makes `base` the file's baseline: what the user kept is no longer pending. */
  async #adoptBaseline(tracked: Tracked, base: Doc): Promise<OpResult> {
    const bytes = encodeText(printDoc(base), tracked.bom);
    // Another window may have kept or discarded everything, and Claude may have started a new entry for the file
    // since; writing our baseline over that one would hide Claude's newer edits as if they were the user's.
    const meta = this.#store.readMeta(tracked.id);
    if (meta === null || meta.createdAt !== tracked.createdAt || !this.#store.writeBase(tracked.id, bytes)) {
      this.#drop(tracked);
      this.#syncOne(tracked.id);
      return CHANGED;
    }
    tracked.stored = bytes;
    tracked.baseDoc = base;
    await this.#refreshNow(tracked);
    return ok;
  }

  #keepFileLocked(tracked: Tracked): OpResult {
    this.#remove(tracked);
    return ok;
  }

  async #discardFileLocked(tracked: Tracked, snapshot: Snapshot): Promise<OpResult> {
    const { state } = snapshot;
    let result: OpResult;
    if (state.situation === 'created') {
      result = await this.#deleteCreatedFile(tracked);
    } else if (state.situation === 'deleted') {
      result = await this.#restoreOnDisk(tracked);
    } else {
      const document = this.#openDocument(tracked);
      result = document !== undefined ? await this.#restoreInEditor(tracked, document) : await this.#restoreOnDisk(tracked);
    }
    if (!result.ok) return result;

    this.#recordDiscard(tracked, 'file');
    if (state.situation === 'created') {
      this.#remove(tracked);
    } else {
      await this.#refreshNow(tracked);
      this.#removeIfSettled(tracked);
    }
    return ok;
  }

  async #discardInEditor(tracked: Tracked, document: vscode.TextDocument, snapshot: Snapshot, edit: ReturnType<typeof discardEdit>): Promise<OpResult> {
    const before = document.getText();
    const { current } = snapshot;
    if (current === null || !('text' in current) || current.text !== before) return CHANGED;

    const wasDirty = document.isDirty;
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, new vscode.Range(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter), edit.newText);
    // VS Code refuses an edit made against a version of the document that is no longer current.
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) return CHANGED;
    return wasDirty ? ok : saveDocument(document);
  }

  async #discardOnDisk(tracked: Tracked, snapshot: Snapshot, edit: ReturnType<typeof discardEdit>): Promise<OpResult> {
    const current = snapshot.current;
    if (current === null || !('bytes' in current)) return CHANGED;
    const decoded = decodeText(current.bytes);
    if (decoded === null) return CHANGED;

    const latest = await readFile(tracked.path).catch(() => null);
    if (latest === null || !latest.equals(current.bytes)) return CHANGED;
    await writeFile(tracked.path, encodeText(applyLineEdit(decoded.text, edit), decoded.bom));
    return ok;
  }

  /** Puts the file back to its baseline in the editor, so that undo brings the changes back. */
  async #restoreInEditor(tracked: Tracked, document: vscode.TextDocument): Promise<OpResult> {
    const decoded = tracked.stored === null ? null : decodeText(tracked.stored);
    if (decoded === null) return this.#restoreOnDisk(tracked);

    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const after = decoded.text.replace(/\r\n|\r|\n/g, eol);
    const wasDirty = document.isDirty;
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0)), after);
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) return CHANGED;
    return wasDirty ? ok : saveDocument(document);
  }

  async #restoreOnDisk(tracked: Tracked): Promise<OpResult> {
    if (tracked.stored === null) return refuse('There is no earlier version of this file to go back to.');
    await mkdir(dirname(tracked.path), { recursive: true });
    await writeFile(tracked.path, tracked.stored);
    return ok;
  }

  async #deleteCreatedFile(tracked: Tracked): Promise<OpResult> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText && this.#idOf(tab.input.uri) === tracked.id);
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
    try {
      await vscode.workspace.fs.delete(tracked.uri, { useTrash: true });
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return ok;
      return refuse(`Could not move ${basename(tracked.path)} to the trash: ${describe(error)}`);
    }
    return ok;
  }

  #recordDiscard(tracked: Tracked, scope: 'block' | 'file', detail?: string): void {
    this.#guard('discard record', () => this.#store.appendDiscard({ path: tracked.path, scope, ...(detail === undefined ? {} : { detail }) }));
  }

  // ---- state ------------------------------------------------------------------------------------------------------

  async #snapshot(tracked: Tracked): Promise<Snapshot> {
    const current = await this.#readCurrent(tracked);
    const state = computeState({ path: tracked.path, existed: tracked.existed, baseline: tracked.stored, current });
    return { state, current };
  }

  /**
   * What the file is now. The editor's text stands in for the disk when the
   * baseline can be compared as text, so unsaved edits count; a file that is
   * only compared as a whole is compared on disk, where its bytes are.
   */
  async #readCurrent(tracked: Tracked): Promise<Current> {
    if (!(await exists(tracked.path))) return null;
    const document = this.#openDocument(tracked);
    if (document !== undefined && (!tracked.existed || tracked.baseDoc !== null)) return { text: document.getText() };
    return readFile(tracked.path).then(
      (bytes) => ({ bytes }),
      (error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      },
    );
  }

  async #refreshNow(tracked: Tracked): Promise<void> {
    if (this.#tracked.get(tracked.id) !== tracked) return;
    const { state } = await this.#snapshot(tracked);
    if (this.#tracked.get(tracked.id) !== tracked) return;

    const previous = tracked.view?.state;
    tracked.view = { id: tracked.id, path: tracked.path, uri: tracked.uri, state, sessionDirs: tracked.sessionDirs, createdAt: tracked.createdAt };
    if (state.pending === 0) tracked.cleanup.trigger();
    else tracked.cleanup.cancel();
    if (previous === undefined || !sameShape(previous, state)) this.#changed.fire();
  }

  #scheduleRefresh(tracked: Tracked): void {
    tracked.refresh.trigger();
  }

  /**
   * Forgets a file that has nothing left to decide, once the disk agrees. The
   * check and the removal are synchronous so that nothing can write the file
   * in between.
   */
  #removeIfSettled(tracked: Tracked): boolean {
    if (this.#tracked.get(tracked.id) !== tracked) return false;
    let bytes: Buffer | null;
    try {
      bytes = readFileSync(tracked.path);
    } catch (error) {
      if (!isMissing(error)) return false;
      bytes = null;
    }
    const state = computeState({
      path: tracked.path,
      existed: tracked.existed,
      baseline: tracked.stored,
      current: bytes === null ? null : { bytes },
    });
    if (state.pending !== 0) return false;
    this.#remove(tracked);
    return true;
  }

  #remove(tracked: Tracked): void {
    this.#store.removeEntry(tracked.id);
    this.#drop(tracked);
  }

  // ---- loading and following the store ----------------------------------------------------------------------------

  #syncAll(): void {
    const ids = new Set<string>();
    for (const meta of this.#store.listEntries()) {
      ids.add(meta.id);
      this.#syncOne(meta.id);
    }
    for (const tracked of [...this.#tracked.values()]) {
      if (!ids.has(tracked.id)) this.#drop(tracked);
    }
  }

  /** Brings one entry up to date with the store: new, gone, replaced, or its baseline changed by another window. */
  #syncOne(id: string): void {
    if (this.#disposed) return;
    const entry = this.#store.readEntry(id);
    const tracked = this.#tracked.get(id);
    if (entry === null) {
      if (tracked !== undefined) this.#drop(tracked);
      return;
    }
    if (tracked === undefined) {
      this.#noteTouch(this.#load(entry, null), true);
      return;
    }
    if (tracked.createdAt !== entry.createdAt || !sameBytes(tracked.stored, entry.base)) {
      // Another createdAt is a new entry for the file, which Claude made; a baseline that changed alone is a Keep elsewhere.
      const isNewEntry = tracked.createdAt !== entry.createdAt;
      this.#drop(tracked);
      this.#noteTouch(this.#load(entry, isNewEntry ? null : tracked.touchedBy), isNewEntry);
      return;
    }
    if (!sameStrings(tracked.sessionDirs, entry.sessionDirs)) {
      // Not part of the state, which is all `#refreshNow` announces, so it is announced here.
      tracked.sessionDirs = entry.sessionDirs;
      if (tracked.view !== undefined) tracked.view = { ...tracked.view, sessionDirs: entry.sessionDirs };
      this.#changed.fire();
    }
    this.#noteTouch(tracked, false);
  }

  /**
   * Reports an edit of Claude's that has not been reported: the store's record
   * names another edit than the last one seen, or the entry is new and has no
   * record (made by the shell, or by a plugin copy that predates records). A
   * record that cannot be read counts as none, so a hint never stops syncing.
   */
  #noteTouch(tracked: Tracked, isNewEntry: boolean): void {
    const touch = this.#store.readTouch(tracked.id);
    const unreported = touch === null ? isNewEntry : touch.tool !== tracked.touchedBy;
    if (touch !== null) tracked.touchedBy = touch.tool;
    if (unreported && this.#started) this.#touched.fire({ id: tracked.id, line: touch?.line ?? 0 });
  }

  #load(entry: StoreEntry, touchedBy: string | null): Tracked {
    const text = baselineText(entry.path, entry.base);
    const tracked: Tracked = {
      id: entry.id,
      path: entry.path,
      uri: vscode.Uri.file(entry.path),
      existed: entry.existed,
      createdAt: entry.createdAt,
      stored: entry.base,
      touchedBy,
      sessionDirs: entry.sessionDirs,
      entryWatch: watchDirectory(this.#store.entryDir(entry.id), (name) => this.#onStoreEvent(name === null ? null : entry.id)),
      baseDoc: text === null ? null : parseDoc(text.text),
      bom: text?.bom ?? false,
      document: vscode.workspace.textDocuments.find((candidate) => candidate.uri.scheme === 'file' && this.#idOf(candidate.uri) === entry.id),
      view: undefined,
      refresh: new Delayed(() => this.#enqueueRefresh(tracked), REFRESH_DELAY_MS),
      cleanup: new Delayed(() => this.#enqueueCleanup(tracked), CLEANUP_DELAY_MS),
    };
    this.#tracked.set(tracked.id, tracked);
    this.#watchFile(tracked);
    this.#enqueueRefresh(tracked);
    return tracked;
  }

  #drop(tracked: Tracked): void {
    if (this.#tracked.get(tracked.id) !== tracked) return;
    tracked.refresh.cancel();
    tracked.cleanup.cancel();
    tracked.entryWatch?.close();
    this.#unwatchFile(tracked);
    this.#tracked.delete(tracked.id);
    this.#changed.fire();
  }

  #enqueueRefresh(tracked: Tracked): void {
    void this.#queue.run(tracked.id, () => this.#refreshNow(tracked)).catch((error: unknown) => this.#report('refresh', error));
  }

  #enqueueCleanup(tracked: Tracked): void {
    void this.#queue.run(tracked.id, async () => this.#removeIfSettled(tracked)).catch((error: unknown) => this.#report('cleanup', error));
  }

  #onStoreEvent(name: string | null): void {
    const id = name?.split(sep)[0];
    if (id !== undefined && ENTRY_ID.test(id)) this.#storeSyncIds.add(id);
    else this.#storeSyncAll = true;
    this.#storeSync.trigger();
  }

  #runStoreSync(): void {
    const everything = this.#storeSyncAll;
    const ids = [...this.#storeSyncIds];
    this.#storeSyncAll = false;
    this.#storeSyncIds.clear();
    if (everything) this.#syncAll();
    else for (const id of ids) this.#syncOne(id);
  }

  /** Looks again at everything, for moments when a watcher may have missed something. */
  #resync(): void {
    this.#syncAll();
    for (const tracked of this.#tracked.values()) {
      this.#watchFile(tracked);
      this.#scheduleRefresh(tracked);
    }
  }

  // ---- files and documents ----------------------------------------------------------------------------------------

  #watchFile(tracked: Tracked): void {
    const dir = dirname(tracked.path);
    let entry = this.#dirWatches.get(dir);
    if (entry === undefined) {
      entry = { watch: undefined, ids: new Set() };
      this.#dirWatches.set(dir, entry);
    }
    entry.ids.add(tracked.id);
    entry.watch ??= watchDirectory(dir, (name) => this.#onFileEvent(dir, name));
  }

  #unwatchFile(tracked: Tracked): void {
    const dir = dirname(tracked.path);
    const entry = this.#dirWatches.get(dir);
    if (entry === undefined) return;
    entry.ids.delete(tracked.id);
    if (entry.ids.size === 0) {
      entry.watch?.close();
      this.#dirWatches.delete(dir);
    }
  }

  #onFileEvent(dir: string, name: string | null): void {
    for (const id of this.#dirWatches.get(dir)?.ids ?? []) {
      const tracked = this.#tracked.get(id);
      if (tracked !== undefined && (name === null || basename(tracked.path) === name)) this.#scheduleRefresh(tracked);
    }
  }

  /** The id of the entry a document would belong to, or null for anything that is not a local file. */
  #idOf(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') return null;
    const key = uri.toString();
    const known = this.#ids.get(key);
    if (known !== undefined) return known;
    try {
      const id = this.#store.idFor(uri.fsPath);
      this.#ids.set(key, id);
      return id;
    } catch {
      // A failure (permissions, I/O) may pass, so it is not remembered.
      return null;
    }
  }

  #trackedFor(document: vscode.TextDocument): Tracked | undefined {
    const id = this.#idOf(document.uri);
    return id === null ? undefined : this.#tracked.get(id);
  }

  #openDocument(tracked: Tracked): vscode.TextDocument | undefined {
    return tracked.document !== undefined && !tracked.document.isClosed ? tracked.document : undefined;
  }

  #onOpen(document: vscode.TextDocument): void {
    const tracked = this.#trackedFor(document);
    if (tracked === undefined || tracked.document === document) return;
    tracked.document = document;
    this.#scheduleRefresh(tracked);
  }

  #onClose(document: vscode.TextDocument): void {
    this.#ids.delete(document.uri.toString());
    const tracked = this.#trackedFor(document);
    if (tracked === undefined || tracked.document !== document) return;
    tracked.document = undefined;
    this.#scheduleRefresh(tracked);
  }

  #onChange(event: vscode.TextDocumentChangeEvent): void {
    const tracked = this.#trackedFor(event.document);
    if (tracked === undefined) return;
    tracked.document = event.document;
    this.#scheduleRefresh(tracked);
  }

  /** Saving changes no block, but it can bring the disk in line with a text that already matches the baseline; only then can the file be forgotten. */
  #onSave(document: vscode.TextDocument): void {
    const tracked = this.#trackedFor(document);
    if (tracked === undefined) return;
    tracked.document = document;
    this.#scheduleRefresh(tracked);
  }

  // ---- errors -----------------------------------------------------------------------------------------------------

  /** Event handlers must not throw into the editor; the failure is logged where the hooks log theirs. */
  #guard(context: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#report(context, error);
    }
  }

  #report(context: string, error: unknown): void {
    this.#log(`${context}: ${describe(error)}`);
    this.#store.logError(`extension ${context}`, error);
  }
}

interface Snapshot {
  readonly state: FileState;
  readonly current: Current;
}

async function saveDocument(document: vscode.TextDocument): Promise<OpResult> {
  return (await document.save()) ? ok : refuse(`Could not save ${basename(document.uri.fsPath)}. The change is in the editor; save it to finish.`);
}

/** Whether the pending view of a file would look different, which is when the editors and lists need redrawing. */
function sameShape(a: FileState, b: FileState): boolean {
  return (
    a.situation === b.situation &&
    a.granularity === b.granularity &&
    a.pending === b.pending &&
    a.blocks.length === b.blocks.length &&
    a.blocks.every((block, index) => {
      const other = b.blocks[index]!;
      return (
        block.kind === other.kind &&
        block.baseStart === other.baseStart &&
        block.baseEnd === other.baseEnd &&
        block.curStart === other.curStart &&
        block.curEnd === other.curEnd
      );
    })
  );
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
