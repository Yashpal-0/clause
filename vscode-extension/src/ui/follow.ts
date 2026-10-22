import * as vscode from 'vscode';
import { anchorLine, blockToShow } from '../nav.ts';
import type { PendingModel, PendingTouch } from '../pending.ts';
import { whereIs } from './scope.ts';

/**
 * How long after Claude's last edit the editor waits before it opens the file.
 * An open document is reloaded from disk, and its blocks recomputed, a moment
 * after the edit lands; opening sooner would aim at blocks about to change.
 * Measured with real edits: the reload lands within a few ms of the edit being
 * reported and the blocks follow within the 80 ms refresh delay of `pending.ts`
 * (54 ms at most with every CPU busy), so 400 ms is five times the slower lag.
 * Edits that come closer together than this (Claude working through a list of
 * files) end on the last file instead of flicking through each of them.
 */
export const FOLLOW_SETTLE_MS = 400;

/** An editor that changes under your hands while you type costs more than a file you open a few seconds late. */
export const TYPING_IDLE_MS = 3000;

/**
 * Opens the file Claude has just edited, at the block it changed, so that the
 * change can be reviewed without finding the file first. Setting
 * `clause.followEdits` turns it off.
 */
export class Follow implements vscode.Disposable {
  /** Read each time it is used, so a test can shorten both. */
  readonly timing = { settleMs: FOLLOW_SETTLE_MS, typingIdleMs: TYPING_IDLE_MS };

  readonly #model: PendingModel;
  readonly #log: (message: string) => void;
  readonly #subscriptions: vscode.Disposable[];
  /** Only the newest edit is worth showing, so one slot: a new edit replaces one that has not been shown. */
  #wanted: PendingTouch | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastTyping = 0;

  constructor(model: PendingModel, log: (message: string) => void) {
    this.#model = model;
    this.#log = log;
    this.#subscriptions = [
      model.onDidTouch((touch) => this.#onTouch(touch)),
      // A document with unsaved changes is one somebody is typing into; the reload of a file that changed on disk
      // leaves it clean. The event for the first edit of a clean document still says clean, and the event right
      // after it, which has no content changes, says dirty, so the content changes cannot be a condition.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.isDirty) this.#lastTyping = Date.now();
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#wanted = undefined;
    for (const subscription of this.#subscriptions) subscription.dispose();
  }

  #onTouch(touch: PendingTouch): void {
    this.#wanted = touch;
    this.#arm(this.timing.settleMs);
  }

  #arm(delayMs: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#onTimer(), delayMs);
  }

  #onTimer(): void {
    this.#timer = undefined;
    const touch = this.#wanted;
    if (touch === undefined) return;

    // Waiting keeps the edit; dropping it would leave the file unopened for good.
    const untilQuiet = this.#lastTyping + this.timing.typingIdleMs - Date.now();
    if (untilQuiet > 0) {
      this.#arm(untilQuiet);
      return;
    }

    this.#wanted = undefined;
    this.#show(touch).catch((error: unknown) => this.#log(`could not follow an edit: ${error instanceof Error ? error.message : String(error)}`));
  }

  async #show(touch: PendingTouch): Promise<void> {
    // Looked at now, not when the edit was reported: the setting, the file and where it is can all have changed since.
    if (!this.#enabled()) return;
    const file = this.#model.fileById(touch.id);
    // No text, no block to show: the file is gone, or too big or not text to compare by line.
    if (file === undefined || file.state.cur === null || !whereIs(file).inside) return;

    const lineCount = file.state.cur.lines.length;
    const block = blockToShow(file.state.blocks, touch.line, lineCount);
    if (block === undefined) return;
    const line = anchorLine(block, lineCount);

    // A file that is already on screen, in whatever editor, keeps its place in the layout: a diff stays a diff.
    const visible = vscode.window.visibleTextEditors.find((editor) => this.#model.fileForUri(editor.document.uri)?.id === file.id);
    if (visible !== undefined) {
      if (!visible.visibleRanges.some((range) => range.start.line <= line && line <= range.end.line)) goTo(visible, line);
      return;
    }

    // A preview tab is replaced by the next file, so a long run of edits does not leave a tab for each.
    goTo(await vscode.window.showTextDocument(file.uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Active }), line);
  }

  #enabled(): boolean {
    return vscode.workspace.getConfiguration('clause').get<boolean>('followEdits', true);
  }
}

function goTo(editor: vscode.TextEditor, line: number): void {
  const position = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
