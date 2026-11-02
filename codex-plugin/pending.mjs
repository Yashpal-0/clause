// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LENGTH = 1024;

/** @typedef {{ root: string }} Store */
/** @typedef {{ path: string, key: string, identity: string }} CallFile */
/** @typedef {{ source: string, destination: string }} Move */
/** @typedef {{ key: string, cwd: string, root: string, callId: string, transcriptPath: string | null, offset: number, files: CallFile[], moves: Move[] }} Call */
/** @typedef {Omit<Call, 'offset'> & { offset?: number }} CallInput */

/** @param {Store} store @param {string} sessionId @param {CallInput} call @returns {Call} */
export function saveCall(store, sessionId, call) {
  let transcriptPath = call.transcriptPath;
  let offset = call.offset;
  if (offset === undefined) {
    offset = 0;
    if (validPath(transcriptPath)) {
      try {
        const stat = statSync(transcriptPath);
        if (stat.isFile()) offset = stat.size;
        else transcriptPath = null;
      } catch { transcriptPath = null; }
    }
  }
  const saved = { ...call, transcriptPath, offset };
  if (!validCall(saved)) throw new TypeError('invalid Codex call metadata');
  saved.root = sessionRoot(store, sessionId, saved.root);
  const text = JSON.stringify(saved);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new TypeError('invalid Codex call metadata');
  atomicWrite(callPath(store, sessionId, saved.key), text);
  return saved;
}

/** @param {Store} store @param {string} sessionId @returns {Call[]} */
export function readCalls(store, sessionId) {
  const dir = callsDir(store, sessionId);
  let names;
  try { names = readdirSync(dir); }
  catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  /** @type {Call[]} */
  const calls = [];
  for (const name of names) {
    if (!/^[a-f\d]{64}\.json$/.test(name)) continue;
    const value = readJson(join(dir, name), MAX_RECORD_BYTES);
    if (validCall(value) && name === `${hash(value.key)}.json`) calls.push(value);
  }
  return calls;
}

/** @param {Call} call @returns {string[] | null} */
export function completedPaths(call) {
  if (call.transcriptPath === null) return null;
  let fd;
  try { fd = openSync(call.transcriptPath, 'r'); }
  catch { return null; }
  try {
    const size = fstatSync(fd).size - call.offset;
    if (size < 0 || size > 64 * 1024 * 1024) return null;
    const bytes = Buffer.alloc(size);
    const length = readSync(fd, bytes, 0, bytes.length, call.offset);
    for (const line of bytes.subarray(0, length).toString('utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const result = row?.payload;
      if (row?.type !== 'response_item' || result?.call_id !== call.callId ||
          !['custom_tool_call_output', 'function_call_output'].includes(result?.type)) continue;
      // Execution results carry this frame; denied calls do not, so their snapshots must not be promoted.
      if (typeof result.output !== 'string' || !/^Exit code: -?\d+\r?\nWall time:[^\n]*\r?\nOutput:\r?\n/.test(result.output)) return [];
      return call.files.map((file) => file.path);
    }
    return null;
  } finally { closeSync(fd); }
}

/** @param {Store} store @param {string} sessionId @param {string} key */
export function removeCall(store, sessionId, key) {
  try { unlinkSync(callPath(store, sessionId, key)); }
  catch (error) { if (!missing(error)) throw error; }
}

/** @param {Store} store @param {string} sessionId @param {string} [cwd] @returns {string} */
export function sessionRoot(store, sessionId, cwd) {
  const path = join(callsDir(store, sessionId), 'session.json');
  let value = readJson(path, MAX_PATH_LENGTH * 4 + 1024);
  if (value === null) {
    if (!validPath(cwd)) throw new TypeError('invalid Codex session root');
    let root = cwd;
    try { root = realpathSync(cwd); } catch {}
    atomicWrite(path, JSON.stringify({ root }), true);
    value = readJson(path, MAX_PATH_LENGTH * 4 + 1024);
  }
  if (!validPath(value?.root)) throw new TypeError('invalid Codex session root');
  return value.root;
}

/** @param {Store} store @param {string} sessionId */
function callsDir(store, sessionId) {
  if (!validPath(store.root) || !validId(sessionId)) throw new TypeError('invalid Codex session metadata');
  return join(store.root, 'codex-calls', hash(sessionId));
}

/** @param {Store} store @param {string} sessionId @param {string} key */
function callPath(store, sessionId, key) {
  if (!validId(key)) throw new TypeError('invalid Codex call metadata');
  return join(callsDir(store, sessionId), `${hash(key)}.json`);
}

/** @param {string} path @param {string} text @param {boolean} [firstOnly] */
function atomicWrite(path, text, firstOnly = false) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scratch = join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    const fd = openSync(scratch, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (firstOnly) {
      try { linkSync(scratch, path); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    } else renameSync(scratch, path);
    // Some platforms cannot sync directories; the metadata has already been published atomically.
    try {
      const directory = openSync(dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {}
  } finally {
    try { unlinkSync(scratch); }
    catch (error) { if (!missing(error)) throw error; }
  }
}

/** @param {string} path @param {number} maximum @returns {any} */
function readJson(path, maximum) {
  let fd;
  try { fd = openSync(path, 'r'); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maximum) return null;
    try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { return null; }
  } finally { closeSync(fd); }
}

/** @param {unknown} value @returns {value is Call} */
function validCall(value) {
  if (value === null || typeof value !== 'object') return false;
  const call = /** @type {Call} */ (value);
  return validId(call.key) && validId(call.callId) && validPath(call.cwd) && validPath(call.root) &&
    (call.transcriptPath === null || validPath(call.transcriptPath)) &&
    Number.isSafeInteger(call.offset) && call.offset >= 0 &&
    Array.isArray(call.files) && call.files.length <= MAX_FILES && call.files.every((file) =>
      file !== null && typeof file === 'object' && validPath(file.path) && validId(file.key) &&
      typeof file.identity === 'string' && /^[a-f\d]{64}$/.test(file.identity)) &&
    Array.isArray(call.moves) && call.moves.length <= MAX_FILES && call.moves.every((move) =>
      move !== null && typeof move === 'object' && validPath(move.source) && validPath(move.destination));
}

/** @param {unknown} value @returns {value is string} */
function validPath(value) {
  return typeof value === 'string' && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && isAbsolute(value);
}

/** @param {unknown} value @returns {value is string} */
function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** @param {string} value */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** @param {unknown} error @param {string} code */
function hasCode(error, code) { return error instanceof Error && 'code' in error && error.code === code; }

/** @param {unknown} error */
function missing(error) { return hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR'); }
