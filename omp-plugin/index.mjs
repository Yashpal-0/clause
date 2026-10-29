// @ts-check
//
// Clause for OMP. An edit or write from OMP shows up in the same Keep/Discard review in VS Code
// and Cursor as one from Claude Code, because it goes into the same pending-edits store. That
// includes a write OMP hands to the VS Code editor over ACP: the tool does not return until the
// editor has saved, so the bytes compared afterwards are the bytes in the editor.
//
// The store is not reimplemented here. claude-plugin/hook.mjs already decides the baseline, a
// no-op, and what the agent is told about discards. This module only turns OMP's events into the
// payloads that hook reads:
//
//   session_start         `session-start`  sweeps staging an interrupted edit left behind
//   tool_call             `pre`            once per file the call may change, before the tool runs
//   tool_result           `post`           the same files, including a call that reports an error
//   before_agent_start    `prompt`         the hook's note about discards is added to the turn
//
// A rule that changes in the hook therefore applies here too. The price is one short-lived Node
// process per file per event, and `node` on the PATH that OMP runs with (`CLAUSE_NODE` overrides it).
//
// tool_call is fail-closed in OMP: a handler that throws, or that runs past the tool-call budget,
// blocks the edit. Nothing here may throw. A file changed through bash or ast_edit is not tracked:
// those calls name a command or a glob, not the files they will change, so there are no bytes to save first.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../claude-plugin/store.mjs';

function findHook() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(dir, '..', 'claude-plugin', 'hook.mjs');
  if (existsSync(candidate)) return candidate;
  try {
    const realDir = dirname(realpathSync.native(fileURLToPath(import.meta.url)));
    const candidate2 = join(realDir, '..', 'claude-plugin', 'hook.mjs');
    if (existsSync(candidate2)) return candidate2;
  } catch {
    // The path is already the best one we have.
  }
  return candidate;
}

const HOOK = findHook();

/** OMP's file tools, with the Claude tool name the hook tracks them as. */
const HOOK_TOOL = new Map([
  ['edit', 'Edit'],
  ['write', 'Write'],
]);

/**
 * Bounds a stuck hook (a hung disk) so one file cannot hold the edit until OMP's tool-call budget
 * blocks it. Generous because the hook may copy a file of up to 64 MiB.
 */
const HOOK_TIMEOUT_MS = 10_000;

/** How many hook processes run at once for one call. */
const PARALLEL_HOOKS = 4;

/** The lines of an apply-patch body that name a file. */
const PATCH_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: '];

/**
 * apply-patch framing that a model put in brackets in front of a hashline header
 * (`[*** Begin Patch] [a.ts#1A2B]`). OMP drops it, as `unbracket_envelope_markers` does.
 */
const HASHLINE_ENVELOPE = /^(?:\[\s*\*\*\* (?:Begin Patch|End Patch|Abort)\s*\]?\s*)+/;

/** An apply-patch label in front of a hashline path (`*** Update File: a.ts`). OMP's APPLY_PATCH_PATH_NOISE_RE. */
const HASHLINE_PATH_LABEL = /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;

/** `text` without one pair of matching quotes around it, as OMP's hashline parser takes them off. */
const unquote = (/** @type {string} */ text) => (/^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text);

/**
 * @typedef {object} OmpContext the part of OMP's handler context that is used
 * @property {string} cwd
 * @property {{ notify?: (message: string, type?: 'info' | 'warning' | 'error') => void }} [ui]
 * @property {{ getSessionId?: () => string }} [sessionManager]
 */

/**
 * @typedef {object} TrackedFile
 * @property {string} path
 * @property {string} key what the hook saves the file's bytes under between pre and post
 */

/**
 * @typedef {object} Call
 * @property {string} tool the Claude tool name the hook is told
 * @property {string} sessionID
 * @property {string} directory the folder the session was started in
 * @property {TrackedFile[]} files
 */

/**
 * @typedef {object} ToolEvent
 * @property {string} toolName
 * @property {string} toolCallId
 * @property {unknown} input
 * @property {'prompt' | 'revive'} [reason]
 */

/**
 * @param {{ on: (name: string, handler: (event: ToolEvent, ctx: OmpContext) => Promise<unknown>) => void }} pi
 */
export default function clause(pi) {
  /** @type {Map<string, Call[]>} */
  const calls = new Map();

  pi.on('session_start', async (_event, ctx) => {
    try {
      const started = await runHook('session-start', { session_id: sessionId(ctx), cwd: sessionDirectory(ctx) });
      if (!started.started || started.code !== 0) {
        ctx.ui?.notify?.(
          'Clause could not start Node.js to record edits. Put `node` on the PATH that OMP runs with, or set CLAUSE_NODE to the full path of the node binary.',
          'error',
        );
      }
    } catch (error) {
      logError('session_start', error);
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    try {
      await stageCall(calls, event, ctx);
    } catch (error) {
      logError('tool_call', error);
    }
  });

  pi.on('tool_result', async (event, ctx) => {
    try {
      const id = event.toolCallId;
      const list = calls.get(id);
      if (list === undefined || list.length === 0) return;
      const paths = editedPaths(event.toolName, event.input, list[0].directory);
      let index = list.findIndex((call) => samePaths(call, paths));
      if (index === -1) index = 0;
      const [call] = list.splice(index, 1);
      if (list.length === 0) calls.delete(id);
      // Also for a call that reports an error: it may have written some of its files. The hook
      // records only a real difference, so a call that changed nothing leaves nothing either.
      await runForFiles('post', call);
    } catch (error) {
      logError('tool_result', error);
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      // A revived subagent fires this with the result discarded. Reading the discard log here
      // would consume the note before the prompt that can still act on it.
      if (event.reason !== 'prompt') return;
      const note = noteFrom((await runHook('prompt', { session_id: sessionId(ctx), cwd: sessionDirectory(ctx) })).stdout);
      if (note === null) return;
      return {
        message: {
          customType: 'clause-discard',
          content: note,
          display: false,
          attribution: 'agent',
        },
      };
    } catch (error) {
      logError('before_agent_start', error);
    }
  });
}

/**
 * @param {Map<string, Call[]>} calls
 * @param {{ toolName: string, toolCallId: string, input: unknown }} event
 * @param {OmpContext} ctx
 */
async function stageCall(calls, event, ctx) {
  const tool = HOOK_TOOL.get(event.toolName);
  if (tool === undefined) return;
  const id = event.toolCallId;
  if (typeof id !== 'string' || id === '') return;
  const directory = sessionDirectory(ctx);
  const paths = editedPaths(event.toolName, event.input, directory);
  if (paths.length === 0) return;
  const call = {
    tool,
    sessionID: sessionId(ctx),
    directory,
    files: paths.map((path, index) => ({ path, key: `${id}:${index}` })),
  };
  const list = calls.get(id) ?? [];
  const same = list.findIndex((existing) => samePaths(existing, paths));
  if (same === -1) {
    // A second tool_call for this id with different paths is a revised input. Drop the bytes
    // staged for the paths that will not be written, or the next post could pair them wrong.
    for (const previous of list) await runForFiles('failure', previous);
    list.length = 0;
    list.push(call);
    calls.set(id, list);
    await runForFiles('pre', call);
    return;
  }
  // OMP can emit tool_call twice for one dispatch. Stage again: the file may have changed since
  // the first snapshot, and stage() replaces the previous bytes.
  await runForFiles('pre', list[same]);
}

/**
 * @param {string} event the hook.mjs event name
 * @param {Record<string, unknown>} payload as Claude Code would send it
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ started: boolean, stdout: string, stderr?: string, code?: number | null }>} `started` is false only when Node could not be run
 */
export function runHook(event, payload, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    // A Claude Code session that happens to be OMP's parent must not decide where this session
    // started: the payload's cwd, the session's own folder, does.
    const { CLAUDE_PROJECT_DIR: _inherited, ...env } = process.env;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.env.CLAUSE_NODE || 'node', [HOOK, event], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch {
      return done({ started: false, stdout, stderr, code: null });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (/** @type {boolean} */ started, /** @type {number | null} */ code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null && stderr.trim() !== '') {
        logError(`hook ${event} (exit ${code})`, new Error(stderr.trim()));
      }
      done({ started, stdout, stderr, code });
    };
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => finish(false, null));
    child.on('close', (code) => finish(true, code));
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * @param {unknown} patchText
 * @returns {string[]} every path an apply-patch body names, as written
 *
 * Scans for header lines instead of parsing the patch: every file the tool may change must be found,
 * and finding one it does not change is harmless because the hook then sees no difference.
 */
export function patchPaths(patchText) {
  if (typeof patchText !== 'string') return [];
  return patchText.split('\n').flatMap((line) => {
    const header = line.trim();
    const prefix = PATCH_HEADERS.find((candidate) => header.startsWith(candidate));
    if (prefix === undefined) return [];
    let path = header.slice(prefix.length).trim();
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
      path = path.slice(1, -1).trim();
    }
    return path === '' ? [] : [path];
  });
}

/**
 * Paths a hashline body names, cleaned the way OMP's parser cleans them before it edits the file. A
 * file header is a line `[path]` or `[path#HASH]` (the hash is four hex characters); the path runs
 * to the line's last `]`, so it may contain brackets (`app/[slug]/page.tsx`). `MV dest` names the
 * file a move writes. Either path may be in quotes. Payload lines are prefixed, so a line of the
 * file's own text does not match. Lines OMP would reject still count: naming a file the edit
 * leaves alone records nothing, and missing one loses its review.
 * @param {unknown} text
 * @returns {string[]}
 */
export function hashlinePaths(text) {
  if (typeof text !== 'string') return [];
  return text.split('\n').flatMap((rawLine) => {
    const line = rawLine.trim().replace(HASHLINE_ENVELOPE, '');
    let named;
    if (line.startsWith('[') && line.endsWith(']')) named = line.slice(1, -1).replace(/#[0-9a-fA-F]{4}\s*$/, '');
    // OMP reads `MV` followed by the end of the line, `:` or a space, and unquotes the rest once more.
    else if (/^MV(?![^:\s])/.test(line)) named = unquote(line.slice(2).trim());
    else return [];
    const path = unquote(named.trim()).replace(HASHLINE_PATH_LABEL, '');
    return path === '' ? [] : [path];
  });
}

/**
 * Paths a sloppy body names, read as OMP's parser reads a header: `*** Edit File: path` in any case,
 * with an optional trailing ` all`, and a path that would be ambiguous written in JSON quotes. A
 * header without a path continues the file before it. Lines between headers are unprefixed file text.
 * @param {unknown} text
 * @returns {string[]}
 */
export function sloppyPaths(text) {
  if (typeof text !== 'string') return [];
  return text.split('\n').flatMap((line) => {
    const header = /^\*{3}[ \t]+Edit[ \t]+File(?::|[ \t]|$)[ \t]*(.*)$/i.exec(line.trim());
    if (header === null) return [];
    const rest = header[1].trim();
    const flagged = /^([\s\S]*)\s(\S*)$/.exec(rest);
    let path = /^all$/i.test(rest) ? '' : flagged !== null && /^all$/i.test(flagged[2]) ? flagged[1].trimEnd() : rest;
    if (path.startsWith('"')) {
      try {
        path = JSON.parse(path);
      } catch {
        return [];
      }
    }
    return path === '' ? [] : [path];
  });
}

/**
 * Resolves a tool's path the way OMP's file tools do: against the folder the session was started
 * in, a leading `~` meaning the home folder.
 * @param {string} directory
 * @param {string} path
 * @param {string} [home]
 */
export function resolveTarget(directory, path, home = homedir()) {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return resolve(directory, expanded);
}

/**
 * @param {string} tool OMP's name for the tool
 * @param {unknown} input what the model passed to it
 * @param {string} directory
 * @param {string} [home]
 * @returns {string[]} absolute paths the call may change
 */
export function editedPaths(tool, input, directory, home = homedir()) {
  if (!HOOK_TOOL.has(tool)) return [];
  const fields = /** @type {Record<string, unknown>} */ (input !== null && typeof input === 'object' ? input : {});
  /** @type {string[]} */
  const named = [];
  if (typeof fields.input === 'string') {
    // A mode that takes a body takes nothing else, so the body names every file. OMP adds a `path`
    // from its scan for hashline headers, which a sloppy body's text such as `[section]` also
    // matches. A hunk's context line can look like a hashline header as well.
    const headed = [...patchPaths(fields.input), ...sloppyPaths(fields.input)];
    named.push(...(headed.length > 0 ? headed : hashlinePaths(fields.input)));
  } else {
    if (typeof fields.path === 'string') named.push(fields.path);
    if (Array.isArray(fields.edits)) {
      for (const edit of fields.edits) {
        if (edit !== null && typeof edit === 'object' && typeof /** @type {{ rename?: unknown }} */ (edit).rename === 'string') {
          named.push(/** @type {{ rename: string }} */ (edit).rename);
        }
      }
    }
  }
  // local:// and conflict:// are OMP's own scratch, not files the editor is reviewing.
  const resolved = named.filter((path) => path !== '' && !path.includes('://')).map((path) => resolveTarget(directory, path, home));
  return Array.from(new Set(resolved));
}

/**
 * @param {'pre' | 'post' | 'failure'} event
 * @param {Call} call
 */
async function runForFiles(event, call) {
  for (let first = 0; first < call.files.length; first += PARALLEL_HOOKS) {
    await Promise.all(call.files.slice(first, first + PARALLEL_HOOKS).map((file) => runHook(event, editPayload(call, file))));
  }
}

/**
 * @param {Call} call
 * @param {TrackedFile} file
 */
function editPayload(call, file) {
  return {
    session_id: call.sessionID,
    cwd: call.directory,
    tool_name: call.tool,
    tool_input: { file_path: file.path },
    tool_use_id: file.key,
  };
}

/**
 * @param {Call} call
 * @param {string[]} paths
 */
function samePaths(call, paths) {
  return call.files.length === paths.length && call.files.every((file, index) => file.path === paths[index]);
}

/** @param {string} dir */
function canonical(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * @param {OmpContext} ctx
 * @returns {string} the folder OMP resolves relative paths against
 */
function sessionDirectory(ctx) {
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
  return canonical(isAbsolute(cwd) ? cwd : resolve(cwd));
}

/** @param {OmpContext} ctx */
function sessionId(ctx) {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} stdout what `hook.mjs prompt` printed
 * @returns {string | null} the note for the agent, if there is one
 */
function noteFrom(stdout) {
  if (stdout === '') return null;
  try {
    const note = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
    return typeof note === 'string' && note !== '' ? note : null;
  } catch (error) {
    logError('prompt', error);
    return null;
  }
}

/**
 * @param {string} context
 * @param {unknown} error
 */
function logError(context, error) {
  try {
    openStore().logError(`omp ${context}`, error);
  } catch {
    // No usable store location, so there is nowhere to record it (as in the hook).
  }
}
