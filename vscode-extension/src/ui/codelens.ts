import * as vscode from 'vscode';
import { BAR_LABELS, counterText } from '../inset-html.ts';
import { reviewOrder } from '../nav.ts';
import type { PendingFile, PendingModel } from '../pending.ts';
import { lensPlan } from '../present.ts';
import type { BlockTarget, FileTarget } from '../targets.ts';
import type { Insets } from './insets.ts';
import { visible } from './scope.ts';

/**
 * The bar above every pending block, in the words of the inset's bar:
 * "1 of 2 | Discard | Keep | Diff". It stands in where an inset cannot be drawn, so
 * a block that has an inset has no lens. Above the first line of the file is also the file bar,
 * which is never an inset: where this file is among the pending ones, and what to do with all of it.
 */
export class PendingCodeLenses implements vscode.CodeLensProvider, vscode.Disposable {
  readonly #model: PendingModel;
  readonly #insets: Insets;
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.#changed.event;
  readonly #subscriptions: vscode.Disposable[];

  constructor(model: PendingModel, insets: Insets) {
    this.#model = model;
    this.#insets = insets;
    this.#subscriptions = [model.onDidChange(() => this.#changed.fire()), insets.onDidChangeCoverage(() => this.#changed.fire())];
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const file = this.#model.fileForUri(document.uri);
    if (file === undefined) return [];
    return [...this.#fileBar(file), ...this.#blockBars(file, document)];
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#changed.dispose();
  }

  /**
   * "‹ File 2 of 5 › | Discard file | Keep file Ctrl+Enter | Review Next File →", on the first line. The count and the
   * way on are left out for the one file this window lists, and for a file it does not list (another project's):
   * neither is a stop on the walk through the files. A file that can only be kept whole has its Discard and
   * Keep on its first line already (see `lensPlan`), so it gets the way on and nothing else.
   */
  #fileBar(file: PendingFile): vscode.CodeLens[] {
    if (file.state.pending === 0) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const whole: FileTarget = { kind: 'file', id: file.id };
    const order = reviewOrder(visible(this.#model.files()));
    const place = order.findIndex((candidate) => candidate.id === file.id);
    const hasWayOn = place !== -1 && order.length > 1;
    const hasOwnBar = file.state.situation !== 'edited' || file.state.granularity === 'file';

    const lens = (title: string, command: string, tooltip?: string, args?: unknown[]) =>
      new vscode.CodeLens(range, { title, command, tooltip, arguments: args });
    return [
      ...(hasWayOn
        ? [
            lens('$(arrow-left)', 'clause.previousFile', 'Review the previous file'),
            // An empty command makes the title plain text rather than a link.
            lens(`File ${place + 1} of ${order.length}`, ''),
            lens('$(arrow-right)', 'clause.nextFile', 'Review the next file'),
          ]
        : []),
      ...(hasOwnBar
        ? []
        : [
            lens('$(discard) Discard file', 'clause.discardFile', 'Discard every pending change in this file: put it back the way it was before Claude', [whole]),
            lens('$(check) Keep file Ctrl+Enter', 'clause.keepFile', 'Keep every pending change in this file', [whole]),
          ]),
      ...(hasWayOn ? [lens('Review Next File $(arrow-right)', 'clause.nextFile', 'Open the next file with pending changes')] : []),
    ];
  }

  #blockBars(file: PendingFile, document: vscode.TextDocument): vscode.CodeLens[] {
    const whole: FileTarget = { kind: 'file', id: file.id };
    const plan = lensPlan(file.state);
    return plan.flatMap(({ line, text, block }, index) => {
      if (block !== undefined && this.#insets.covers(document.uri, block)) return [];

      const at = Math.min(line, document.lineCount - 1);
      const range = new vscode.Range(at, 0, at, 0);
      // A created file, or one that can only be kept whole, has no smaller piece to act on.
      const target: BlockTarget | FileTarget = block !== undefined && file.state.situation === 'edited' ? { kind: 'block', id: file.id, block } : whole;
      const piece = target.kind === 'block' ? 'Block' : 'File';
      // The keys act on the block under the cursor, so only a lens for a block can name them.
      const key = (chord: string) => (block === undefined ? '' : ` ${chord}`);
      const neighbour = (step: number): BlockTarget => ({ kind: 'block', id: file.id, block: plan[(index + step + plan.length) % plan.length]!.block! });
      const pager =
        block !== undefined && plan.length > 1
          ? [
              new vscode.CodeLens(range, { title: '$(arrow-up)', tooltip: 'Go to the previous change', command: 'clause.reveal', arguments: [neighbour(-1)] }),
              new vscode.CodeLens(range, { title: counterText(index + 1, plan.length), command: '' }),
              new vscode.CodeLens(range, { title: '$(arrow-down)', tooltip: 'Go to the next change', command: 'clause.reveal', arguments: [neighbour(1)] }),
            ]
          : [];
      return [
        // An empty command makes the title plain text rather than a link.
        new vscode.CodeLens(range, { title: text, command: '' }),
        ...pager,
        new vscode.CodeLens(range, {
          title: `$(discard) ${BAR_LABELS.discard}${key(BAR_LABELS.discardKey)}`,
          tooltip: 'Discard this change: put the lines back the way they were before it',
          command: `clause.discard${piece}`,
          arguments: [target],
        }),
        new vscode.CodeLens(range, {
          title: `$(check) ${BAR_LABELS.keep}${key(BAR_LABELS.keepKey)}`,
          tooltip: 'Keep these changes: they become part of the file as far as this review goes',
          command: `clause.keep${piece}`,
          arguments: [target],
        }),
        new vscode.CodeLens(range, { title: '$(diff) Diff', tooltip: 'Compare the file with how it was before Claude', command: 'clause.openDiff', arguments: [whole] }),
      ];
    });
  }
}
