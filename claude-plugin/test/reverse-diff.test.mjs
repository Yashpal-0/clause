import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { structuredPatch } from 'diff';
import { reverseApply } from '../reverse-diff.mjs';
import { tempDir } from './helpers.mjs';

/** A hunk as Claude Code reports it: git's own numbers, and lines that keep their ` `, `+` or `-` prefix. */
const hunk = (oldStart, oldLines, newStart, newLines, ...lines) => ({ oldStart, oldLines, newStart, newLines, lines });

/** What `reverseApply` rebuilds, as text; null when it declines. */
function before(current, ...hunks) {
  const result = reverseApply(Buffer.from(current), hunks);
  return result === null ? null : result.toString('utf8');
}

test('rebuilds a change in the middle of a file', () => {
  const now = 'one\nTWO\nthree\nfour\nfive\n';
  assert.equal(before(now, hunk(1, 5, 1, 5, ' one', '-two', '+TWO', ' three', ' four', ' five')), 'one\ntwo\nthree\nfour\nfive\n');
});

test('rebuilds a change on the first line', () => {
  assert.equal(before('A\nb\nc\nd\n', hunk(1, 4, 1, 4, '-a', '+A', ' b', ' c', ' d')), 'a\nb\nc\nd\n');
});

test('copies the lines between hunks from the file', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const now = lines.map((line) => (line === 'l2' || line === 'l18' ? line.replace('l', 'L') : line)).join('\n') + '\n';
  const rebuilt = before(
    now,
    hunk(1, 5, 1, 5, ' l1', '-l2', '+L2', ' l3', ' l4', ' l5'),
    hunk(15, 6, 15, 6, ' l15', ' l16', ' l17', '-l18', '+L18', ' l19', ' l20'),
  );
  assert.equal(rebuilt, lines.join('\n') + '\n');
});

test('keeps carriage returns, which are part of the line', () => {
  assert.equal(before('l1\r\nL2\r\nl3\r\n', hunk(1, 3, 1, 3, ' l1\r', '-l2\r', '+L2\r', ' l3\r')), 'l1\r\nl2\r\nl3\r\n');
});

test('keeps a byte order mark and multibyte text exactly', () => {
  const now = Buffer.from('\u{FEFF}héllo\nWÖRLD\nend\n');
  const rebuilt = reverseApply(now, [hunk(1, 3, 1, 3, ' \u{FEFF}héllo', '-wörld', '+WÖRLD', ' end')]);
  assert.deepEqual(rebuilt, Buffer.from('\u{FEFF}héllo\nwörld\nend\n'));
  assert.deepEqual([...rebuilt.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('handles blank lines, which git reports as a lone space', () => {
  assert.equal(before('a\n\nB\nc\nd\n', hunk(1, 5, 1, 5, ' a', ' ', '-b', '+B', ' c', ' d')), 'a\n\nb\nc\nd\n');
  assert.equal(before('a\nB\nc\n', hunk(1, 3, 1, 3, ' a', '-', '+B', ' c')), 'a\n\nc\n');
});

test('a file that did not end in a newline still does not', () => {
  assert.equal(before('p\nQ\nr', hunk(1, 3, 1, 3, ' p', '-q', '+Q', ' r')), 'p\nq\nr');
});

test('lines appended after an unchanged last line mean the old file ended in a newline', () => {
  assert.equal(before('a\nb\nc\nd\n', hunk(1, 2, 1, 4, ' a', ' b', '+c', '+d')), 'a\nb\n');
  assert.equal(before('a\nb\nc', hunk(1, 2, 1, 3, ' a', ' b', '+c')), 'a\nb\n');
});

test('appending to a file after changing an earlier line still knows the old ending', () => {
  assert.equal(before('a\nB\nc\nd\n', hunk(1, 3, 1, 4, ' a', '-b', '+B', ' c', '+d')), 'a\nb\nc\n');
});

test('a hunk that stops before the end of the file says nothing about how the file ends', () => {
  // Without trailing context (git's -U0), a hunk can end in added or removed lines anywhere in the file.
  assert.equal(before('a\nX\nb', hunk(1, 0, 2, 1, '+X')), 'a\nb');
  assert.equal(before('a\nB\nc', hunk(2, 1, 2, 1, '-b', '+B')), 'a\nb\nc');
});

test('an empty old file comes back empty, whether the hunk is numbered the way git or jsdiff does', () => {
  assert.deepEqual(reverseApply(Buffer.from('new1\nnew2\n'), [hunk(0, 0, 1, 2, '+new1', '+new2')]), Buffer.alloc(0), 'git: -0,0');
  assert.deepEqual(reverseApply(Buffer.from('new1\nnew2\n'), [hunk(1, 0, 1, 2, '+new1', '+new2')]), Buffer.alloc(0), 'jsdiff: -1,0');
  assert.equal(before('new1\nnew2\n', hunk(2, 0, 1, 2, '+new1', '+new2')), null, 'neither');
});

test('declines when the old last line was changed or removed: whether it ended in a newline is not in the diff', () => {
  assert.equal(before('x\nY\n', hunk(1, 2, 1, 2, ' x', '-y', '+Y')), null);
  assert.equal(before('a\nb\n', hunk(1, 4, 1, 2, ' a', ' b', '-c', '-d')), null);
  assert.equal(before('a\nb\nc\n', hunk(1, 2, 1, 3, ' a', '-b', '+b', '+c')), null);
});

test('declines a file that is now empty', () => {
  assert.equal(before('', hunk(1, 2, 1, 0, '-a', '-b')), null);
  assert.equal(before(''), null);
});

test('declines when there are no hunks', () => {
  assert.equal(before('a\n'), null);
});

test('declines a file that is not valid UTF-8', () => {
  assert.equal(reverseApply(Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0x63, 0x0a]), [hunk(1, 3, 1, 3, ' a', '-x', '+\u{FFFD}', ' c')]), null);
});

test('declines removed text that Claude Code had to repair, since the real bytes are unknown', () => {
  assert.equal(before('a\nB\nc\n', hunk(1, 3, 1, 3, ' a', '-b\u{FFFD}', '+B', ' c')), null);
});

test('declines removed text that would not survive being written back', () => {
  assert.equal(before('a\nB\nc\n', hunk(1, 3, 1, 3, ' a', '-b\u{D800}', '+B', ' c')), null, 'lone surrogate');
  assert.equal(before('a\nB\nc\n', hunk(1, 3, 1, 3, ' a', '-b\nb2', '+B', ' c')), null, 'newline inside a line');
});

test('accepts a replacement character that is really in the file', () => {
  assert.equal(before('a\n\u{FFFD}\nc\nd\n', hunk(1, 4, 1, 4, ' a', '-b', '+\u{FFFD}', ' c', ' d')), 'a\nb\nc\nd\n');
});

test('declines hunks that do not match the file as it is now', () => {
  assert.equal(before('one\nTWO\nthree\nfour\n', hunk(1, 4, 1, 4, ' one', '-two', '+Two', ' three', ' four')), null, 'added line');
  assert.equal(before('one\nTWO\nthree\nfour\n', hunk(1, 4, 1, 4, ' one', '-two', '+TWO', ' 3', ' four')), null, 'context line');
  assert.equal(before('one\nTWO\n', hunk(1, 4, 1, 4, ' one', '-two', '+TWO', ' three', ' four')), null, 'past the end of the file');
});

test('declines hunks whose numbers disagree with their lines or with each other', () => {
  const now = 'one\nTWO\nthree\nfour\n';
  const lines = [' one', '-two', '+TWO', ' three', ' four'];
  assert.equal(before(now, hunk(1, 3, 1, 4, ...lines)), null, 'old line count');
  assert.equal(before(now, hunk(1, 4, 1, 5, ...lines)), null, 'new line count');
  assert.equal(before(now, hunk(3, 4, 1, 4, ...lines)), null, 'old start');
  assert.equal(before(now, hunk(1, 4, 2, 4, ...lines)), null, 'new start');
});

test('declines hunks that overlap or are out of order', () => {
  const now = 'a\nB\nc\nD\ne\nf\ng\nh\n';
  const first = hunk(1, 4, 1, 4, ' a', '-b', '+B', ' c', ' D');
  const second = hunk(3, 4, 3, 4, ' c', '-d', '+D', ' e', ' f');
  assert.equal(before(now, first, second), null, 'overlap');
  assert.equal(before(now, second, first), null, 'order');
});

test('declines a hunk that starts inside the previous one even when its old side adds up', () => {
  const now = 'a\nB\nc\nD\ne\nf\n';
  const first = hunk(1, 4, 1, 4, ' a', '-b', '+B', ' c', ' D');
  const second = hunk(5, 3, 3, 3, ' c', ' D', ' e');
  assert.equal(before(now, first, second), null);
});

test('declines a hunk whose new start lies inside the previous hunk although its text fits right after it', () => {
  const now = 'a\nB\nc\nd\nE\nf\n';
  const first = hunk(1, 3, 1, 3, ' a', '-b', '+B', ' c');
  assert.equal(before(now, first, hunk(4, 3, 4, 3, ' d', '-e', '+E', ' f')), 'a\nb\nc\nd\ne\nf\n', 'the same hunks, numbered right');
  assert.equal(before(now, first, hunk(4, 3, 3, 3, ' d', '-e', '+E', ' f')), null);
});

test('declines a second hunk whose old start is one line early', () => {
  const now = 'a\nB\nc\nd\nE\nf\n';
  const first = hunk(1, 3, 1, 3, ' a', '-b', '+B', ' c');
  assert.equal(before(now, first, hunk(3, 3, 4, 3, ' d', '-e', '+E', ' f')), null);
});

test('declines a hunk with no lines in the new file even when its numbers fit', () => {
  // Git numbers a pure deletion `-2 +1,0`, so these numbers only come from a payload that is wrong.
  assert.equal(before('a\nc\n', hunk(1, 1, 1, 0, '-b')), null);
});

test('declines hunks it cannot read', () => {
  const now = 'one\nTWO\nthree\n';
  const good = [' one', '-two', '+TWO', ' three'];
  assert.equal(reverseApply(Buffer.from(now), 'nope'), null, 'not a list');
  assert.equal(reverseApply(Buffer.from(now), undefined), null, 'missing');
  assert.equal(before(now, hunk(1, 3, 1, 3, ...good, '\\ No newline')), null, 'cut-off marker');
  assert.equal(before(now, hunk(1, 3, 1, 3, ...good, '')), null, 'empty line');
  assert.equal(before(now, hunk(1.5, 3, 1, 3, ...good)), null, 'fraction');
  assert.equal(before(now, hunk(-1, 3, 1, 3, ...good)), null, 'negative');
  assert.equal(before(now, { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: 'text' }), null, 'lines not an array');
  assert.equal(before(now, { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [7] }), null, 'line not text');
  assert.equal(reverseApply(Buffer.from(now), [null]), null, 'hunk not an object');
});

// -- End-of-file markers ----------------------------------------------------------------
// Claude Code builds its hunks in two ways. From git it drops the "\ No newline at end of file"
// lines. From its own file watcher (jsdiff) it keeps one after every line that has no final
// newline, which says exactly how each side ended. The hunks below are the second kind.

const NO_NEWLINE = '\\ No newline at end of file';

test('uses the end-of-file markers to rebuild a file that has no final newline', () => {
  // Captured from a real `sed -i s/n2/N2/` run under Claude Code 2.1.305.
  assert.equal(before('n1\nN2\nn3\nn4', hunk(1, 4, 1, 4, ' n1', '-n2', '+N2', ' n3', ' n4', NO_NEWLINE)), 'n1\nn2\nn3\nn4');
});

test('a marker after a removed line means the old file did not end in a newline', () => {
  assert.equal(before('a\nB\n', hunk(1, 2, 1, 2, ' a', '-b', NO_NEWLINE, '+B')), 'a\nb');
  assert.equal(before('a\n', hunk(1, 2, 1, 1, ' a', '-b', NO_NEWLINE)), 'a\nb');
  assert.equal(before('a\n', hunk(1, 1, 1, 1, '-a', NO_NEWLINE, '+a')), 'a');
});

test('a marker after an added line means only the new file lacks a final newline', () => {
  assert.equal(before('a\nB', hunk(1, 2, 1, 2, ' a', '-b', '+B', NO_NEWLINE)), 'a\nb\n');
  assert.equal(before('a', hunk(1, 1, 1, 1, '-a', '+a', NO_NEWLINE)), 'a\n');
  assert.equal(before('a\nb\nc', hunk(1, 2, 1, 3, ' a', ' b', '+c', NO_NEWLINE)), 'a\nb\n');
});

test('markers on both sides rebuild a last line that changed in a file with no final newline', () => {
  assert.equal(before('a\nB', hunk(1, 2, 1, 2, ' a', '-b', NO_NEWLINE, '+B', NO_NEWLINE)), 'a\nb');
  assert.equal(before('a\nb\nc', hunk(1, 2, 1, 3, ' a', '-b', NO_NEWLINE, '+b', '+c', NO_NEWLINE)), 'a\nb');
});

test('only the last hunk carries markers, and the lines between hunks are still copied', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const now = lines.map((line) => (line === 'l2' || line === 'l20' ? line.replace('l', 'L') : line)).join('\n');
  const rebuilt = before(
    now,
    hunk(1, 5, 1, 5, ' l1', '-l2', '+L2', ' l3', ' l4', ' l5'),
    hunk(17, 4, 17, 4, ' l17', ' l18', ' l19', '-l20', NO_NEWLINE, '+L20', NO_NEWLINE),
  );
  assert.equal(rebuilt, lines.join('\n'));
});

test('a marker is not a line: the hunk counts leave it out', () => {
  assert.equal(before('a\nB\n', hunk(1, 3, 1, 2, ' a', '-b', NO_NEWLINE, '+B')), null, 'old count includes the marker');
  assert.equal(before('a\nB\n', hunk(1, 2, 1, 3, ' a', '-b', NO_NEWLINE, '+B')), null, 'new count includes the marker');
});

test('declines a marker that contradicts how the file really ends', () => {
  const kept = [' one', '-two', '+TWO', ' three'];
  assert.equal(before('one\nTWO\nthree\n', hunk(1, 3, 1, 3, ...kept, NO_NEWLINE)), null, 'file ends in a newline, marker says not');
  assert.equal(before('a\nB', hunk(1, 2, 1, 2, ' a', '-b', NO_NEWLINE, '+B')), null, 'file has no final newline, last new line has no marker');
  assert.equal(before('a\nB', hunk(1, 2, 1, 2, ' a', '-b', '+B')), null, 'no markers at all: git-style hunks do not say how the old file ended');
});

test('declines a marker that is not at the end of its side', () => {
  assert.equal(before('a\nb\n', hunk(1, 2, 1, 2, ' a', NO_NEWLINE, ' b')), null, 'after context that a line follows');
  assert.equal(before('a\n', hunk(1, 3, 1, 1, ' a', '-b', NO_NEWLINE, '-c')), null, 'removed line after the old side ended');
  assert.equal(before('a\nc\nB\n', hunk(1, 3, 1, 3, ' a', '-b', NO_NEWLINE, ' c', '+B')), null, 'context after the old side ended');
  assert.equal(before('a\nb\nc', hunk(1, 1, 1, 3, ' a', '+b', NO_NEWLINE, '+c', NO_NEWLINE)), null, 'added line after the new side ended');
});

test('a hunk that only adds lines follows an old last line that ended in a newline', () => {
  // No kept or removed line, so the hunk cannot show the old ending; a line that was followed by another one had a newline.
  assert.equal(before('a\nb\nc', hunk(2, 0, 3, 1, '+c', NO_NEWLINE)), 'a\nb\n');
});

test('declines a line that only looks like the marker', () => {
  const lines = [' n1', '-n2', '+N2', ' n3', ' n4'];
  const now = 'n1\nN2\nn3\nn4';
  assert.equal(before(now, hunk(1, 4, 1, 4, ...lines, NO_NEWLINE)), 'n1\nn2\nn3\nn4', 'the real marker');
  assert.equal(before(now, hunk(1, 4, 1, 4, ...lines, '\\ No newline at end of fil')), null, 'cut short');
  assert.equal(before(now, hunk(1, 4, 1, 4, ...lines, '\\ Pas de fin de ligne à la fin du fichier')), null, 'git in another language');
  assert.equal(before(now, hunk(1, 4, 1, 4, ...lines, '\\')), null, 'a lone backslash');
});

test('declines markers in places where no line can lack a newline', () => {
  const now = 'a\nB';
  assert.equal(before(now, hunk(1, 2, 1, 2, NO_NEWLINE, ' a', '-b', '+B', NO_NEWLINE)), null, 'first in the hunk');
  assert.equal(before(now, hunk(1, 2, 1, 2, ' a', '-b', '+B', NO_NEWLINE, NO_NEWLINE)), null, 'two in a row');
  assert.equal(before('a\nB\nc\nd\ne', hunk(1, 2, 1, 2, ' a', '-b', NO_NEWLINE, '+B')), null, 'a hunk that stops before the end of the file');
  // Each hunk is fine alone; together the first one says the old file ended where the second one continues.
  const early = hunk(1, 2, 1, 2, ' a', '-b', NO_NEWLINE, '+B');
  const late = hunk(7, 2, 7, 3, ' g', ' h', '+I');
  assert.equal(before('a\nB\nc\nd\ne\nf\ng\nh\nI\n', early, late), null, 'a hunk that is not the last');
});

// ---------------------------------------------------------------------------------------
// The same rules against what git really prints. Every claim above about positions, counts
// and trailing newlines is a claim about git, so the rest of this file generates file pairs,
// takes the hunks from `git diff`, and checks the rebuilt bytes against the real old file.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const hasGit = spawnSync('git', ['--version']).status === 0;
const needsGit = { skip: hasGit ? false : 'git is not installed' };

/** Lines that look like diff syntax are there on purpose; so are blank, CR, and non-ASCII ones. */
const LINES = ['a', 'b', 'c', 'd', '', ' ', 'x y', 'héllo', 'tab\there', 'cr\r', '@@ -1 +1 @@', '+plus', '-minus', '\\ No newline at end of file', '\u{2028}', 'END?'];
const SENTINEL = 'unique last line';

/** Deterministic, so a failure can be reproduced. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const render = (lines, endsWithNewline) => (lines.length === 0 ? '' : lines.join('\n') + (endsWithNewline ? '\n' : ''));

/** @returns {{ name: string, old: string, now: string, kind: 'free' | 'append' | 'interior' | 'from-empty' }[]} */
function makeCases(count) {
  const rand = random(20261021);
  const int = (below) => Math.floor(rand() * below);
  const line = () => LINES[int(LINES.length)];
  const lines = (max) => Array.from({ length: int(max) }, line);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const name = `c${String(i).padStart(4, '0')}`;
    const oldLines = lines(rand() < 0.3 ? 70 : 20);
    const oldEnds = rand() < 0.7;
    const kind = ['free', 'free', 'append', 'interior', 'from-empty'][int(5)];

    if (kind === 'from-empty') {
      cases.push({ name, kind, old: '', now: render(oldLines.length === 0 ? [line()] : oldLines, oldEnds) });
      continue;
    }
    if (kind === 'append') {
      const extra = lines(6);
      if (extra.length === 0) extra.push(line());
      cases.push({ name, kind, old: render(oldLines, true), now: render([...oldLines, ...extra], rand() < 0.5) });
      continue;
    }

    // A last line nothing else in the file can be mistaken for, so git must keep it as context.
    const kept = kind === 'interior' ? [SENTINEL] : [];
    const next = [...oldLines];
    for (let edits = 1 + int(4); edits > 0; edits--) {
      const at = int(next.length + 1);
      const how = int(3);
      if (how === 0) next.splice(at, 0, line());
      else if (how === 1) next.splice(at, 1);
      else if (at < next.length) next[at] = line();
    }
    const newEnds = kind === 'interior' || rand() >= 0.15 ? oldEnds : !oldEnds;
    cases.push({ name, kind, old: render([...oldLines, ...kept], oldEnds), now: render([...next, ...kept], newEnds) });
  }
  return cases.filter((c) => c.old !== c.now);
}

/** Parses `git diff --no-index A B` the way Claude Code does: only ` `, `+` and `-` lines, no end-of-file markers. */
function parseGitDiff(output) {
  const byCase = new Map();
  let hunks = null;
  let current = null;
  for (const line of output.split('\n')) {
    const file = /^diff --git a\/A\/(c\d+) /.exec(line);
    if (file) {
      hunks = [];
      current = null;
      byCase.set(file[1], hunks);
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && hunks) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && /^[ +-]/.test(line)) {
      current.lines.push(line);
    }
  }
  return byCase;
}

function gitDiffAll(t, cases, args) {
  const dir = tempDir(t);
  for (const side of ['A', 'B']) mkdirSync(join(dir, side));
  for (const { name, old, now } of cases) {
    writeFileSync(join(dir, 'A', name), old);
    writeFileSync(join(dir, 'B', name), now);
  }
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', ...args, 'A', 'B'], {
    cwd: dir,
    env: GIT_ENV,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return parseGitDiff(result.stdout);
}

for (const algorithm of ['myers', 'patience', 'histogram']) {
  for (const context of [1, 3]) {
    test(`never rebuilds wrong bytes from real git hunks (${algorithm}, ${context} lines of context)`, needsGit, (t) => {
      const cases = makeCases(500);
      const hunksOf = gitDiffAll(t, cases, [`--diff-algorithm=${algorithm}`, `-U${context}`]);
      const declined = [];
      for (const { name, kind, old, now } of cases) {
        const hunks = hunksOf.get(name);
        assert.ok(hunks && hunks.length > 0, `${name}: git reported no change`);
        const rebuilt = reverseApply(Buffer.from(now), hunks);
        if (rebuilt === null) {
          declined.push({ name, kind });
          continue;
        }
        assert.equal(rebuilt.toString('utf8'), old, `${name} (${kind})\nold: ${JSON.stringify(old)}\nnow: ${JSON.stringify(now)}\nhunks: ${JSON.stringify(hunks)}`);
      }

      // Declining is allowed where the diff cannot prove the old ending; these shapes can always be proven.
      const unexpected = declined.filter(({ name, kind }) => {
        const c = cases.find((candidate) => candidate.name === name);
        return kind === 'append' || kind === 'interior' || (kind === 'from-empty' && c.now !== '');
      });
      assert.deepEqual(unexpected, [], `declined cases that the diff determines: ${JSON.stringify(unexpected.slice(0, 5))}`);
      assert.ok(declined.length < cases.length / 2, `declined ${declined.length} of ${cases.length}`);
    });
  }
}

test('real git hunks for a file that became empty are declined', needsGit, (t) => {
  const cases = [
    { name: 'c0001', old: 'a\nb\n', now: '' },
    { name: 'c0002', old: 'only', now: '' },
  ];
  const hunksOf = gitDiffAll(t, cases, ['-U3']);
  for (const { name } of cases) assert.equal(reverseApply(Buffer.alloc(0), hunksOf.get(name)), null);
});

/** Whether the last line the old file has in the last hunk was removed or changed. */
function endsInRemoval(hunks) {
  const lines = hunks[hunks.length - 1].lines.filter((line) => line !== NO_NEWLINE);
  while (lines.length > 0 && lines[lines.length - 1][0] === '+') lines.pop();
  return lines.length > 0 && lines[lines.length - 1][0] === '-';
}

for (const context of [1, 3]) {
  test(`never rebuilds wrong bytes from the hunks Claude Code's own diff makes (jsdiff, ${context} lines of context)`, () => {
    const cases = makeCases(500);
    const declined = [];
    for (const { name, kind, old, now } of cases) {
      const { hunks } = structuredPatch('a', 'b', old, now, '', '', { context });
      assert.ok(hunks.length > 0, `${name}: jsdiff reported no change`);
      const rebuilt = reverseApply(Buffer.from(now), hunks);
      if (rebuilt === null) {
        declined.push({ name, kind, now, hunks });
        continue;
      }
      assert.equal(rebuilt.toString('utf8'), old, `${name} (${kind})\nold: ${JSON.stringify(old)}\nnow: ${JSON.stringify(now)}\nhunks: ${JSON.stringify(hunks)}`);
    }

    // A hunk with a marker says how both files ended, so only two things are left to decline: a file
    // that became empty has nothing to anchor to, and without markers a removed or changed last line
    // looks the same as in git's hunks, which would have dropped a marker for the old side.
    const unexpected = declined.filter(({ now, hunks }) => now !== '' && !(hunks.every((h) => !h.lines.includes(NO_NEWLINE)) && endsInRemoval(hunks)));
    assert.deepEqual(unexpected, [], `declined cases that the diff determines: ${JSON.stringify(unexpected.slice(0, 5))}`);
  });
}
