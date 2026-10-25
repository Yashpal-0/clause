import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  name: string;
  publisher: string;
  icon?: string;
  dependencies?: Record<string, string>;
  contributes: {
    commands?: { command: string; title: string; category?: string; icon?: string }[];
    menus?: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings?: { command: string; key: string; mac?: string; when?: string }[];
    configuration?: { properties?: Record<string, { type?: string; default?: unknown; description?: string }> };
    colors?: { id: string; description?: string; defaults?: Record<string, string> }[];
  };
}

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Manifest;
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

/** The colours the code asks the theme for: as theme colours in the editor, as CSS variables in the webview. */
function coloursUsed(): Set<string> {
  const used = new Set<string>();
  for (const name of readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(sourceRoot, name), 'utf8');
    for (const match of text.matchAll(/ThemeColor\(\s*'(clause\.[A-Za-z]+)'/g)) used.add(match[1]!);
    for (const match of text.matchAll(/--vscode-clause-([A-Za-z]+)/g)) used.add(`clause.${match[1]}`);
  }
  return used;
}

test('following Claude into the files it edits is a setting, on by default', () => {
  const setting = manifest.contributes.configuration?.properties?.['clause.followEdits'];

  assert.ok(setting !== undefined, 'the manifest declares clause.followEdits');
  assert.equal(setting.type, 'boolean');
  // On is the point of the feature: nobody should have to find the setting to get it.
  assert.equal(setting.default, true);
  assert.ok(setting.description !== undefined && setting.description.length > 0, 'the settings page explains it');
});

test('every colour the code asks the theme for is declared, so that a theme can change it', () => {
  const declared = new Set(manifest.contributes.colors?.map((colour) => colour.id));
  const used = coloursUsed();

  assert.ok(used.size >= 7, `the scan found only ${[...used].join(', ')}; it may be looking in the wrong place`);
  for (const id of used) assert.ok(declared.has(id), `${id} is used in the code but not declared in package.json`);
});

test('the mark in the file tree has a colour of its own, in a hue git does not use', () => {
  const colour = manifest.contributes.colors?.find((candidate) => candidate.id === 'clause.explorerForeground');

  assert.ok(colour !== undefined, 'the manifest declares clause.explorerForeground');
  assert.ok(colour.description !== undefined && colour.description.length > 0, 'the colour settings explain it');
  // Git colours files green, yellow-brown, red, grey and blue. The violet of the charts is a hue none of them has, in every theme kind.
  for (const kind of ['dark', 'light', 'highContrast', 'highContrastLight']) assert.equal(colour.defaults?.[kind], 'charts.purple', kind);
});

const declared = (command: string) => manifest.contributes.commands?.find((candidate) => candidate.command === command);
const inMenu = (menu: string, command: string) => manifest.contributes.menus?.[menu]?.find((item) => item.command === command);
const keyFor = (command: string, key: string) => manifest.contributes.keybindings?.find((binding) => binding.command === command && binding.key === key);

test('every command a menu or a key points at is declared, so that no button or key does nothing', () => {
  const used = [
    ...Object.values(manifest.contributes.menus ?? {}).flat().map((item) => item.command),
    ...(manifest.contributes.keybindings ?? []).map((binding) => binding.command),
  ];

  assert.ok(used.length >= 20, `the scan found only ${used.length} uses; it may be looking in the wrong place`);
  for (const command of used) assert.ok(declared(command) !== undefined, `${command} is used in a menu or key but not declared in package.json`);
});

test('Review Next File and Review Previous File are commands with an arrow each', () => {
  assert.equal(declared('clause.nextFile')?.title, 'Review Next File');
  assert.equal(declared('clause.nextFile')?.icon, '$(arrow-right)');
  assert.equal(declared('clause.previousFile')?.title, 'Review Previous File');
  assert.equal(declared('clause.previousFile')?.icon, '$(arrow-left)');
});

test('the file arrows are in the title of every editor while anything is pending, after the buttons that come and go', () => {
  const previous = inMenu('editor/title', 'clause.previousFile');
  const next = inMenu('editor/title', 'clause.nextFile');

  // `hasPending`, not `fileHasPending`: after the last change of a file is kept the button is still there to move on.
  assert.equal(previous?.when, 'clause.hasPending');
  assert.equal(next?.when, 'clause.hasPending');
  const order = (item: { group?: string } | undefined) => Number(item?.group?.match(/^navigation@(\d+)$/)?.[1]);
  const others = (manifest.contributes.menus?.['editor/title'] ?? []).filter((item) => item !== previous && item !== next);
  for (const item of others) assert.ok(order(item) < order(previous), `${item.command} sits before the arrows, so they never move`);
  assert.ok(order(previous) < order(next), 'previous is left of next');
});

test('the file commands are in the command palette only while something is pending', () => {
  assert.equal(inMenu('commandPalette', 'clause.nextFile')?.when, 'clause.hasPending');
  assert.equal(inMenu('commandPalette', 'clause.previousFile')?.when, 'clause.hasPending');
});

test('Alt+J and Alt+K go to the next and previous change in a file that has pending changes, as in Cursor', () => {
  assert.equal(keyFor('clause.nextBlock', 'alt+j')?.when, 'editorTextFocus && clause.fileHasPending');
  assert.equal(keyFor('clause.previousBlock', 'alt+k')?.when, 'editorTextFocus && clause.fileHasPending');
});

test('Alt+L and Alt+H go to the next and previous file, as in Cursor, and have a chord as well', () => {
  const when = 'editorTextFocus && clause.hasPending';
  assert.equal(keyFor('clause.nextFile', 'alt+l')?.when, when);
  assert.equal(keyFor('clause.previousFile', 'alt+h')?.when, when);
  assert.equal(keyFor('clause.nextFile', 'ctrl+alt+c f')?.when, when);
  assert.equal(keyFor('clause.previousFile', 'ctrl+alt+c shift+f')?.when, when);
});

test('Ctrl+Enter keeps and Ctrl+Shift+Backspace discards the whole file, as in Cursor, and have a chord as well', () => {
  const when = 'editorTextFocus && clause.fileHasPending';
  assert.equal(keyFor('clause.keepFile', 'ctrl+enter')?.when, when);
  assert.equal(keyFor('clause.discardFile', 'ctrl+shift+backspace')?.when, when);
  assert.equal(keyFor('clause.keepFile', 'ctrl+alt+c shift+k')?.when, when);
  assert.equal(keyFor('clause.discardFile', 'ctrl+alt+c shift+d')?.when, when);
});

test('Keep All is in the title of an editor with nothing pending while something elsewhere is, as Cursor offers it in the bar of such a file', () => {
  const keepAll = inMenu('editor/title', 'clause.keepAll');

  assert.equal(declared('clause.keepAll')?.icon, '$(check-all)');
  assert.equal(keepAll?.when, 'clause.hasPending && !clause.fileHasPending');
});

test('the key a tooltip names is the Alt key, not the chord: the editor names the last key declared for a command', () => {
  const named = (command: string) => (manifest.contributes.keybindings ?? []).filter((item) => item.command === command).at(-1)?.key;

  assert.equal(named('clause.nextBlock'), 'alt+j');
  assert.equal(named('clause.previousBlock'), 'alt+k');
  assert.equal(named('clause.nextFile'), 'alt+l');
  assert.equal(named('clause.previousFile'), 'alt+h');
  assert.equal(named('clause.keepFile'), 'ctrl+enter');
  assert.equal(named('clause.discardFile'), 'ctrl+shift+backspace');
});

test('Ctrl+Y keeps the selected lines when the selection has pending lines, and the block otherwise, never both', () => {
  assert.equal(declared('clause.keepSelection')?.title, 'Keep Selected Lines');
  const selection = keyFor('clause.keepSelection', 'ctrl+y');
  const block = keyFor('clause.keepBlock', 'ctrl+y');

  assert.equal(selection?.when, 'editorTextFocus && clause.selectionInPending');
  // Exclusive, so that which of the two runs does not depend on the order the editor tries them in.
  assert.equal(block?.when, 'editorTextFocus && clause.inBlock && !clause.selectionInPending');
});

test('Keep Selected Lines is in the editor menu and the command palette only while the selection has pending lines', () => {
  assert.equal(inMenu('editor/context', 'clause.keepSelection')?.when, 'clause.selectionInPending');
  assert.equal(inMenu('commandPalette', 'clause.keepSelection')?.when, 'clause.selectionInPending');
});

test('the package carries the license of Clause and of every dependency the bundle inlines', () => {
  // The bundle inlines every runtime dependency, and their licenses ask for their notice to go wherever the code goes.
  const kept = readFileSync(new URL('../../.vscodeignore', import.meta.url), 'utf8').split('\n').map((line) => line.trim());
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok(kept.includes(`!${file}`), `.vscodeignore keeps ${file} in the package`);

  const notices = readFileSync(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const dependencies = Object.keys(manifest.dependencies ?? {});
  assert.ok(dependencies.length > 0, 'the scan found no dependencies; it may be looking in the wrong place');
  for (const name of dependencies) assert.ok(notices.includes(`\`${name}\``), `THIRD_PARTY_NOTICES.md has a section for ${name}`);
});

test('the extension icon is a square PNG of at least 128 px that the package keeps', () => {
  // The Marketplace and the Extensions view reject or blur anything else; an SVG is not accepted as the icon.
  assert.equal(manifest.icon, 'images/icon.png');
  const png = readFileSync(new URL(`../../${manifest.icon}`, import.meta.url));

  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'the file is a PNG');
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(width, height, 'the icon is square');
  assert.ok(width >= 128, `the icon is ${width} px wide; the Marketplace wants at least 128`);
  const kept = readFileSync(new URL('../../.vscodeignore', import.meta.url), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(kept.includes(`!${manifest.icon}`), '.vscodeignore keeps the icon in the package');
});

test('the plugin folder ships the same license and icon as the repository', () => {
  // A marketplace install copies only claude-plugin/, and the Claude directory reads its license and icon from there.
  // This lives here, not beside the plugin's tests: the directory holds a plugin whose scripts name an image for review.
  const copies = { LICENSE: '../../../LICENSE', 'icon.png': `../../${manifest.icon}` };
  for (const [name, original] of Object.entries(copies)) {
    const shipped = readFileSync(new URL(`../../../claude-plugin/${name}`, import.meta.url));

    assert.ok(shipped.equals(readFileSync(new URL(original, import.meta.url))), `claude-plugin/${name} drifted: copy it again from the repository`);
  }
});

test('every file that quotes the extension ID quotes the one the manifest declares', () => {
  // The ID is publisher.name, and the editor matches it exactly: a stale copy in the README's argv.json
  // entry silently leaves the inline view off, and one in the test setup runs the tests with no extension.
  const id = `${manifest.publisher}.${manifest.name}`;
  for (const file of ['../../../README.md', '../../src/ui/insets.ts', '../../.vscode-test.mjs', '../integration/helpers.ts']) {
    const quoted = readFileSync(new URL(file, import.meta.url), 'utf8').match(/\b[a-z0-9-]+\.clause\b/g) ?? [];

    assert.ok(quoted.length > 0, `${file} no longer quotes the ID; take it out of this list`);
    for (const found of quoted) assert.equal(found, id, `${file} quotes ${found}`);
  }
});

test('Review All Changes is a command with a button in the title of the panel, first among them, and an entry in the palette while anything is pending', () => {
  assert.equal(declared('clause.reviewAll')?.title, 'Review All Changes');
  assert.equal(declared('clause.reviewAll')?.icon, '$(diff-multiple)');
  const button = inMenu('view/title', 'clause.reviewAll');

  assert.equal(button?.when, 'view == clause');
  const order = (item: { group?: string } | undefined) => Number(item?.group?.match(/^navigation@(\d+)$/)?.[1]);
  for (const item of (manifest.contributes.menus?.['view/title'] ?? []).filter((candidate) => candidate !== button)) {
    assert.ok(order(button) < order(item), `Review All sits before ${item.command}: look first, then keep or discard`);
  }
  assert.equal(inMenu('commandPalette', 'clause.reviewAll')?.when, 'clause.hasPending');
});

test('Ctrl+Z takes back a Keep or Discard only in a file that has one to take back, and is Cmd+Z on a Mac', () => {
  const undo = keyFor('clause.undo', 'ctrl+z');

  assert.equal(undo?.mac, 'cmd+z');
  // Everywhere else Ctrl+Z is the editor's own undo, untouched.
  assert.equal(undo?.when, 'editorTextFocus && clause.canUndo');
  assert.equal(inMenu('commandPalette', 'clause.undo')?.when, 'false', 'a key, as undo is, and no palette entry');
});

test('every command is listed in the palette under the same category, so that typing it finds them all', () => {
  for (const command of manifest.contributes.commands ?? []) assert.equal(command.category, 'Clause', command.command);
});
