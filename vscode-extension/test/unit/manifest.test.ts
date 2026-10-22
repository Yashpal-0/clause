import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  contributes: {
    commands?: { command: string; title: string; icon?: string }[];
    menus?: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings?: { command: string; key: string; when?: string }[];
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
    for (const match of text.matchAll(/ThemeColor\(\s*'(claudePending\.[A-Za-z]+)'/g)) used.add(match[1]!);
    for (const match of text.matchAll(/--vscode-claudePending-([A-Za-z]+)/g)) used.add(`claudePending.${match[1]}`);
  }
  return used;
}

test('following Claude into the files it edits is a setting, on by default', () => {
  const setting = manifest.contributes.configuration?.properties?.['claudePending.followEdits'];

  assert.ok(setting !== undefined, 'the manifest declares claudePending.followEdits');
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
  const colour = manifest.contributes.colors?.find((candidate) => candidate.id === 'claudePending.explorerForeground');

  assert.ok(colour !== undefined, 'the manifest declares claudePending.explorerForeground');
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
  assert.equal(declared('claudePending.nextFile')?.title, 'Review Next File');
  assert.equal(declared('claudePending.nextFile')?.icon, '$(arrow-right)');
  assert.equal(declared('claudePending.previousFile')?.title, 'Review Previous File');
  assert.equal(declared('claudePending.previousFile')?.icon, '$(arrow-left)');
});

test('the file arrows are in the title of every editor while anything is pending, after the buttons that come and go', () => {
  const previous = inMenu('editor/title', 'claudePending.previousFile');
  const next = inMenu('editor/title', 'claudePending.nextFile');

  // `hasPending`, not `fileHasPending`: after the last change of a file is kept the button is still there to move on.
  assert.equal(previous?.when, 'claudePending.hasPending');
  assert.equal(next?.when, 'claudePending.hasPending');
  const order = (item: { group?: string } | undefined) => Number(item?.group?.match(/^navigation@(\d+)$/)?.[1]);
  const others = (manifest.contributes.menus?.['editor/title'] ?? []).filter((item) => item !== previous && item !== next);
  for (const item of others) assert.ok(order(item) < order(previous), `${item.command} sits before the arrows, so they never move`);
  assert.ok(order(previous) < order(next), 'previous is left of next');
});

test('the file commands are in the command palette only while something is pending', () => {
  assert.equal(inMenu('commandPalette', 'claudePending.nextFile')?.when, 'claudePending.hasPending');
  assert.equal(inMenu('commandPalette', 'claudePending.previousFile')?.when, 'claudePending.hasPending');
});

test('Alt+J and Alt+K go to the next and previous change in a file that has pending changes, as in Cursor', () => {
  assert.equal(keyFor('claudePending.nextBlock', 'alt+j')?.when, 'editorTextFocus && claudePending.fileHasPending');
  assert.equal(keyFor('claudePending.previousBlock', 'alt+k')?.when, 'editorTextFocus && claudePending.fileHasPending');
});

test('Alt+L and Alt+H go to the next and previous file, as in Cursor, and have a chord as well', () => {
  const when = 'editorTextFocus && claudePending.hasPending';
  assert.equal(keyFor('claudePending.nextFile', 'alt+l')?.when, when);
  assert.equal(keyFor('claudePending.previousFile', 'alt+h')?.when, when);
  assert.equal(keyFor('claudePending.nextFile', 'ctrl+alt+c f')?.when, when);
  assert.equal(keyFor('claudePending.previousFile', 'ctrl+alt+c shift+f')?.when, when);
});

test('Ctrl+Y keeps the selected lines when the selection has pending lines, and the block otherwise, never both', () => {
  assert.equal(declared('claudePending.keepSelection')?.title, 'Keep Selected Lines');
  const selection = keyFor('claudePending.keepSelection', 'ctrl+y');
  const block = keyFor('claudePending.keepBlock', 'ctrl+y');

  assert.equal(selection?.when, 'editorTextFocus && claudePending.selectionInPending');
  // Exclusive, so that which of the two runs does not depend on the order the editor tries them in.
  assert.equal(block?.when, 'editorTextFocus && claudePending.inBlock && !claudePending.selectionInPending');
});

test('Keep Selected Lines is in the editor menu and the command palette only while the selection has pending lines', () => {
  assert.equal(inMenu('editor/context', 'claudePending.keepSelection')?.when, 'claudePending.selectionInPending');
  assert.equal(inMenu('commandPalette', 'claudePending.keepSelection')?.when, 'claudePending.selectionInPending');
});
