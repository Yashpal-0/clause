import * as vscode from 'vscode';
import type { PendingModel } from '../pending.ts';
import { decorationPlan, fenced, type DecorationPlan, type Excerpt, type RemovedGap } from '../present.ts';
import type { Insets } from './insets.ts';

const NOTHING: DecorationPlan = { added: [], removed: [] };

/**
 * Marks pending changes in every visible editor: added and rewritten
 * lines are tinted, and a rule with a count stands where lines were removed.
 * Meaning is also carried by the CodeLens and the hover, not by colour alone.
 * Where a block has an inset, the inset shows the removed lines and the rule is
 * left out; only its mark in the overview ruler stays.
 */
export class Decorations implements vscode.Disposable {
  readonly #model: PendingModel;
  readonly #insets: Insets;
  readonly #applied = new WeakMap<vscode.TextEditor, DecorationPlan>();
  readonly #subscriptions: vscode.Disposable[];

  readonly #added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('clause.addedBackground'),
    overviewRulerColor: new vscode.ThemeColor('clause.addedRuler'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  readonly #removedBelow = removedType('none none solid none');
  readonly #removedAbove = removedType('solid none none none');
  readonly #removedRuler = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('clause.removedBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(model: PendingModel, insets: Insets) {
    this.#model = model;
    this.#insets = insets;
    this.#subscriptions = [
      model.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      insets.onDidChangeCoverage(() => this.refresh()),
    ];
    this.refresh();
  }

  /** What was last drawn in `editor` as tints and rules, for tests: decorations cannot be read back from the editor. */
  appliedTo(editor: vscode.TextEditor): DecorationPlan | undefined {
    return this.#applied.get(editor);
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) this.#apply(editor);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#added.dispose();
    this.#removedBelow.dispose();
    this.#removedAbove.dispose();
    this.#removedRuler.dispose();
  }

  #apply(editor: vscode.TextEditor): void {
    const { document } = editor;
    const file = this.#model.fileForUri(document.uri);
    const full = file === undefined ? NOTHING : decorationPlan(file.state);
    const shownAsInset = (gap: RemovedGap) => this.#insets.covers(document.uri, gap.block);
    const plan: DecorationPlan = { added: full.added, removed: full.removed.filter((gap) => !shownAsInset(gap)) };
    this.#applied.set(editor, plan);

    // The plan can be a few milliseconds older than the text: a line past the end is clamped.
    const lastLine = document.lineCount - 1;
    const wholeLines = (from: number, to: number) =>
      new vscode.Range(Math.min(from, lastLine), 0, Math.min(to, lastLine), document.lineAt(Math.min(to, lastLine)).text.length);
    const hint = (title: string, excerpt: Excerpt) => hoverFor(title, excerpt, document.languageId);

    editor.setDecorations(
      this.#added,
      plan.added.map((range) => ({ range: wholeLines(range.startLine, range.endLine), hoverMessage: hint('Replaced:', range.replaced) })),
    );
    const gaps = (edge: 'above' | 'below') =>
      plan.removed
        .filter((gap) => gap.edge === edge)
        .map((gap) => ({
          range: wholeLines(gap.line, gap.line),
          hoverMessage: hint('Removed:', gap.removed),
          renderOptions: {
            after: {
              contentText: `${gap.count} ${gap.count === 1 ? 'line' : 'lines'} removed`,
              color: new vscode.ThemeColor('clause.removedForeground'),
              fontStyle: 'italic',
              margin: '0 0 0 2em',
            },
          },
        }));
    editor.setDecorations(this.#removedBelow, gaps('below'));
    editor.setDecorations(this.#removedAbove, gaps('above'));
    editor.setDecorations(
      this.#removedRuler,
      full.removed.filter(shownAsInset).map((gap) => ({ range: wholeLines(gap.line, gap.line) })),
    );
  }
}

function removedType(borderStyle: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle,
    borderWidth: '1px',
    borderColor: new vscode.ThemeColor('clause.removedBorder'),
    overviewRulerColor: new vscode.ThemeColor('clause.removedBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
}

function hoverFor(title: string, excerpt: Excerpt, languageId: string): vscode.MarkdownString | undefined {
  if (excerpt.lines.length === 0) return undefined;
  const hover = new vscode.MarkdownString();
  hover.appendText(title).appendMarkdown(`\n\n${fenced(excerpt.lines, languageId)}`);
  if (excerpt.omitted > 0) hover.appendMarkdown(`\n\n`).appendText(`… and ${excerpt.omitted} more ${excerpt.omitted === 1 ? 'line' : 'lines'}`);
  return hover;
}
