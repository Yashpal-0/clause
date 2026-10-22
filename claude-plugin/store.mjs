// @ts-check
//
// On-disk store shared by the Claude Code hooks (writers) and the VS Code
// extension (reader, and writer of baselines and discards). Nothing else
// touches these files, so every format decision lives here.
//
//   <root>/entries/<id>/meta.json   { v, path, existed, createdAt }; exists => the file is pending
//   <root>/entries/<id>/base        exact bytes from before Claude's first change (absent iff !existed)
//   <root>/entries/<id>/touched     { v, at, tool, line }; Claude's latest edit to the file, a hint (optional)
//   <root>/entries/<id>/sessions    { v, dirs }; folders the Claude sessions that changed the file were started in, a hint (optional)
//   <root>/staging/<key>/...        pre-edit bytes captured by PreToolUse, consumed by PostToolUse
//   <root>/discards.jsonl           append-only record of edits the user discarded
//   <root>/cursors/<session>        byte offset into discards.jsonl already told to that session
//   <root>/errors.log               hook failures (hooks must never block Claude)
//   <root>/tmp, <root>/trash        scratch space; same filesystem as entries/ so rename(2) is atomic
//
// Entries are directories so that creating one is a single rename(2): the
// first creator wins and a crash can never leave a baseline without its
// metadata (or the reverse).

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const FORMAT_VERSION = 1;

/** errors.log is rotated once it passes this size, so a failing hook cannot fill the disk. */
const MAX_ERROR_LOG_BYTES = 256 * 1024;

/** A single error line is cut to this length to keep the log line-oriented. */
const MAX_ERROR_LINE = 2000;

/** Caps a discard record's free text so each log line stays one small append. */
const MAX_DETAIL = 2000;

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Far above the largest record `touch` writes (a 200-character tool id made of
 * control characters JSON-escapes to about 1.2 KiB), so it only turns away
 * files nobody here wrote.
 */
const MAX_TOUCH_BYTES = 4096;

/** Real tool_use_ids are about 30 characters; the cap keeps a hostile one from bloating the record. */
const MAX_TOOL_ID = 200;

/**
 * A file rarely has more than a few distinct session folders. The cap bounds
 * the record and the work an editor does each time it reads one; past it the
 * oldest folder is dropped.
 */
const MAX_SESSION_DIRS = 16;

/** Far above a full record (16 folders of 1024 characters), so it only turns away files nobody here wrote. */
const MAX_SESSIONS_BYTES = 64 * 1024;

/** Real project folders are far shorter; the cap keeps a record of `MAX_SESSION_DIRS` of them under `MAX_SESSIONS_BYTES`. */
const MAX_SESSION_DIR_LENGTH = 1024;

const SESSION_DIR_RULE = `the session folder must be an absolute path of at most ${MAX_SESSION_DIR_LENGTH} characters`;

/** Bounds what a reader believes about a line number; a real one is limited by the size of the file. */
const MAX_LINE = 1e9;

/**
 * @typedef {object} EntryMeta
 * @property {string} id sha256 (hex) of the canonical path
 * @property {string} path canonical (symlink-free) absolute path of the pending file
 * @property {boolean} existed false when Claude created the file
 * @property {string} createdAt ISO timestamp of Claude's first change
 */

/**
 * @typedef {EntryMeta & { base: Buffer | null, sessionDirs: string[] }} Entry
 *   `base` is null exactly when `existed` is false. `sessionDirs` is empty for
 *   an entry made before sessions were recorded.
 */

/**
 * @typedef {object} Staged
 * @property {string} path
 * @property {boolean} existed
 * @property {Buffer | null} bytes null exactly when `existed` is false
 */

/**
 * @typedef {object} Touch
 * @property {number} at epoch milliseconds of Claude's latest edit to the file
 * @property {string} tool tool_use_id of that edit; a different value means a newer edit
 * @property {number} line 0-based line holding the first byte that edit changed
 */

/**
 * @typedef {object} DiscardRecord
 * @property {number} v
 * @property {string} ts ISO timestamp
 * @property {string} path canonical absolute path
 * @property {'block' | 'file'} scope
 * @property {string} [detail] short human-readable description, shown to Claude
 */

/**
 * Where the store lives. `CLAUDE_PENDING_EDITS_DIR` exists so tests never touch
 * the real store; a relative value is rejected rather than ignored, because
 * ignoring it would silently write test data into the user's real store.
 * @param {Record<string, string | undefined>} [env]
 */
export function defaultRoot(env = process.env) {
  const override = env.CLAUDE_PENDING_EDITS_DIR;
  if (override === undefined || override === '') return join(homedir(), '.claude', 'pending-edits');
  if (!isAbsolute(override)) throw new Error('CLAUDE_PENDING_EDITS_DIR must be an absolute path');
  return override;
}

/**
 * Opens (lazily creating) the store at `root`. All methods are synchronous:
 * the files are small, local and touched a few times per edit.
 * @param {string} [root]
 */
export function openStore(root = defaultRoot()) {
  const entriesDir = join(root, 'entries');
  const stagingDir = join(root, 'staging');
  const tmpDir = join(root, 'tmp');
  const trashDir = join(root, 'trash');
  const cursorsDir = join(root, 'cursors');
  const logFile = join(root, 'discards.jsonl');
  const errorsFile = join(root, 'errors.log');

  /**
   * Stable identity of a file: its path after resolving symlinks, so the same
   * file reached through two routes is one entry. A file that does not exist
   * yet is resolved through its nearest existing parent.
   * @param {string} path absolute
   */
  function idFor(path) {
    return hash(canonicalPath(path));
  }

  /**
   * Creates the entries directory if it is not there yet and returns it, so a
   * watcher can be placed on it before the first entry exists.
   * @returns {string}
   */
  function ensureEntriesDir() {
    mkdirp(entriesDir);
    return entriesDir;
  }

  /**
   * Records that Claude changed `path`, keeping `base` as the pending file's
   * baseline. The first creator wins: if an entry already exists nothing is
   * written and false is returned, so a baseline is never replaced by a later,
   * already-edited version.
   * @param {{ path: string, existed: boolean, base: Buffer | null, sessionDir?: string }} entry
   *   `sessionDir` is the folder the Claude session was started in. It is
   *   published together with the entry, so no reader sees the entry without it.
   * @returns {boolean} true if this call created the entry
   */
  function createEntry({ path, existed, base, sessionDir }) {
    if (existed !== (base !== null)) {
      throw new TypeError('createEntry: base bytes are required exactly when the file existed');
    }
    if (sessionDir !== undefined && !isSessionDir(sessionDir)) throw new TypeError(`createEntry: ${SESSION_DIR_RULE}`);
    const canonical = canonicalPath(path);
    const final = join(entriesDir, hash(canonical));
    const meta = { v: FORMAT_VERSION, path: canonical, existed, createdAt: new Date().toISOString() };
    /** @type {Record<string, Buffer>} */
    const files = { 'meta.json': Buffer.from(JSON.stringify(meta)) };
    if (base) files.base = base;
    if (sessionDir !== undefined) files.sessions = Buffer.from(sessionsRecord([sessionDir]));
    mkdirp(entriesDir);
    const created = publishDir(final, files);
    if (created) fsyncDir(entriesDir);
    return created;
  }

  /**
   * @param {string} id
   * @returns {EntryMeta | null} null when absent, mid-removal or unreadable
   */
  function readMeta(id) {
    const dir = entryDir(id);
    let text;
    try {
      text = readFileSync(join(dir, 'meta.json'), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      if (
        parsed?.v !== FORMAT_VERSION ||
        typeof parsed.path !== 'string' ||
        typeof parsed.existed !== 'boolean' ||
        typeof parsed.createdAt !== 'string'
      ) {
        throw new Error('unexpected shape or version');
      }
      return { id, path: parsed.path, existed: parsed.existed, createdAt: parsed.createdAt };
    } catch (error) {
      logError(`corrupt entry ${id}`, error);
      return null;
    }
  }

  /**
   * @param {string} id
   * @returns {Entry | null}
   */
  function readEntry(id) {
    const meta = readMeta(id);
    if (!meta) return null;
    const sessionDirs = readSessionDirs(id);
    if (!meta.existed) return { ...meta, base: null, sessionDirs };
    try {
      return { ...meta, base: readFileSync(join(entryDir(id), 'base')), sessionDirs };
    } catch (error) {
      if (!isMissing(error)) throw error;
      // The whole directory vanishing means a concurrent removeEntry; a
      // directory that is still there without its baseline is damage.
      if (existsSync(entryDir(id))) logError(`corrupt entry ${id}`, new Error('baseline missing'));
      return null;
    }
  }

  /** @returns {EntryMeta[]} every readable entry, without baseline bytes */
  function listEntries() {
    return readNames(entriesDir)
      .filter((name) => ID_PATTERN.test(name))
      .map((name) => readMeta(name))
      .filter((meta) => meta !== null);
  }

  /**
   * Replaces an existing entry's baseline (the user kept a block). Never
   * creates an entry. Not valid for a file Claude created: that baseline is
   * "no file" and only ever disappears.
   * @param {string} id
   * @param {Buffer} bytes
   * @returns {boolean} false if the entry no longer exists
   */
  function writeBase(id, bytes) {
    const meta = readMeta(id);
    if (!meta) return false;
    if (!meta.existed) throw new TypeError('writeBase: the file was created by Claude and has no baseline');
    mkdirp(tmpDir);
    const scratch = join(tmpDir, `${id}.${uniqueSuffix()}`);
    try {
      writeDurable(scratch, bytes);
      renameSync(scratch, join(entryDir(id), 'base'));
    } catch (error) {
      rmSync(scratch, { force: true });
      if (isMissing(error)) return false;
      throw error;
    }
    fsyncDir(entryDir(id));
    return true;
  }

  /**
   * The user kept or discarded everything Claude changed in this file.
   * @param {string} id
   * @returns {boolean} false if there was no such entry
   */
  function removeEntry(id) {
    const grave = join(trashDir, `${id}.${uniqueSuffix()}`);
    mkdirp(trashDir);
    try {
      renameSync(entryDir(id), grave);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      rmSync(grave, { recursive: true, force: true });
    } catch (error) {
      logError('removeEntry cleanup', error); // sweep() collects it later
    }
    return true;
  }

  /**
   * Records Claude's latest edit to a pending file so an editor can open the
   * file at the change. It is a hint, not state, so it skips the fsync that
   * baselines get: a record lost to a crash costs one missed auto-open. Never
   * creates an entry; touching one that was just kept or discarded does nothing.
   * @param {string} id
   * @param {{ tool: string, line: number }} info refused unless `readTouch` would accept the record
   * @returns {boolean} false if the entry no longer exists
   */
  function touch(id, { tool, line }) {
    if (!isToolId(tool)) throw new TypeError(`touch: tool must be a string of 1 to ${MAX_TOOL_ID} characters`);
    if (!isLine(line)) throw new TypeError(`touch: line must be an integer from 0 to ${MAX_LINE}`);
    const target = join(entryDir(id), 'touched');
    mkdirp(tmpDir);
    // Built in tmp/ rather than the entry directory: a scratch file there would be one more event for every watching editor.
    const scratch = join(tmpDir, `${id}.${uniqueSuffix()}`);
    try {
      writeFileSync(scratch, JSON.stringify({ v: FORMAT_VERSION, at: Date.now(), tool, line }), { flag: 'wx', mode: 0o600 });
      renameSync(scratch, target);
    } catch (error) {
      rmSync(scratch, { force: true });
      if (isMissing(error)) return false;
      throw error;
    }
    return true;
  }

  /**
   * @param {string} id
   * @returns {Touch | null} null when the entry was never touched, is gone, or
   *   holds anything but the record `touch` writes: a hint must not be able to
   *   break the reader that asks for it
   */
  function readTouch(id) {
    const text = readCapped(join(entryDir(id), 'touched'), MAX_TOUCH_BYTES, 'readTouch');
    return text === null ? null : parseTouch(text);
  }

  /**
   * Notes that a Claude session started in `dir` changed the file of a
   * pending entry, so an editor can tell whose changes it is looking at. Never
   * creates an entry.
   *
   * shortcut: read-modify-write, so two sessions adding at the same instant
   * can lose one folder; that file then stays unattributed until the session
   * edits it again. Upgrade to one file per folder if it ever shows up.
   * @param {string} id
   * @param {string} dir absolute, canonical folder the session was started in
   * @returns {boolean} false if `dir` is already listed or the entry no longer exists
   */
  function addSessionDir(id, dir) {
    if (!isSessionDir(dir)) throw new TypeError(`addSessionDir: ${SESSION_DIR_RULE}`);
    const dirs = readSessionDirs(id);
    if (dirs.includes(dir)) return false;

    const target = join(entryDir(id), 'sessions');
    mkdirp(tmpDir);
    // Built in tmp/ for the same reason as `touch`'s record: a scratch file in the entry directory is one more event for every watching editor.
    const scratch = join(tmpDir, `${id}.${uniqueSuffix()}`);
    try {
      writeFileSync(scratch, sessionsRecord([...dirs, dir].slice(-MAX_SESSION_DIRS)), { flag: 'wx', mode: 0o600 });
      renameSync(scratch, target);
    } catch (error) {
      rmSync(scratch, { force: true });
      if (isMissing(error)) return false;
      throw error;
    }
    return true;
  }

  /**
   * @param {string} id
   * @returns {string[]} the folders, oldest first; empty for an entry made
   *   before sessions were recorded, one that is gone, and anything but the
   *   record `createEntry` and `addSessionDir` write
   */
  function readSessionDirs(id) {
    const text = readCapped(join(entryDir(id), 'sessions'), MAX_SESSIONS_BYTES, 'readSessionDirs');
    return text === null ? [] : parseSessions(text);
  }

  /**
   * Reads a small record file that nothing guarantees is well formed.
   * @param {string} file
   * @param {number} maxBytes
   * @param {string} context names the caller in errors.log
   * @returns {string | null} null for a file that is missing, larger than
   *   `maxBytes` or unreadable; only the last is logged
   */
  function readCapped(file, maxBytes, context) {
    try {
      const fd = openSync(file, 'r');
      try {
        if (fstatSync(fd).size > maxBytes) return null;
        return readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!isMissing(error)) logError(context, error);
      return null;
    }
  }

  /**
   * Keeps the pre-edit state of a file between PreToolUse and PostToolUse,
   * which run in separate processes. `path` is stored verbatim.
   * @param {string} key tool call id (any string; hashed if it is not filename-safe)
   * @param {Staged} staged
   */
  function stage(key, { path, existed, bytes }) {
    if (existed !== (bytes !== null)) {
      throw new TypeError('stage: bytes are required exactly when the file existed');
    }
    /** @type {Record<string, Buffer>} */
    const files = { 'meta.json': Buffer.from(JSON.stringify({ path, existed })) };
    if (bytes) files.base = bytes;
    const final = join(stagingDir, safeName(key));
    mkdirp(stagingDir);
    rmSync(final, { recursive: true, force: true });
    publishDir(final, files);
  }

  /**
   * @param {string} key
   * @returns {Staged | null}
   */
  function readStaging(key) {
    const dir = join(stagingDir, safeName(key));
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      const bytes = meta.existed ? readFileSync(join(dir, 'base')) : null;
      return { path: meta.path, existed: meta.existed, bytes };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** @param {string} key */
  function dropStaging(key) {
    rmSync(join(stagingDir, safeName(key)), { recursive: true, force: true });
  }

  /**
   * Deletes staging, scratch and trash older than `maxAgeMs`: leftovers of tool
   * calls that were denied, interrupted or never reported back. Entries and the
   * logs are never touched.
   * @param {{ maxAgeMs?: number, now?: number }} [options]
   */
  function sweep({ maxAgeMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
    for (const dir of [stagingDir, tmpDir, trashDir]) {
      for (const name of readNames(dir)) {
        const target = join(dir, name);
        try {
          if (statSync(target).mtimeMs < now - maxAgeMs) rmSync(target, { recursive: true, force: true });
        } catch (error) {
          if (!isMissing(error)) logError('sweep', error);
        }
      }
    }
  }

  /**
   * Tells future Claude prompts that the user discarded something. One
   * O_APPEND write per record, so concurrent windows cannot interleave lines.
   * @param {{ path: string, scope: 'block' | 'file', detail?: string }} discard
   */
  function appendDiscard({ path, scope, detail }) {
    /** @type {DiscardRecord} */
    const record = { v: FORMAT_VERSION, ts: new Date().toISOString(), path, scope };
    if (detail !== undefined) record.detail = detail.slice(0, MAX_DETAIL);
    mkdirp(root);
    const fd = openSync(logFile, 'a', 0o600);
    try {
      writeSync(fd, Buffer.from(JSON.stringify(record) + '\n'));
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reads whole records that start at or after byte `offset`. A trailing line
   * without its newline is a write in progress and is left for the next read.
   * An offset past the end (log replaced or truncated) counts as caught up.
   * @param {number} offset
   * @returns {{ records: DiscardRecord[], nextOffset: number }}
   */
  function readDiscards(offset) {
    let fd;
    try {
      fd = openSync(logFile, 'r');
    } catch (error) {
      if (isMissing(error)) return { records: [], nextOffset: 0 };
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (offset >= size) return { records: [], nextOffset: size };
      const chunk = Buffer.alloc(size - offset);
      let filled = 0;
      while (filled < chunk.length) {
        const n = readSync(fd, chunk, filled, chunk.length - filled, offset + filled);
        if (n === 0) break;
        filled += n;
      }
      const end = chunk.subarray(0, filled).lastIndexOf(0x0a);
      if (end < 0) return { records: [], nextOffset: offset };
      /** @type {DiscardRecord[]} */
      const records = [];
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.path === 'string' && (parsed.scope === 'block' || parsed.scope === 'file')) {
            records.push(parsed);
          }
        } catch {
          // A line that is not JSON cannot be told to Claude; skipping it keeps later records readable.
        }
      }
      return { records, nextOffset: offset + end + 1 };
    } finally {
      closeSync(fd);
    }
  }

  /** @returns {number} current end of discards.jsonl, 0 if there is none */
  function logSize() {
    try {
      return statSync(logFile).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  /**
   * @param {string} sessionId
   * @returns {number | null} offset into discards.jsonl this session was last told about
   */
  function getCursor(sessionId) {
    try {
      const value = Number.parseInt(readFileSync(join(cursorsDir, safeName(sessionId)), 'utf8'), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * @param {string} sessionId
   * @param {number} offset
   */
  function setCursor(sessionId, offset) {
    mkdirp(cursorsDir);
    mkdirp(tmpDir);
    const scratch = join(tmpDir, `cursor.${uniqueSuffix()}`);
    writeDurable(scratch, Buffer.from(String(offset)));
    renameSync(scratch, join(cursorsDir, safeName(sessionId)));
  }

  /**
   * Last-resort diagnostics. Never throws and never records file contents or
   * prompts, only what failed.
   * @param {string} context
   * @param {unknown} error
   */
  function logError(context, error) {
    try {
      mkdirp(root);
      try {
        if (statSync(errorsFile).size > MAX_ERROR_LOG_BYTES) renameSync(errorsFile, `${errorsFile}.1`);
      } catch {
        // No log yet, or it vanished during rotation: appending below recreates it.
      }
      const code = error instanceof Error && 'code' in error ? ` [${String(error.code)}]` : '';
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const line = `${new Date().toISOString()} ${context}${code}: ${reason}`.replace(/\s+/g, ' ');
      const fd = openSync(errorsFile, 'a', 0o600);
      try {
        writeSync(fd, `${line.slice(0, MAX_ERROR_LINE)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Nowhere left to report to; the hook's caller must still proceed.
    }
  }

  /**
   * The directory an entry's files are kept in. A watcher belongs on this
   * directory, not on a file in it: files are replaced by rename, and a watch
   * on the replaced file goes quiet.
   * @param {string} id
   */
  function entryDir(id) {
    if (!ID_PATTERN.test(id)) throw new TypeError(`invalid entry id: ${id}`);
    return join(entriesDir, id);
  }

  /**
   * Creates `final` holding `files` in one atomic rename, so readers see
   * either nothing or every file.
   * @param {string} final
   * @param {Record<string, Buffer>} files
   * @returns {boolean} false if `final` already exists (first writer wins)
   */
  function publishDir(final, files) {
    mkdirp(tmpDir);
    const scratch = join(tmpDir, `${basename(final)}.${uniqueSuffix()}`);
    mkdirSync(scratch, { mode: 0o700 });
    try {
      for (const [name, data] of Object.entries(files)) writeDurable(join(scratch, name), data);
      fsyncDir(scratch);
      try {
        renameSync(scratch, final);
      } catch (error) {
        if (isCode(error, 'EEXIST') || isCode(error, 'ENOTEMPTY')) return false;
        throw error;
      }
      return true;
    } finally {
      rmSync(scratch, { recursive: true, force: true }); // no-op once renamed
    }
  }

  return Object.freeze({
    root,
    idFor,
    ensureEntriesDir,
    entryDir,
    createEntry,
    readMeta,
    readEntry,
    listEntries,
    writeBase,
    removeEntry,
    touch,
    readTouch,
    addSessionDir,
    readSessionDirs,
    stage,
    readStaging,
    dropStaging,
    sweep,
    appendDiscard,
    readDiscards,
    logSize,
    getCursor,
    setCursor,
    logError,
  });
}

const ID_PATTERN = /^[0-9a-f]{1,64}$/;
const FILENAME_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

/** @param {string} text */
function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Tool call and session ids are filename-safe in practice; anything else is
 * hashed so a hostile id cannot name a path outside its directory.
 * @param {string} key
 */
function safeName(key) {
  return FILENAME_SAFE.test(key) ? key : hash(key);
}

function uniqueSuffix() {
  return `${process.pid}.${randomBytes(4).toString('hex')}`;
}

/**
 * @param {string} path absolute
 * @returns {string} path with every existing symlink resolved
 */
function canonicalPath(path) {
  if (!isAbsolute(path)) throw new TypeError(`path must be absolute: ${path}`);
  let existing = resolve(path);
  /** @type {string[]} */
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** @param {string} dir */
function mkdirp(dir) {
  // Entries hold copies of the user's source files: keep them private.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Writes `data` so it is on disk when this returns. The file must not exist.
 * @param {string} file
 * @param {Buffer} data
 */
function writeDurable(file, data) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes a rename inside `dir` survive power loss. Not every platform or
 * filesystem lets a directory be fsynced, and the rename itself already
 * succeeded, so failure here is not an error.
 * @param {string} dir
 */
function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // See above.
  }
}

/**
 * @param {string} dir
 * @returns {string[]} [] when the directory does not exist yet
 */
function readNames(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * @param {string} text
 * @returns {Touch | null}
 */
function parseTouch(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { v, at, tool, line } = parsed;
  if (v !== FORMAT_VERSION || !Number.isFinite(at) || at < 0 || !isToolId(tool) || !isLine(line)) return null;
  return { at, tool, line };
}

/** @param {string[]} dirs @returns {string} */
function sessionsRecord(dirs) {
  return JSON.stringify({ v: FORMAT_VERSION, dirs });
}

/**
 * @param {string} text
 * @returns {string[]} empty unless the text is exactly what `sessionsRecord` writes
 */
function parseSessions(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const { v, dirs } = parsed;
  if (v !== FORMAT_VERSION || !Array.isArray(dirs) || dirs.length > MAX_SESSION_DIRS || !dirs.every(isSessionDir)) return [];
  return dirs;
}

/**
 * Exported so a caller can check a folder before `createEntry` refuses it: a refused folder must not cost the file its entry.
 * @param {unknown} dir
 * @returns {dir is string}
 */
export function isSessionDir(dir) {
  return typeof dir === 'string' && dir.length <= MAX_SESSION_DIR_LENGTH && isAbsolute(dir);
}

/** @param {unknown} tool @returns {tool is string} */
function isToolId(tool) {
  return typeof tool === 'string' && tool.length >= 1 && tool.length <= MAX_TOOL_ID;
}

/** @param {unknown} line @returns {line is number} */
function isLine(line) {
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 && line <= MAX_LINE;
}

/** @param {unknown} error @param {string} code */
function isCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param {unknown} error */
function isMissing(error) {
  return isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR');
}
