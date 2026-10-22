#!/usr/bin/env node
// @ts-check
//
// Claude Code hook entry point: `node hook.mjs <event>` with the hook payload
// as JSON on stdin. Events:
//
//   pre            PreToolUse  Edit|Write|NotebookEdit   save the file's bytes before the tool runs
//   post           PostToolUse (same tools)              make those bytes the file's baseline, note where the edit starts
//   failure        PostToolUseFailure (same tools)       discard the saved bytes
//   prompt         UserPromptSubmit                      tell Claude what the user discarded
//   session-start  SessionStart                          sweep leftovers, mark where this session starts
//   bash           PostToolUse Bash                      rebuild baselines for files a shell command changed
//
// A pending file is one with a baseline in the store: the VS Code extension
// shows the difference between the baseline and the file as Keep/Discard
// blocks. The baseline is the file as it was before Claude's FIRST change, so
// later edits to a still-pending file add to its blocks instead of replacing
// them. Every edit, first or later, also leaves a `touched` record beside the
// baseline (which tool call, which line) so the extension can open the file at
// the change, and adds the folder the Claude session was started in to the
// entry's `sessions` record, so an editor can list the file for the windows
// that session belongs to.
//
// These hooks run on every edit and must never get in Claude's way: they exit
// 0 whatever happens, print nothing except the prompt note, and report their
// own failures to the store's errors.log.

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { reverseApply } from './reverse-diff.mjs';
import { isSessionDir, openStore } from './store.mjs';

/**
 * The tools whose changes are tracked from the exact bytes before the call. Changes made through
 * Bash are tracked from Claude Code's report of them instead (see trackShellEdits).
 */
const TRACKED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Larger files are not tracked. Claude's Write tool is bounded by model output
 * and its Edit tool refuses files this big in practice, so the limit only
 * protects against copying a huge file on every edit.
 */
const MAX_TRACKED_BYTES = 64 * 1024 * 1024;

/**
 * Limits on the note added to a prompt: it is paid for in Claude's context on
 * every turn it appears, and a user who discarded dozens of files needs a
 * summary, not an inventory.
 */
const MAX_NOTE_ENTRIES = 20;
const MAX_NOTE_LENGTH = 3500;
const MAX_FIELD_LENGTH = 200;

/**
 * @typedef {object} Baseline
 * @property {boolean} existed
 * @property {Buffer | null} bytes
 */

/**
 * @typedef {object} ShellEdit what a shell command did to one file
 * @property {string} path
 * @property {Baseline | null} baseline how the file was before the command; null when there is nothing to record
 */

/** @typedef {ReturnType<typeof openStore>} Store */

/** @typedef {Record<string, any>} HookInput payload from Claude Code; fields are validated where used */

async function main() {
  const event = process.argv[2] ?? '';
  /** @type {Store} */
  let store;
  try {
    store = openStore();
  } catch {
    return; // No usable store location, so there is nowhere to record anything.
  }

  try {
    const input = await readInput(store, event);
    switch (event) {
      case 'pre':
        stageBeforeEdit(store, input);
        break;
      case 'post':
        promoteAfterEdit(store, input);
        break;
      case 'failure':
        dropStagedEdit(store, input);
        break;
      case 'prompt':
        process.stdout.write(promptOutput(store, input));
        break;
      case 'session-start':
        startSession(store, input);
        break;
      case 'bash':
        trackShellEdits(store, input);
        break;
      default:
        store.logError('hook', new Error(`unknown event: ${event}`));
    }
  } catch (error) {
    store.logError(event, error);
  }
}

/**
 * @param {Store} store
 * @param {string} event
 * @returns {Promise<HookInput>} {} when stdin is empty or not a JSON object
 */
async function readInput(store, event) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    store.logError(`${event}: unreadable hook input`, error);
    return {};
  }
}

/**
 * @param {Store} store
 * @param {HookInput} input
 */
function stageBeforeEdit(store, input) {
  const path = editedPath(input);
  const key = toolCallKey(input);
  if (path === null || key === null) return;
  // Staged even if the file is already pending: the user may press Keep on
  // everything while a permission prompt is open, and then this is the only
  // record of what the file looked like before this edit.
  const { existed, bytes } = snapshot(path);
  store.stage(key, { path, existed, bytes });
}

/**
 * @param {Store} store
 * @param {HookInput} input
 */
function promoteAfterEdit(store, input) {
  const path = editedPath(input);
  const key = toolCallKey(input);
  if (path === null || key === null) return;
  try {
    // A write held for review leaves the file untouched.
    if (input.tool_response?.staged === true) return;

    const baseline = chooseBaseline(store, store.readStaging(key), path, input.tool_response);
    if (baseline === null) {
      store.logError('post', new Error(`no baseline available for ${path}`));
      return;
    }

    // An edit that changed nothing must not leave an entry behind: a later
    // change from outside (git checkout, another editor) would be shown as
    // Claude's.
    const after = snapshot(path);
    if (sameState(baseline, after)) return;

    makePending(store, 'post', input, path, baseline);
    markTouched(store, path, key, firstDifferingLine(baseline.bytes, after.bytes));
  } finally {
    store.dropStaging(key);
  }
}

/**
 * Tells editors which edit just happened and where, so they can open the file at the change. It is
 * a hint: failing to write it is logged and must not undo or hide the entry.
 * @param {Store} store
 * @param {string} path
 * @param {string} tool tool_use_id of the edit
 * @param {number} line
 */
function markTouched(store, path, tool, line) {
  try {
    store.touch(store.idFor(path), { tool, line });
  } catch (error) {
    store.logError('post', error);
  }
}

/**
 * Makes the file pending. If it already is, the existing, older baseline stays and only the folder
 * the session was started in is added.
 * @param {Store} store
 * @param {string} event names the hook in errors.log
 * @param {HookInput} input
 * @param {string} path
 * @param {Baseline} baseline
 */
function makePending(store, event, input, path, baseline) {
  const dir = sessionDir(input);
  const created = store.createEntry({ path, existed: baseline.existed, base: baseline.bytes, sessionDir: dir ?? undefined });
  if (!created) noteSession(store, event, path, dir);
}

/**
 * Tells editors that a session started in `dir` changed a pending file. A hint, like `touched`:
 * failing to write it is logged and must not undo or hide the entry.
 * @param {Store} store
 * @param {string} event names the hook in errors.log
 * @param {string} path
 * @param {string | null} dir
 */
function noteSession(store, event, path, dir) {
  if (dir === null) return;
  try {
    store.addSessionDir(store.idFor(path), dir);
  } catch (error) {
    store.logError(event, error);
  }
}

/**
 * `CLAUDE_PROJECT_DIR` is the folder Claude Code was started in and does not follow `cd`; the
 * payload's `cwd` does, so it only stands in when the variable is missing.
 * @param {HookInput} input
 * @returns {string | null} the real path of that folder; null when none is known
 */
function sessionDir(input) {
  const named = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' ? input.cwd : '') || process.cwd();
  if (!isAbsolute(named)) return null;
  const dir = canonicalDir(named);
  return isSessionDir(dir) ? dir : null;
}

/**
 * @param {Buffer | null} before the file as it was before an edit; null if it did not exist
 * @param {Buffer | null} after the file as the edit left it
 * @returns {number} 0-based line of `after` holding the first byte that differs from `before`. A
 *   file that only gained or lost its tail reports the line where the shared part ends.
 */
function firstDifferingLine(before, after) {
  const old = before ?? Buffer.alloc(0);
  const now = after ?? Buffer.alloc(0);
  const shared = Math.min(old.length, now.length);
  let start = 0;
  while (start < shared && old[start] === now[start]) start++;

  let line = 0;
  for (let newline = now.indexOf(0x0a); newline !== -1 && newline < start; newline = now.indexOf(0x0a, newline + 1)) line++;
  return line;
}

/**
 * @param {Store} store
 * @param {HookInput} input
 */
function dropStagedEdit(store, input) {
  const key = toolCallKey(input);
  if (key !== null) store.dropStaging(key);
}

/**
 * No hook runs before a shell command, so the old bytes cannot be saved first. Instead, with
 * `bashEditDiffEnabled` on, Claude Code reports what the command changed as git hunks in
 * `tool_response.bashEditDiff`. A modified file's baseline is rebuilt by undoing those hunks on its
 * current bytes, and recorded only when reverse-diff.mjs can prove the result. Without the report
 * this does nothing.
 * @param {Store} store
 * @param {HookInput} input
 */
function trackShellEdits(store, input) {
  const report = input.tool_response?.bashEditDiff;
  const files = report?.files;
  if (!Array.isArray(files)) return;

  const edits = files.map((file) => {
    try {
      return shellEdit(store, file);
    } catch (error) {
      store.logError('bash', error);
      return null;
    }
  });

  // A rename arrives as a deleted file and a created one. Recording only the created one would let
  // Discard trash the only copy of the content, so created files are recorded only when every file
  // of the command is accounted for: nothing was cut from the report and no file is unknown.
  const complete = report.moreFiles === 0 && !edits.includes(null);

  for (const edit of edits) {
    if (edit === null) continue;
    if (edit.baseline === null) {
      // Already pending, or only a mode change: addSessionDir leaves a file without an entry alone.
      noteSession(store, 'bash', edit.path, sessionDir(input));
      continue;
    }
    if (!edit.baseline.existed && !complete) continue;
    makePending(store, 'bash', input, edit.path, edit.baseline);
  }
}

/**
 * @param {Store} store
 * @param {unknown} file one entry of `bashEditDiff.files`
 * @returns {ShellEdit | null} null when the file's old state cannot be proven
 * @throws on an entry in an unexpected shape, or a file that cannot be read
 */
function shellEdit(store, file) {
  const reported = /** @type {Record<string, unknown>} */ (file !== null && typeof file === 'object' ? file : {});
  const { filePath: path, hunks, created, deleted } = reported;
  if (typeof path !== 'string' || !isAbsolute(path) || !Array.isArray(hunks)) {
    throw new Error('unexpected entry in bashEditDiff.files');
  }

  // As for Claude's own edits, the older baseline of a pending file stays.
  if (store.readMeta(store.idFor(path)) !== null) return { path, baseline: null };

  // lstat, not stat: a symlink would be recorded under its target's identity, and Discard would
  // then act on the target.
  const stats = lstatOrNull(path);

  if (created === true) return stats?.isFile() ? { path, baseline: { existed: false, bytes: null } } : null;
  if (deleted === true) {
    // The hunks of a file that had content do not say whether its last line ended in a newline.
    return hunks.length === 0 && stats === null ? { path, baseline: { existed: true, bytes: Buffer.alloc(0) } } : null;
  }
  if (hunks.length === 0) return { path, baseline: null }; // a mode change: the bytes are the same
  if (!stats?.isFile()) return null;

  const current = snapshot(path).bytes;
  const before = current === null ? null : reverseApply(current, hunks);
  return before === null ? null : { path, baseline: { existed: true, bytes: before } };
}

/**
 * Decides what the file looked like before this edit. The bytes saved by
 * PreToolUse are exact, so they win unless the tool says the file was already
 * different when it wrote (the user kept or discarded something in the editor
 * between the two hooks). The tool's own `originalFile` is text and may be
 * normalised, so it is only trusted on a real disagreement.
 * @param {Store} store
 * @param {import('./store.mjs').Staged | null} staged
 * @param {string} path
 * @param {HookInput | undefined} response tool_response
 * @returns {Baseline | null} null when nothing reliable is known
 */
function chooseBaseline(store, staged, path, response) {
  const original = typeof response?.originalFile === 'string' ? response.originalFile : null;
  const toolSaysCreated = response?.type === 'create';

  // Staging is only meaningful for the file the tool actually wrote; another
  // hook may have rewritten the tool's path in between.
  if (staged !== null && store.idFor(staged.path) === store.idFor(path)) {
    if (staged.bytes === null) {
      return response?.type === 'update' && original !== null ? textBaseline(original) : { existed: false, bytes: null };
    }
    if (original !== null && !sameText(staged.bytes, original)) return textBaseline(original);
    return { existed: true, bytes: staged.bytes };
  }

  if (toolSaysCreated) return { existed: false, bytes: null };
  return original === null ? null : textBaseline(original);
}

/**
 * @param {Baseline} a
 * @param {Baseline} b
 * @returns {boolean} whether both describe the same file state (both absent, or identical bytes)
 */
function sameState(a, b) {
  return a.bytes === null || b.bytes === null ? a.bytes === b.bytes : a.bytes.equals(b.bytes);
}

/** @param {string} text @returns {Baseline} */
function textBaseline(text) {
  return { existed: true, bytes: Buffer.from(text, 'utf8') };
}

/**
 * Whether the tool's text view of a file agrees with the exact bytes. A BOM
 * or CRLF/LF difference is not a disagreement. Bytes that are not valid UTF-8
 * cannot be compared with text at all, so the exact bytes stand.
 * @param {Buffer} bytes
 * @param {string} text
 */
function sameText(bytes, text) {
  /** @param {string} value */
  const normalise = (value) => value.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  try {
    return normalise(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) === normalise(text);
  } catch {
    return true;
  }
}

/**
 * @param {string} path
 * @returns {Baseline} the file's current state
 * @throws if the path is not a regular file or is too large to track
 */
function snapshot(path) {
  let stats;
  try {
    stats = statSync(path); // follows symlinks, like the tool's own write
  } catch (error) {
    if (isMissing(error)) return { existed: false, bytes: null };
    throw error;
  }
  if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
  if (stats.size > MAX_TRACKED_BYTES) throw new Error(`file larger than ${MAX_TRACKED_BYTES} bytes is not tracked: ${path}`);
  return { existed: true, bytes: readFileSync(path) };
}

/**
 * @param {string} path
 * @returns {import('node:fs').Stats | null} null when nothing is at the path (a dangling symlink is something)
 */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** @param {unknown} error whether it says the path, or a directory above it, does not exist */
function isMissing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * @param {HookInput} input
 * @returns {string | null} absolute path the tool edits, or null if this call is not tracked
 */
function editedPath(input) {
  if (!TRACKED_TOOLS.has(input.tool_name)) return null;
  const target = input.tool_name === 'NotebookEdit' ? input.tool_input?.notebook_path : input.tool_input?.file_path;
  if (typeof target !== 'string' || target === '') return null;
  return resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), target);
}

/** @param {HookInput} input */
function toolCallKey(input) {
  return typeof input.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : null;
}

/** @param {HookInput} input */
function sessionOf(input) {
  return typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
}

/**
 * @param {Store} store
 * @param {HookInput} input
 */
function startSession(store, input) {
  store.sweep();
  const sessionId = sessionOf(input);
  // A resumed session already has a cursor and keeps it, so discards made
  // while it was closed are announced on its next prompt.
  if (sessionId !== null && store.getCursor(sessionId) === null) store.setCursor(sessionId, store.logSize());
}

/**
 * The UserPromptSubmit result: the discards since this session's last prompt
 * as extra context for Claude, or nothing.
 * @param {Store} store
 * @param {HookInput} input
 * @returns {string} JSON for stdout, or ''
 */
function promptOutput(store, input) {
  const sessionId = sessionOf(input);
  if (sessionId === null) return '';

  const cursor = store.getCursor(sessionId);
  if (cursor === null) {
    // First time this session is seen (the plugin was enabled mid-session):
    // start from now rather than replaying history Claude never saw.
    store.setCursor(sessionId, store.logSize());
    return '';
  }

  const { records, nextOffset } = store.readDiscards(cursor);
  if (nextOffset !== cursor) store.setCursor(sessionId, nextOffset);

  // The log is machine-wide; only files under this session's directory are
  // this session's business.
  const projectDir = canonicalDir(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const relevant = records.filter((record) => isInside(projectDir, record.path));
  if (relevant.length === 0) return '';

  const lines = relevant.slice(0, MAX_NOTE_ENTRIES).map((record) => {
    const what = record.scope === 'file' ? 'discarded all pending changes in this file' : 'discarded one change';
    const detail = record.detail ? ` (${clean(record.detail)})` : '';
    return `- ${clean(relative(projectDir, record.path))}: ${what}${detail}`;
  });
  if (relevant.length > lines.length) lines.push(`- ...and ${relevant.length - lines.length} more`);

  const note = [
    'The user reviewed pending changes in their editor and discarded some, so the files no longer contain them:',
    ...lines,
    'Some of these may be edits you made earlier. Re-read a file before editing it again, and do not re-apply discarded changes unless the user asks.',
  ].join('\n');

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note.slice(0, MAX_NOTE_LENGTH) },
  });
}

/**
 * File names and details come from disk, so they are flattened to one line
 * before they reach Claude's context.
 * @param {string} text
 */
function clean(text) {
  return String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, MAX_FIELD_LENGTH);
}

/** @param {string} dir */
function canonicalDir(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * @param {string} dir
 * @param {string} path
 */
function isInside(dir, path) {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

main().catch(() => {
  // Unreachable in practice (main handles its own errors); a hook must still exit 0.
});
