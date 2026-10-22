import * as vscode from 'vscode';
import { countsText, statusText } from '../nav.ts';
import type { PendingModel } from '../pending.ts';
import { scopedCounts } from './scope.ts';

/**
 * The status bar entries and the view's badge and heading: how much is waiting for a decision, and a button that
 * goes to the next file to review. The button lives here because the status bar is on screen wherever the user is,
 * with no editor open too, where the arrows in an editor's title are not. The badge counts files, as git's does,
 * so a few big edits do not read as a lot of files; the tooltip and the heading give the changes as well.
 */
export class Summary implements vscode.Disposable {
  readonly #model: PendingModel;
  readonly #item = vscode.window.createStatusBarItem('clause.status', vscode.StatusBarAlignment.Left, 100);
  readonly #review = vscode.window.createStatusBarItem('clause.review', vscode.StatusBarAlignment.Left, 99);
  readonly #view: vscode.TreeView<unknown>;
  readonly #subscription: vscode.Disposable;

  constructor(model: PendingModel, view: vscode.TreeView<unknown>) {
    this.#model = model;
    this.#view = view;
    this.#item.name = 'Clause';
    this.#item.command = 'clause.focus';
    this.#item.tooltip = 'Pending changes that you have not kept or discarded. Click to review them.';
    this.#review.name = 'Clause: Review Next File';
    this.#review.text = '$(arrow-right) Review Next File';
    this.#review.command = 'clause.nextFile';
    this.#review.tooltip = 'Open the next file with pending changes (Alt+L)';
    this.#review.accessibilityInformation = { label: 'Review next file with pending changes', role: 'button' };
    this.#subscription = model.onDidChange(() => this.update());
    this.update();
  }

  /** The text shown, or undefined while nothing is pending, for tests. */
  get text(): string | undefined {
    return scopedCounts(this.#model).pending === 0 ? undefined : this.#item.text;
  }

  /** The Review Next File button's text and command, or undefined while it is hidden, for tests. */
  get reviewButton(): { text: string; command: string } | undefined {
    return scopedCounts(this.#model).pending === 0 ? undefined : { text: this.#review.text, command: String(this.#review.command) };
  }

  /** The number on the view's badge, or undefined while there is none, for tests. */
  get badge(): number | undefined {
    return this.#view.badge?.value;
  }

  /** The tooltip of the view's badge, for tests. */
  get badgeTooltip(): string | undefined {
    return this.#view.badge?.tooltip;
  }

  /** The text beside the view's title, for tests. */
  get viewDescription(): string | undefined {
    return this.#view.description;
  }

  update(): void {
    const { pending, files } = scopedCounts(this.#model);
    if (pending === 0) {
      this.#item.hide();
      this.#review.hide();
      this.#view.badge = undefined;
      this.#view.description = undefined;
      return;
    }
    this.#item.text = `$(diff) ${statusText(pending, files)}`;
    this.#item.accessibilityInformation = { label: statusText(pending, files) };
    this.#item.show();
    this.#review.show();
    this.#view.badge = { value: files, tooltip: `${countsText(files, pending)} to review` };
    this.#view.description = countsText(files, pending);
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#item.dispose();
    this.#review.dispose();
  }
}
