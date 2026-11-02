#!/usr/bin/env node
// @ts-check

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../claude-plugin/store.mjs';
import { completedPaths, readCalls, removeCall, saveCall, sessionRoot } from './pending.mjs';

const SHARED_HOOK = fileURLToPath(new URL('../claude-plugin/hook.mjs', import.meta.url));
const PATCH_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: '];
const PARALLEL_HOOKS = 4;
const HOOK_TIMEOUT_MS = 10_000;
// Leave five seconds for cleanup before Codex's configured 60-second hook timeout.
const PATCH_TIMEOUT_MS = 55_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** @typedef {Record<string, any>} HookInput */
/** @typedef {import('./pending.mjs').Call} Call */
/** @typedef {ReturnType<typeof openStore>} Store */

async function main() {
  const event = process.argv[2] ?? '';
  const deadline = Date.now() + (event === 'prompt' || event === 'session-start' ? 8_000 : PATCH_TIMEOUT_MS);
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) throw new Error('hook input exceeds 64 MiB');
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new Error('unreadable hook input'); }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return;
    if (typeof input.session_id !== 'string' || input.session_id === '') return;
    const session_id = `codex-${input.session_id}`;
    const store = openStore();
    const root = sessionRoot(store, session_id, input.cwd);
    if (event !== 'post') await settleCalls(store, session_id, deadline);
    if (event === 'session-start' || event === 'prompt') {
      const stdout = await runHook(event, { session_id, cwd: root }, deadline);
      if (event === 'prompt') process.stdout.write(stdout);
      return;
    }
    if (event === 'settle') return;
    if (event !== 'pre' && event !== 'post') return;
    if (typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return;
    if (typeof input.tool_input?.command !== 'string') return;
    let command = input.tool_input.command;
    if (input.tool_name === 'Bash') {
      const envelope = command.match(/^\s*apply_patch\s+<<\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*)\r?\n\2\s*$/);
      if (envelope === null) return;
      command = envelope[3];
    } else if (input.tool_name !== 'apply_patch') return;
    const patchLines = command.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').split('\n');
    // Remote environment hooks report a host cwd, which cannot identify the files the patch changes.
    if (patchLines[0]?.replace(/\p{White_Space}+$/u, '') === '*** Begin Patch' &&
        patchLines[1]?.replace(/^\p{White_Space}+/u, '').startsWith('*** Environment ID:')) return;

    const prefix = `${createHash('sha256').update(JSON.stringify([session_id, input.turn_id, input.tool_use_id])).digest('hex').slice(0, 32)}-`;
    /** @type {{ source: string, destination: string }[]} */
    const moves = [];
    let source = '';
    let section = '';
    const paths = Array.from(new Set(patchLines.flatMap((/** @type {string} */ line) => {
      // Codex trims header indentation outside updates, where leading spaces denote file context.
      const candidate = section === '*** Update File: ' ? line : line.replace(/^\p{White_Space}+/u, '');
      const header = PATCH_HEADERS.find((prefix) => candidate.startsWith(prefix));
      const path = header === undefined ? '' : candidate.slice(header.length).replace(/\p{White_Space}+$/u, '');
      if (header !== undefined && header !== '*** Move to: ') section = header;
      if (header === '*** Update File: ') source = resolve(input.cwd, path);
      if (header === '*** Move to: ' && source !== '' && path !== '') moves.push({ source, destination: resolve(input.cwd, path) });
      return path === '' ? [] : [resolve(input.cwd, path)];
    })));
    const files = paths.map((path) => ({
      path, identity: store.idFor(path),
      // Include the real identity so a retargeted or deleted symlink cannot promote another file's bytes.
      key: prefix + createHash('sha256').update(JSON.stringify([path, store.idFor(path)])).digest('hex'),
    }));
    const call = { key: prefix, cwd: input.cwd, root, callId: input.tool_use_id,
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null, files, moves };
    try {
      if (event === 'pre') {
        clearStaging(store, prefix);
        await runForFiles(event, files.map((file) => payload(session_id, root, file)), deadline);
        if (files.length > 0 && files.every((file) => store.readStaging(file.key) !== null)) {
          saveCall(store, session_id, call);
          return;
        }
        clearStaging(store, prefix);
        removeCall(store, session_id, prefix);
        logError(event, new Error('patch skipped because a snapshot is missing'));
      } else {
        const saved = readCalls(store, session_id).find((candidate) => candidate.key === prefix);
        await promoteCall(store, session_id, saved ?? { ...call, offset: 0 }, paths, deadline);
      }
    } finally {
      if (event === 'post') { clearStaging(store, prefix); removeCall(store, session_id, prefix); }
    }
  } catch (error) {
    logError(event, error);
  }
}

/** @param {Store} store @param {string} sessionId @param {number} deadline */
async function settleCalls(store, sessionId, deadline) {
  for (const call of readCalls(store, sessionId).sort((a, b) => a.offset - b.offset)) {
    if (Date.now() >= deadline) return;
    const paths = completedPaths(call);
    if (paths === null) {
      if (!call.files.some((file) => store.readStaging(file.key) !== null)) removeCall(store, sessionId, call.key);
      continue;
    }
    try { await promoteCall(store, sessionId, call, paths, deadline); }
    finally { clearStaging(store, call.key); removeCall(store, sessionId, call.key); }
  }
}

/** @param {Store} store @param {string} sessionId @param {Call} call @param {string[]} changed @param {number} deadline */
async function promoteCall(store, sessionId, call, changed, deadline) {
  if (!call.files.every((file) => store.idFor(file.path) === file.identity && store.readStaging(file.key) !== null)) {
    logError('post', new Error('patch skipped because a snapshot is missing or a file identity changed'));
    return;
  }
  const originals = new Map(call.moves.map((move) => {
    const file = call.files.find((candidate) => candidate.path === move.source);
    const staged = file === undefined ? null : store.readStaging(file.key);
    const bytes = staged?.bytes;
    return [move.source, { existed: staged?.existed, size: bytes?.length,
      digest: bytes == null ? null : createHash('sha256').update(bytes).digest('hex') }];
  }));
  /** @param {string} source */
  const recoverable = (source) => {
    if (store.readEntry(store.idFor(source)) !== null) return true;
    const original = originals.get(source);
    if (original?.existed === false) return true;
    try {
      const stats = statSync(source);
      return stats.isFile() && stats.size === original?.size &&
        createHash('sha256').update(readFileSync(source)).digest('hex') === original.digest;
    } catch { return false; }
  };
  const changedPaths = new Set(changed.map((path) => resolve(call.cwd, path)));
  const files = call.files.filter((file) => changedPaths.has(file.path));
  const destinations = new Set(call.moves.filter((move) => move.source !== move.destination).map((move) => move.destination));
  await runForFiles('post', files.filter((file) => !destinations.has(file.path)).map((file) => payload(sessionId, call.root, file)), deadline);
  let pending = files.filter((file) => destinations.has(file.path));
  while (pending.length > 0 && Date.now() < deadline) {
    const deferred = [];
    for (const file of pending) {
      // A moved file must remain recoverable at its source before Discard may replace its destination.
      const safe = call.moves.filter((move) => move.destination === file.path).every((move) => recoverable(move.source));
      // Restoring a deleted path cannot erase surviving content and can seed a cycle's recovery.
      const deleted = store.readStaging(file.key)?.existed === true && !existsSync(file.path);
      if (safe || deleted) await runHook('post', payload(sessionId, call.root, file), deadline);
      else deferred.push(file);
    }
    if (deferred.length === pending.length) {
      logError('post', new Error('moved destinations skipped because their sources have no recoverable baselines'));
      return;
    }
    pending = deferred;
  }
}

/** @param {string} sessionId @param {string} root @param {{path: string, key: string}} file */
const payload = (sessionId, root, file) => ({ session_id: sessionId, cwd: root,
  tool_name: 'Edit', tool_input: { file_path: file.path }, tool_use_id: file.key });

/** @param {Store} store @param {string} prefix */
function clearStaging(store, prefix) {
  let names;
  try { names = readdirSync(join(store.root, 'staging')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) if (name.startsWith(prefix)) store.dropStaging(name);
}

/** @param {string} event @param {HookInput[]} files @param {number} deadline */
async function runForFiles(event, files, deadline) {
  for (let first = 0; first < files.length; first += PARALLEL_HOOKS) {
    if (Date.now() >= deadline) throw new Error('patch tracking exceeded 55 seconds');
    await Promise.all(files.slice(first, first + PARALLEL_HOOKS).map((file) => runHook(event, file, deadline)));
  }
}

/** @param {string} event @param {HookInput} input @param {number} [deadline] @returns {Promise<string>} */
function runHook(event, input, deadline = Date.now() + HOOK_TIMEOUT_MS) {
  if (Date.now() >= deadline) return Promise.resolve('');
  return new Promise((done) => {
    // Codex's cwd must not inherit the project root of a parent Claude session.
    const { CLAUDE_PROJECT_DIR: _parent, ...env } = process.env;
    const child = spawn(process.execPath, [SHARED_HOOK, event], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(HOOK_TIMEOUT_MS, deadline - Date.now()));
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { logError(event, error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) logError(event, new Error(`shared hook exited ${code}: ${stderr.trim()}`));
      done(code === 0 ? stdout : '');
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** @param {string} event @param {unknown} error */
function logError(event, error) {
  try { openStore().logError(`codex ${event}`, error); } catch {}
}

main().catch((error) => logError('hook', error));
