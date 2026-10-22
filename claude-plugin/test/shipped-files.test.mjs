import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The marketplace copies only claude-plugin/, so the license and icon the plugin ships are copies of
// the repository's own, which stay the single source.
const copies = { LICENSE: '../../LICENSE', 'icon.png': '../../vscode-extension/images/icon.png' };

for (const [name, original] of Object.entries(copies)) {
  test(`${name} in the plugin folder is a copy of the repository's`, () => {
    const shipped = readFileSync(new URL(`../${name}`, import.meta.url));
    const source = readFileSync(new URL(original, import.meta.url));
    assert.ok(shipped.equals(source), `${name} drifted: cp ${original.slice(6)} claude-plugin/${name}`);
  });
}
