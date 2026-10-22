import type { InsetItem } from './present.ts';

/**
 * The words on the bar. The page and the CodeLens fallback both print them, and
 * a test holds the keys to what the manifest binds, so what a button says is
 * what the key does.
 */
export const BAR_LABELS = { discard: 'Discard', keep: 'Keep', discardKey: 'Ctrl+N', keepKey: 'Ctrl+Y' } as const;

/** What a page may ask for. The extension knows which block the page stands for; the page only says what to do. */
export const INSET_ACTIONS = ['keep', 'discard', 'previous', 'next'] as const;
export type InsetAction = (typeof INSET_ACTIONS)[number];

/** The action a message from a page asks for, or undefined for anything else: a page is not trusted with more. */
export function asInsetAction(message: unknown): InsetAction | undefined {
  if (typeof message !== 'object' || message === null || !('type' in message)) return undefined;
  return INSET_ACTIONS.find((action) => action === message.type);
}

export const counterText = (position: number, total: number) => `${position} of ${total}`;

export const omittedText = (count: number) => `… and ${count} more ${count === 1 ? 'line' : 'lines'} removed`;

/** One row per removed line shown, and a closing row when the rest was left out. */
const rowsDrawn = ({ rows, omitted }: Pick<InsetItem, 'rows' | 'omitted'>) => rows.length + (omitted > 0 ? 1 : 0);

/**
 * The bar's row, in editor lines. The buttons fill it, and it is taller than a text line so they can be
 * bigger than the words in them: Cursor's are about 1.4 lines tall.
 */
export const BAR_ROW_LINES = 1.5;

/** The editor lines an inset takes: its rows, and the bar's row when it ends in the bar. */
export const insetHeightInLines = (item: Pick<InsetItem, 'rows' | 'omitted' | 'bar'>) => rowsDrawn(item) + (item.bar ? BAR_ROW_LINES : 0);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ESCAPES[character]!);

/** base64 or URL-safe base64: nothing that could end the attribute or the policy the nonce is written into. */
const NONCE = /^[A-Za-z0-9+/=_-]+$/;
const DEFAULT_TAB_SIZE = 4;
const MAX_TAB_SIZE = 16;
/**
 * An inset is as wide as the editor, so the editor's vertical scrollbar is drawn over its right end:
 * 14px unless `editor.scrollbar.verticalScrollbarSize` says otherwise. The bar stops this far short of
 * that end, the scrollbar plus the 4px Cursor leaves between its own bar and the scrollbar.
 */
const SCROLLBAR_CLEARANCE_PX = 18;

/**
 * The page for one inset: the lines the block removed as full-width rows, and,
 * when the inset ends in the bar, Cursor's bar at the right end of a row of its
 * own below them. Under the added lines that row takes their green, so the bar
 * reads as the last line of the block; under removed rows it stays plain, as
 * in Cursor. The removed text is file content, so it goes in as text and
 * nothing else, and the page loads nothing from outside.
 */
export function insetPage(item: InsetItem, options: { nonce: string; tabSize: number }): string {
  const { nonce } = options;
  if (!NONCE.test(nonce)) throw new Error('an inset page needs a nonce made of base64 characters');
  const tabSize = Number.isInteger(options.tabSize) && options.tabSize >= 1 && options.tabSize <= MAX_TAB_SIZE ? options.tabSize : DEFAULT_TAB_SIZE;

  const removedCount = item.rows.length + item.omitted;
  const rows = item.rows.map((text) => `<div class="row">${escapeHtml(text)}</div>`);
  if (item.omitted > 0) rows.push(`<div class="row note">${escapeHtml(omittedText(item.omitted))}</div>`);
  // flex-grow = the rows' share of the page's lines, one each; the bar's row below them takes BAR_ROW_LINES.
  const group =
    rows.length === 0
      ? ''
      : `<div class="rows" role="group" aria-label="${removedCount} ${removedCount === 1 ? 'line' : 'lines'} removed" style="flex-grow: ${rows.length}">${rows.join('')}</div>`;

  const chevron = (points: string) =>
    `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="${points}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // The script exists only to serve the bar's buttons and counter, so an inset of rows alone runs none.
  const bar = item.bar
    ? `<div class="bar-row${rows.length === 0 ? ' added' : ''}">
<div class="bar" role="group" aria-label="Pending change">
<div class="pager"><button data-action="previous" aria-label="Previous change">${chevron('M3.5 10.5 8 6l4.5 4.5')}</button><span class="count">${counterText(item.position, item.total)}</span><button data-action="next" aria-label="Next change">${chevron('M3.5 5.5 8 10l4.5-4.5')}</button></div>
<button class="discard" data-action="discard">${BAR_LABELS.discard} <span class="key">${BAR_LABELS.discardKey}</span></button>
<button class="keep" data-action="keep">${BAR_LABELS.keep} <span class="key">${BAR_LABELS.keepKey}</span></button>
</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action }));
}
const count = document.querySelector('.count');
window.addEventListener('message', ({ data }) => {
  if (data && data.type === 'position' && typeof data.text === 'string') count.textContent = data.text;
});
</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
body {
  display: flex;
  flex-direction: column;
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  font-weight: var(--vscode-editor-font-weight);
}
.rows { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.row {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  white-space: pre;
  overflow: hidden;
  tab-size: ${tabSize};
  background: var(--vscode-clause-removedBackground, #98044040);
}
.note { font-style: italic; color: var(--vscode-descriptionForeground); }
.bar-row { flex: ${BAR_ROW_LINES} 1 0; min-height: 0; box-sizing: border-box; display: flex; justify-content: flex-end; padding-right: ${SCROLLBAR_CLEARANCE_PX}px; }
.bar-row.added { background: var(--vscode-clause-addedBackground, #388d5b40); }
/* The buttons fill the row less 2px above and below, which keeps them off the rows above and the line below. */
.bar {
  box-sizing: border-box;
  padding: 2px 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  font-family: var(--vscode-font-family);
  font-size: calc(var(--vscode-editor-font-size) * 0.85);
  white-space: nowrap;
}
.bar > * { border-radius: 3px; display: flex; align-items: center; }
button {
  font: inherit;
  color: inherit;
  margin: 0;
  padding: 0 0.9em;
  border: 0;
  gap: 0.4em;
  cursor: pointer;
}
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pager {
  padding: 0 0.2em;
  gap: 0.2em;
  background: var(--vscode-editorWidget-background, #2d2d2d);
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
}
.pager button { padding: 0 0.45em; height: 100%; background: transparent; color: var(--vscode-descriptionForeground); }
.pager button:hover { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); }
.discard {
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, #454545));
}
.keep { background: var(--vscode-clause-keepBackground, #388d5b); color: var(--vscode-clause-keepForeground, #101010); }
.keep:hover { filter: brightness(1.1); }
.key { opacity: 0.75; }
</style>
</head>
<body>
${group}${bar}
</body>
</html>
`;
}
