import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Block } from '../hunks.ts';
import { asInsetAction, counterText, insetHeightInLines, insetPage } from '../inset-html.ts';
import { anchorLine, findBlock } from '../nav.ts';
import type { PendingModel } from '../pending.ts';
import { insetMatches, insetPlan, type InsetItem } from '../present.ts';
import type { FileState } from '../state.ts';
import type { BlockTarget } from '../targets.ts';

/**
 * Every inset is a webview, which costs memory and start-up time, so only this
 * many blocks per editor get insets (a block that replaced lines has two). A
 * block gets all of its insets or none, so one never has rows without its bar.
 * Blocks past it keep the CodeLens and the red marker.
 */
export const MAX_BLOCKS_WITH_INSETS = 16;

/** What the host says when the editor was not told to let this extension use the proposal. */
const PROPOSAL_NOT_ENABLED = /CANNOT use API proposal/;

const ENABLE_HINT =
  'The editor has not allowed this extension to use the editorInsets proposal, so blocks are marked with CodeLens instead. To get the inline rows and the Keep and Discard bar, add "local.claude-pending-edits" to "enable-proposed-api" in the editor\'s argv.json and restart it.';

/** The counter an inset's page shows. Rows with no bar have no page script to show it in. */
const counterOf = (item: InsetItem) => (item.bar ? counterText(item.position, item.total) : undefined);

/** What a test can see of an inset on screen. */
export interface InsetSnapshot {
  readonly item: InsetItem;
  readonly counter: string | undefined;
  readonly html: string;
}

/** An inset on screen, and what it was drawn from. */
interface Live {
  readonly inset: vscode.WebviewEditorInset;
  /** Kept current while the inset stays, so that its actions aim at the block as it is now. */
  item: InsetItem;
  /** The counter the page shows. */
  counter: string | undefined;
  readonly html: string;
}

/**
 * Cursor's inline review: for every pending block, the lines it removed
 * as rows above the new lines, and below them a bar with the pager, Discard and
 * Keep. It uses VS Code's proposed editorInsets API, so it works only where the
 * editor has been told to allow that; everywhere else the CodeLens and the red
 * marker do the same job.
 *
 * An inset cannot be moved or resized, so a change to where it is or what it
 * shows means making a new one. The model only reports changes after typing
 * pauses, so this does not rebuild webviews per keystroke.
 */
export class Insets implements vscode.Disposable {
  readonly #model: PendingModel;
  readonly #log: (message: string) => void;
  readonly #live = new Map<vscode.TextEditor, Live[]>();
  readonly #coverageChanged = new vscode.EventEmitter<void>();
  /** Fires when a block gains or loses its inset, so that what stands in for the inset can follow. */
  readonly onDidChangeCoverage = this.#coverageChanged.event;
  readonly #subscriptions: vscode.Disposable[];
  readonly #reported = new Set<string>();
  /** Set while a pass runs, so that insets it disposes do not each announce a change. */
  #reconciling = false;
  #unavailable = false;
  #disposed = false;

  constructor(model: PendingModel, log: (message: string) => void) {
    this.#model = model;
    this.#log = log;
    this.#subscriptions = [
      model.onDidChange(() => this.reconcile()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.reconcile()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.reconcile()),
    ];
  }

  /** True once the editor has refused the proposal: no inset can be drawn in this window. */
  get unavailable(): boolean {
    return this.#unavailable;
  }

  /** Brings the insets in line with what is pending and what is on screen. */
  reconcile(): void {
    if (this.#disposed) return;

    this.#reconciling = true;
    let changed = false;
    try {
      const visible = vscode.window.visibleTextEditors;
      // The host already removes an editor's insets when it stops being visible; this keeps the bookkeeping in step.
      for (const editor of [...this.#live.keys()]) {
        if (!visible.includes(editor)) changed = this.#clear(editor) || changed;
      }
      for (const editor of visible) changed = this.#sync(editor) || changed;
    } finally {
      this.#reconciling = false;
    }
    if (changed) this.#coverageChanged.fire();
  }

  /**
   * Whether `block` has an inset in every editor of `uri` that can show one, so
   * that its CodeLens and red marker would only repeat the inset. False when no
   * such editor is on screen.
   */
  covers(uri: vscode.Uri, block: Block): boolean {
    const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri.toString() && this.#eligible(editor));
    return editors.length > 0 && editors.every((editor) => this.#live.get(editor)?.some((live) => findBlock([live.item.block], block) !== undefined) === true);
  }

  /** What is drawn in `editor`, for tests: the host offers no way to look inside an inset. */
  inspect(editor: vscode.TextEditor): readonly InsetSnapshot[] {
    return (this.#live.get(editor) ?? []).map(({ item, counter, html }) => ({ item, counter, html }));
  }

  /** Handles `message` as if the page of the inset at `index` in `editor` had posted it, for tests. */
  deliver(editor: vscode.TextEditor, index: number, message: unknown): Promise<void> {
    const live = this.#live.get(editor)?.[index];
    if (live === undefined) throw new Error(`there is no inset at index ${index}`);
    return this.#act(editor, live, message);
  }

  dispose(): void {
    this.#disposed = true;
    for (const subscription of this.#subscriptions) subscription.dispose();
    for (const lives of this.#live.values()) for (const live of lives) live.inset.dispose();
    this.#live.clear();
    this.#coverageChanged.dispose();
  }

  /**
   * Insets exist for text in the editor area. An editor with no column is
   * embedded in another view, as the two sides of a diff editor are, and a diff
   * already marks what changed. Which documents are tracked is the model's call.
   */
  #eligible(editor: vscode.TextEditor): boolean {
    return editor.viewColumn !== undefined;
  }

  #wanted(editor: vscode.TextEditor): InsetItem[] {
    if (this.#unavailable || !this.#eligible(editor)) return [];
    const file = this.#model.fileForUri(editor.document.uri);
    return file === undefined ? [] : insetPlan(file.state).filter((item) => item.position <= MAX_BLOCKS_WITH_INSETS);
  }

  /** Makes `editor`'s insets match the plan; whether any inset was added or removed. */
  #sync(editor: vscode.TextEditor): boolean {
    const wanted = this.#wanted(editor);
    const spare = [...(this.#live.get(editor) ?? [])];

    // Matching by content, not position, so that keeping one block does not rebuild the insets of the rest.
    const reused = wanted.map((item) => {
      const at = spare.findIndex((live) => insetMatches(live.item, item));
      return at < 0 ? undefined : spare.splice(at, 1)[0];
    });
    for (const live of spare) live.inset.dispose();

    let changed = spare.length > 0;
    const after: Live[] = [];
    wanted.forEach((item, index) => {
      const kept = reused[index];
      if (kept !== undefined) {
        this.#update(kept, item);
        after.push(kept);
        return;
      }
      const created = this.#create(editor, item);
      if (created === undefined) return;
      after.push(created);
      changed = true;
    });

    if (after.length === 0) this.#live.delete(editor);
    else this.#live.set(editor, after);
    return changed;
  }

  #update(live: Live, item: InsetItem): void {
    live.item = item;
    const counter = counterOf(item);
    if (counter === undefined || counter === live.counter) return;
    live.counter = counter;
    // The host refuses a message to an inset it dropped a moment ago, when its editor closed. onDidDispose reports that too, and the next pass draws what is missing.
    void live.inset.webview.postMessage({ type: 'position', text: counter }).then(undefined, () => undefined);
  }

  #create(editor: vscode.TextEditor, item: InsetItem): Live | undefined {
    if (this.#unavailable) return undefined;

    let inset: vscode.WebviewEditorInset;
    try {
      // The plan can be a few milliseconds older than the text, so a line past the end is clamped.
      const line = Math.min(item.afterLine, editor.document.lineCount - 1);
      // Only the bar has a script, for its buttons and counter; rows hold Claude's old file text and run nothing.
      inset = vscode.window.createWebviewTextEditorInset(editor, line, insetHeightInLines(item), { enableScripts: item.bar, localResourceRoots: [] });
    } catch (error) {
      this.#creationFailed(error);
      return undefined;
    }

    const html = insetPage(item, { nonce: randomBytes(16).toString('base64'), tabSize: Number(editor.options.tabSize) });
    const live: Live = { inset, item, counter: counterOf(item), html };
    inset.webview.onDidReceiveMessage((message) => void this.#act(editor, live, message));
    inset.onDidDispose(() => this.#forget(editor, live));
    inset.webview.html = html;
    return live;
  }

  #creationFailed(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (PROPOSAL_NOT_ENABLED.test(reason)) {
      this.#unavailable = true;
      this.#reportOnce(ENABLE_HINT);
    } else {
      this.#reportOnce(`could not draw an inset: ${reason}`);
    }
  }

  /** One line per distinct problem: a failure that repeats on every pass would bury everything else in the log. */
  #reportOnce(message: string): void {
    if (this.#reported.has(message)) return;
    this.#reported.add(message);
    this.#log(message);
  }

  #clear(editor: vscode.TextEditor): boolean {
    const lives = this.#live.get(editor) ?? [];
    for (const live of lives) live.inset.dispose();
    this.#live.delete(editor);
    return lives.length > 0;
  }

  /** The host disposes an inset on its own when its editor closes or is hidden. */
  #forget(editor: vscode.TextEditor, live: Live): void {
    const lives = this.#live.get(editor);
    const rest = lives?.filter((candidate) => candidate !== live);
    if (lives === undefined || rest === undefined || rest.length === lives.length) return;

    if (rest.length === 0) this.#live.delete(editor);
    else this.#live.set(editor, rest);
    if (!this.#reconciling && !this.#disposed) this.#coverageChanged.fire();
  }

  /**
   * What a click on an inset's page does. The page only says which button it
   * was; the block is the one this inset was drawn for, and a block that has
   * changed since is refused by the model like any other stale target.
   */
  async #act(editor: vscode.TextEditor, live: Live, message: unknown): Promise<void> {
    const action = asInsetAction(message);
    const file = this.#model.fileForUri(editor.document.uri);
    if (action === undefined || file === undefined) return;

    try {
      if (action === 'keep' || action === 'discard') {
        const target: BlockTarget = { kind: 'block', id: file.id, block: live.item.block };
        await vscode.commands.executeCommand(action === 'keep' ? 'claudePending.keepBlock' : 'claudePending.discardBlock', target);
      } else {
        this.#moveTo(editor, file.state, live.item.block, action === 'next' ? 1 : -1);
      }
      // The click landed in the page, which now holds the keyboard; hand it back to the text.
      await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    } catch (error) {
      this.#log(`inset action ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Puts the cursor on the block `step` places from `from`, wrapping around at the ends. */
  #moveTo(editor: vscode.TextEditor, state: FileState, from: Block, step: 1 | -1): void {
    const current = findBlock(state.blocks, from);
    if (current === undefined || state.cur === null) return;

    const count = state.blocks.length;
    const neighbour = state.blocks[(state.blocks.indexOf(current) + step + count) % count]!;
    const line = Math.min(anchorLine(neighbour, state.cur.lines.length), editor.document.lineCount - 1);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
