// @ts-check
//
// Rebuilds a file as it was before a shell command ran, from the file as it is now and the
// hunks Claude Code reports for that command (`tool_response.bashEditDiff`).
//
// The hunks are unified-diff hunks: `oldStart,oldLines` / `newStart,newLines` and lines
// prefixed with ' ' (kept), '-' (removed) or '+' (added). Claude Code makes them in two ways,
// and they differ in what they say about the end of the file. Built from git's output, the
// "\ No newline at end of file" lines are dropped, so how the old file ended has to be worked
// out from what is left. Built by its own diff of the file's old and new text (jsdiff, used for
// later commands on Linux), a marker follows every line that has no final newline, which says
// how both sides ended.
//
// The result becomes a baseline, and a baseline that is wrong would show the user's own earlier
// work as something Claude did and let them "Discard" it. So every number and line is checked
// against the file before it is used, and the answer is null whenever the old bytes cannot be
// proven from what was reported.

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * @typedef {object} Line
 * @property {' ' | '-' | '+'} sign
 * @property {string} text
 * @property {boolean} unterminated followed by a "no newline" marker: the file ends after this line
 */

/**
 * @typedef {object} Hunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {Line[]} lines
 */

/**
 * Text in a removed line that cannot be turned back into the original bytes. Claude Code
 * decodes git's output as UTF-8 and replaces invalid bytes with U+FFFD, so that character may
 * stand for anything; a lone surrogate would be written out as U+FFFD; and a newline would
 * turn one removed line into two.
 */
const NOT_RECOVERABLE = /[\n\p{Cs}\u{FFFD}]/u;

/**
 * @param {Buffer} current the file now
 * @param {unknown} hunks Claude Code's hunks for this file, in file order
 * @returns {Buffer | null} the file before the command, or null when the hunks do not prove it
 */
export function reverseApply(current, hunks) {
  const list = readHunks(hunks);
  if (list === null) return null;
  // A line without a final newline is the last one in its file, so only the last hunk has any.
  if (list.slice(0, -1).some(hasMarker)) return null;

  let text;
  try {
    // ignoreBOM keeps a byte order mark as the first character of line 1, where git sees it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current);
  } catch {
    return null;
  }
  const { lines, endsWithNewline } = splitLines(text);

  /** @type {string[]} */
  const before = [];
  let next = 0; // first line of the current file that no hunk or copied gap has covered yet
  for (const hunk of list) {
    const start = hunk.newStart - 1;
    // A hunk with no lines in the new file is a file that was emptied (git has no context to
    // anchor it to), and its old last line could have had either ending.
    if (hunk.newLines === 0 || start < next || start + hunk.newLines > lines.length) return null;
    for (; next < start; next++) before.push(lines[next]);
    // Lines between hunks are unchanged, so the old and new sides advance together; a start
    // that disagrees with that means the numbers cannot be trusted. A hunk with no old lines is
    // numbered by the line it follows in git (`-0,0`) and by the line it would take in jsdiff (`-1,0`).
    const follows = hunk.oldLines === 0 ? [hunk.oldStart - 1, hunk.oldStart] : [hunk.oldStart - 1];
    if (!follows.includes(before.length)) return null;
    if (!applyHunk(hunk, lines, next, before)) return null;
    next += hunk.newLines;
  }

  const last = list[list.length - 1];
  /** @type {boolean | null} */
  let hadNewline = endsWithNewline;
  if (next === lines.length) {
    hadNewline = oldEndedWithNewline(last.lines, endsWithNewline);
    if (hadNewline === null) return null;
  } else if (hasMarker(last)) {
    return null;
  }
  for (; next < lines.length; next++) before.push(lines[next]);

  if (before.length === 0) return Buffer.alloc(0);
  return Buffer.from(before.join('\n') + (hadNewline ? '\n' : ''), 'utf8');
}

/**
 * Checks one hunk against the file as it is now and appends the lines it had before.
 * @param {Hunk} hunk
 * @param {string[]} lines the file now
 * @param {number} at index in `lines` where the hunk's new side starts
 * @param {string[]} before the old file so far
 * @returns {boolean} false when the hunk does not describe this file
 */
function applyHunk(hunk, lines, at, before) {
  let kept = 0;
  let removed = 0;
  for (const { sign } of hunk.lines) {
    if (sign === ' ') kept++;
    else if (sign === '-') removed++;
  }
  const added = hunk.lines.length - kept - removed;
  if (kept + removed !== hunk.oldLines || kept + added !== hunk.newLines) return false;

  let position = at;
  for (const { sign, text } of hunk.lines) {
    if (sign === '-') {
      if (NOT_RECOVERABLE.test(text)) return false;
      before.push(text);
      continue;
    }
    if (lines[position] !== text) return false;
    position++;
    if (sign === ' ') before.push(text);
  }
  return true;
}

/**
 * Whether the old file ended in a newline, from the last hunk when it reaches the end of the file.
 * @param {Line[]} lines
 * @param {boolean} newEndsWithNewline how the file ends now
 * @returns {boolean | null} null when the hunk does not say
 */
function oldEndedWithNewline(lines, newEndsWithNewline) {
  if (lines.some((line) => line.unterminated)) return endingFromMarkers(lines, newEndsWithNewline);

  // No markers: either neither side lacks a final newline, or the markers were dropped, so the
  // old ending is inferred from what comes last in the hunk.
  let i = lines.length;
  while (i > 0 && lines[i - 1].sign === '+') i--;
  // The old last line was changed or removed, and the diff does not say whether it ended in a
  // newline.
  if (i > 0 && lines[i - 1].sign === '-') return null;
  // Lines added after a shared line mean that line ended in a newline in the old file too.
  return i < lines.length ? true : newEndsWithNewline;
}

/**
 * The markers are complete: a line has a final newline unless one follows it. So the new side
 * must agree with the file as it is now, which makes a wrong or misplaced marker detectable.
 * @param {Line[]} lines
 * @param {boolean} newEndsWithNewline how the file ends now
 * @returns {boolean | null} null when the markers contradict the file or each other
 */
function endingFromMarkers(lines, newEndsWithNewline) {
  for (const [i, line] of lines.entries()) {
    if (!line.unterminated) continue;
    // A marker ends its side: a kept or added line must be last, and after a removed line only
    // added lines (the new side) can follow.
    const placed = line.sign === '-' ? lines.slice(i + 1).every((later) => later.sign === '+') : i === lines.length - 1;
    if (!placed) return null;
  }
  const lastNew = lastOf(lines, (line) => line.sign !== '-');
  if (lastNew === undefined || lastNew.unterminated === newEndsWithNewline) return null;
  const lastOld = lastOf(lines, (line) => line.sign !== '+');
  // Without a kept or removed line the hunk only adds, after an old last line that ended in a newline.
  return lastOld === undefined ? true : !lastOld.unterminated;
}

/**
 * @param {Line[]} lines
 * @param {(line: Line) => boolean} test
 * @returns {Line | undefined}
 */
function lastOf(lines, test) {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i])) return lines[i];
  return undefined;
}

/** @param {Hunk} hunk */
function hasMarker(hunk) {
  return hunk.lines.some((line) => line.unterminated);
}

/**
 * Lines as git counts them: split on '\n' only, so a CR stays part of its line, and a final
 * newline ends the last line instead of starting another.
 * @param {string} text
 * @returns {{ lines: string[], endsWithNewline: boolean }}
 */
function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: false };
  const lines = text.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

/**
 * @param {unknown} value
 * @returns {Hunk[] | null} null unless `value` is a non-empty list of well-formed hunks
 */
function readHunks(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  /** @type {Hunk[]} */
  const hunks = [];
  for (const item of value) {
    const hunk = readHunk(item);
    if (hunk === null) return null;
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * @param {unknown} value
 * @returns {Hunk | null}
 */
function readHunk(value) {
  if (typeof value !== 'object' || value === null) return null;
  const { oldStart, oldLines, newStart, newLines, lines } = /** @type {Record<string, unknown>} */ (value);
  if (!isCount(oldStart) || !isCount(oldLines) || !isCount(newStart) || !isCount(newLines) || !Array.isArray(lines)) return null;
  const read = readLines(lines);
  return read === null ? null : { oldStart, oldLines, newStart, newLines, lines: read };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * @param {unknown[]} raw
 * @returns {Line[] | null} null unless every entry is a prefixed line or a marker that follows one
 */
function readLines(raw) {
  /** @type {Line[]} */
  const lines = [];
  for (const line of raw) {
    if (typeof line !== 'string') return null;
    if (line === NO_NEWLINE) {
      const previous = lines[lines.length - 1];
      if (previous === undefined || previous.unterminated) return null;
      previous.unterminated = true;
      continue;
    }
    const sign = line[0];
    if (sign !== ' ' && sign !== '-' && sign !== '+') return null;
    lines.push({ sign, text: line.slice(1), unterminated: false });
  }
  return lines;
}
