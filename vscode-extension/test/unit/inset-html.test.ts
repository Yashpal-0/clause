import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  asInsetAction,
  BAR_LABELS,
  counterText,
  escapeHtml,
  INSET_ACTIONS,
  insetHeightInLines,
  insetPage,
  omittedText,
} from '../../src/inset-html.ts';
import type { InsetItem } from '../../src/present.ts';

const BLOCK = { kind: 'changed', baseStart: 1, baseEnd: 3, curStart: 1, curEnd: 2 } as const;

function item(overrides: Partial<InsetItem> = {}): InsetItem {
  return { block: BLOCK, afterLine: 0, rows: ['old one', 'old two'], omitted: 0, position: 1, total: 2, bar: true, ...overrides };
}

const page = (overrides: Partial<InsetItem> = {}, options: { nonce?: string; tabSize?: number } = {}) =>
  insetPage(item(overrides), { nonce: 'abc123', tabSize: 4, ...options });

const rowCount = (html: string) => html.match(/<div class="row[ "]/g)?.length ?? 0;

test('escapeHtml neutralises every character that can open markup or end an attribute', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('each removed line is one row, and its text cannot become markup', () => {
  const html = page({ rows: ['<img src=x onerror=alert(1)>', 'a & b', '</script><script>boom()</script>'] });
  assert.equal(rowCount(html), 3);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('a &amp; b'));
  assert.ok(!html.includes('<img'), 'no raw tag from the removed text');
  assert.equal(html.match(/<script/g)?.length, 1, 'the only script element is ours');
  assert.equal(html.match(/<\/script>/g)?.length, 1, 'the removed text did not close ours early');
});

test('empty and indented removed lines keep their row', () => {
  const html = page({ rows: ['', '\tindented'] });
  assert.equal(rowCount(html), 2);
  assert.ok(html.includes('\tindented'));
});

test('a block with nothing removed is a bar and no rows', () => {
  const html = page({ rows: [] });
  assert.equal(rowCount(html), 0);
  assert.ok(html.includes('data-action="keep"'), 'the bar is there');
  assert.ok(!html.includes('class="rows"'), 'no empty group for a screen reader to announce');
});

test('an inset that holds only rows has no bar, no buttons and no script', () => {
  const html = page({ bar: false });
  assert.equal(rowCount(html), 2);
  assert.ok(!html.includes('class="bar'), 'no bar row');
  assert.ok(!html.includes('data-action'), 'no buttons');
  assert.ok(!html.includes('<script'), 'nothing to listen for and no counter to update');
});

test('the bar comes after the rows, so it sits below them', () => {
  const html = page();
  const rows = html.indexOf('class="rows"');
  const bar = html.indexOf('class="bar-row');
  assert.ok(rows !== -1 && bar !== -1, 'both are on the page');
  assert.ok(rows < bar);
});

test('a bar under added lines has their green; a bar under removed rows stays plain', () => {
  assert.ok(page({ rows: [] }).includes('class="bar-row added"'));
  assert.ok(page({ rows: ['a'] }).includes('class="bar-row"'));
  assert.ok(!page({ rows: ['a'] }).includes('bar-row added'));
});

test('lines past the cap are one closing row that says how many were left out', () => {
  const html = page({ rows: ['a', 'b'], omitted: 3 });
  assert.equal(rowCount(html), 3);
  assert.ok(html.includes(omittedText(3)));
  assert.equal(omittedText(1), '… and 1 more line removed');
  assert.equal(omittedText(3), '… and 3 more lines removed');
});

test('the group of rows is labelled for screen readers with how many lines went, and does not say who removed them', () => {
  // A block can be the user's own edit, so nothing on the page may credit Claude with it.
  assert.ok(page({ rows: ['a'] }).includes('aria-label="1 line removed"'));
  assert.ok(page({ rows: ['a', 'b'], omitted: 8 }).includes('aria-label="10 lines removed"'));
  assert.ok(!page().includes('Claude'));
});

test('the inset is as tall as its rows, plus the bar row when it ends in the bar', () => {
  const barRow = insetHeightInLines({ rows: [], omitted: 0, bar: true });
  assert.equal(insetHeightInLines({ rows: ['a', 'b', 'c'], omitted: 0, bar: false }), 3);
  assert.equal(insetHeightInLines({ rows: ['a', 'b', 'c'], omitted: 9, bar: false }), 4);
  assert.equal(insetHeightInLines({ rows: ['a'], omitted: 0, bar: true }), 1 + barRow);
  assert.equal(insetHeightInLines({ rows: ['a', 'b'], omitted: 3, bar: true }), 3 + barRow);
});

test('the bar row is taller than a text line, so the buttons can be bigger than the words in them', () => {
  // The buttons fill this row, so its height is theirs. A row of one line kept them about as tall as the text;
  // Cursor's are about 1.4 lines tall, and at two lines the bar would stop reading as part of the block.
  const barRow = insetHeightInLines({ rows: [], omitted: 0, bar: true });
  assert.ok(barRow > 1 && barRow < 2, `the bar row is ${barRow} lines`);
});
test('the words on the bar stay at 0.85 of the editor font size: the buttons grow, the text does not', () => {
  const scale = page().match(/\.bar \{[^}]*\bfont-size: calc\(var\(--vscode-editor-font-size\) \* ([\d.]+)\)/)?.[1];
  assert.equal(Number(scale), 0.85);
});
test('the page lays out as many lines as the editor reserves for the inset', () => {
  const cases: Partial<InsetItem>[] = [{}, { bar: false }, { rows: [] }, { rows: ['a'], omitted: 4, bar: false }, { rows: ['a'], omitted: 4 }];
  for (const overrides of cases) {
    const wanted = item(overrides);
    const html = insetPage(wanted, { nonce: 'abc123', tabSize: 4 });
    // The rows and the bar row share the page in proportion to the editor lines each takes.
    const rowLines = Number(html.match(/class="rows"[^>]*style="flex-grow: (\d+)"/)?.[1] ?? 0);
    const barLines = html.includes('class="bar-row') ? Number(html.match(/\.bar-row \{[^}]*\bflex: ([\d.]+) 1 0/)?.[1]) : 0;
    assert.equal(rowLines + barLines, insetHeightInLines(wanted), JSON.stringify(overrides));
  }
});

test('the counter reads "1 of 2"', () => {
  assert.equal(counterText(1, 2), '1 of 2');
  assert.ok(page({ position: 3, total: 7 }).includes('>3 of 7<'));
});

test('the bar says Discard and Keep, each with its key, and never Undo', () => {
  const html = page();
  assert.deepEqual(BAR_LABELS, { discard: 'Discard', keep: 'Keep', discardKey: 'Ctrl+N', keepKey: 'Ctrl+Y' });
  for (const word of Object.values(BAR_LABELS)) assert.ok(html.includes(word), `${word} is on the bar`);
  assert.ok(!html.includes('Undo'));
  assert.ok(html.includes('aria-label="Pending change"'));
  assert.ok(html.includes('aria-label="Previous change"'));
  assert.ok(html.includes('aria-label="Next change"'));
});

test('every action the page can send is one the extension accepts, and has a button', () => {
  const html = page();
  for (const action of INSET_ACTIONS) assert.ok(html.includes(`data-action="${action}"`), `${action} has a button`);
  assert.equal(html.match(/data-action=/g)?.length, INSET_ACTIONS.length);
});

test('only the four known actions are believed, whatever else a page sends', () => {
  for (const action of INSET_ACTIONS) assert.equal(asInsetAction({ type: action }), action);
  for (const other of [undefined, null, 'keep', 7, [], {}, { type: 'delete' }, { type: 'Keep' }, { type: ['keep'] }, { action: 'keep' }]) {
    assert.equal(asInsetAction(other), undefined);
  }
});

test('the page runs only its own script and loads nothing from outside', () => {
  const html = page({}, { nonce: 'n0nce+/=' });
  assert.ok(html.includes(`default-src 'none'`));
  assert.ok(html.includes(`script-src 'nonce-n0nce+/='`));
  assert.ok(html.includes('<script nonce="n0nce+/=">'));
  assert.ok(!/https?:/.test(html), 'no remote address anywhere');
});

test('the page clears the padding the editor gives a webview body, so the rows start at the text column', () => {
  // The editor's default stylesheet for webviews sets `body { padding: 0 20px }`. Seen on screen
  // in VS Code 1.142: without this the red rows start 20px inside the text and stop 20px short.
  assert.match(page(), /html, body \{[^}]*\bmargin: 0;[^}]*\bpadding: 0;/);
});

test('the bar stops short of the editor scrollbar, which is drawn over the right end of the inset', () => {
  // An inset is as wide as the editor, so the vertical scrollbar (14px unless the user resized it) covers
  // its right end, and a bar that reached the end would have the last of Keep under it.
  const padding = page().match(/\.bar-row \{[^}]*\bpadding-right: ([^;}]+)/)?.[1];
  assert.ok(padding !== undefined && /^\d+px$/.test(padding) && parseInt(padding, 10) >= 14, `padding-right is ${padding}: in px, and at least the scrollbar's 14`);
});

test('every extension colour the page asks for is one the manifest defines', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { contributes: { colors: { id: string }[] } };
  const defined = manifest.contributes.colors.map(({ id }) => id);
  const asked = [...new Set([...page().matchAll(/--vscode-clause-(\w+)/g)].map(([, name]) => `clause.${name}`))];
  assert.ok(asked.includes('clause.addedBackground'), 'the bar under added lines is tinted like them');
  for (const id of asked) assert.ok(defined.includes(id), `${id} is defined in the manifest`);
});

test('a nonce that could break out of its attribute is refused', () => {
  for (const nonce of ['', 'a"b', `a'b`, 'a b', 'a<b', 'a\nb']) {
    assert.throws(() => page({}, { nonce }), /nonce/);
  }
});

test('the tab width is a whole number the page can put in its stylesheet', () => {
  assert.ok(page({}, { tabSize: 2 }).includes('tab-size: 2'));
  for (const tabSize of [0, -1, 1.5, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(page({}, { tabSize }).includes('tab-size: 4'), `${tabSize} falls back to 4`);
  }
});

test('the labels shown on the bar are the keys the manifest binds', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; when: string }[] };
  };
  const label = (key: string) => key.split('+').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('+');
  const bound = (command: string) => manifest.contributes.keybindings.filter((binding) => binding.command === command);

  assert.deepEqual(bound('clause.keepBlock').map(({ key }) => label(key)), [BAR_LABELS.keepKey]);
  assert.deepEqual(bound('clause.discardBlock').map(({ key }) => label(key)), [BAR_LABELS.discardKey]);
  for (const command of ['clause.keepBlock', 'clause.discardBlock']) {
    assert.ok(bound(command)[0]!.when.includes('clause.inBlock'), `${command} only fires inside a block`);
  }
});
