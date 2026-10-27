// @ts-check
//
// Clause for OpenCode. What an OpenCode agent edits shows up in the same Keep/Discard review in
// VS Code and Cursor as what Claude Code edits, because it goes into the same pending-edits store.
// This is a plugin for OpenCode 2.x (listed under `plugins` in its config); it does not load in 1.x.
//
// The store is not reimplemented here. claude-plugin/hook.mjs already decides what a file's baseline
// is, when an edit changed nothing, and what the agent is told about discards. This plugin only turns
// OpenCode's events into the payloads that hook reads, and runs it:
//
//   plugin loads                       `session-start`  sweeps what interrupted edits left behind
//   before an edit, write or patch     `pre`            once per file the call may change
//   after that call, whatever it says  `post`           the same files
//   before a prompt                    `prompt`         the hook's note about discards is added to the session
//
// A rule that changes in the hook (a smarter no-op check, a new size limit) therefore applies to both
// agents. The price is one short-lived Node process per file per event, and `node` on the PATH that
// OpenCode runs with.
//
// Like the hook, nothing here may get in the agent's way: failures are logged to the store's
// errors.log and swallowed. The exception is loading, which fails when Node cannot be started: the
// plugin would otherwise look active and record nothing.
//
// Not covered: files changed through the `shell` tool, which gives no state from before the command.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  } catch {}
  return candidate;
}

const HOOK = findHook();

/**
 * OpenCode's file-changing tools, with the Claude tool name the hook tracks them as. The hook only
 * checks that a name is one of its own and cannot tell a patch from an edit, so `patch` is an Edit.
 */
const TRACKED_TOOLS = new Map([
  ['edit', 'Edit'],
  ['write', 'Write'],
  ['patch', 'Edit'],
]);

/**
 * Bounds a stuck hook (a hung disk) so it holds the agent up for no longer than this. Generous
 * because the hook may copy a file of up to 64 MiB.
 */
const HOOK_TIMEOUT_MS = 10_000;

/** How many hook processes run at once for one call. */
const PARALLEL_HOOKS = 4;

/** The lines of an OpenCode patch that name a file. */
const PATCH_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: '];

/**
 * @typedef {object} ToolEvent what `execute.before` and `execute.after` pass, reduced to what is used
 * @property {string} tool
 * @property {string} sessionID
 * @property {string} messageID
 * @property {string} id
 * @property {unknown} input what the model passed to the tool
 */

/**
 * @typedef {object} Context the part of OpenCode's plugin context that is used
 * @property {{ directory: string }} location
 * @property {{ hook: (name: 'execute.before' | 'execute.after', callback: (event: ToolEvent) => Promise<void>) => Promise<unknown> }} tool
 * @property {{
 *   get: (input: { sessionID: string }) => Promise<{ location?: { directory?: string } }>,
 *   hook: (name: 'prompt', callback: (event: { sessionID: string }) => Promise<void>) => Promise<unknown>,
 *   synthetic: (message: { sessionID: string, text: string, description: string, resume: boolean }) => Promise<unknown>,
 * }} session
 */

/**
 * @typedef {object} Call a file-changing tool call, from its `execute.before` to its `execute.after`
 * @property {string} tool the Claude tool name the hook is told
 * @property {string} sessionID
 * @property {string} directory the folder the session was started in
 * @property {{ path: string, key: string }[]} files `key` is what the hook saves the file's bytes under in between
 * @property {unknown} [input] what the model passed to the tool
 */

export default {
  id: 'clause',

  /** @param {Context} ctx */
  async setup(ctx) {
    const started = await runHook('session-start', {});
    if (!started.started || started.code !== 0) {
      throw new Error(
        'Clause could not start Node.js to record edits. Put `node` on the PATH that OpenCode runs with, or set CLAUSE_NODE to the full path of the node binary.',
      );
    }

    /** @type {Map<string, Call[]>} */
    const calls = new Map();
    const keyOf = (/** @type {ToolEvent} */ event) => [event.sessionID, event.messageID, event.id, event.tool].join('\0');

    await ctx.tool.hook('execute.before', async (event) => {
      try {
        const tool = TRACKED_TOOLS.get(event.tool);
        if (tool === undefined) return;
        const directory = await sessionDirectory(ctx, event.sessionID);
        // A fresh key per file, not the call's id: a model can reuse ids, and the store reads a new key as a new edit.
        const batch = randomUUID();
        const files = editedPaths(event.tool, event.input, directory).map((path, index) => ({ path, key: `${batch}-${index}` }));
        if (files.length === 0) return;
        const call = { tool, sessionID: event.sessionID, directory, files, input: event.input };
        const key = keyOf(event);
        const existing = calls.get(key) ?? [];
        existing.push(call);
        calls.set(key, existing);
        await runForFiles('pre', call);
      } catch (error) {
        logError('execute.before', error);
      }
    });

    await ctx.tool.hook('execute.after', async (event) => {
      try {
        const key = keyOf(event);
        const list = calls.get(key);
        if (list === undefined || list.length === 0) return;
        let index = list.findIndex((c) => c.input === event.input);
        if (index === -1) {
          const files = editedPaths(event.tool, event.input, list[0].directory);
          index = list.findIndex((c) => c.files.length === files.length && c.files.every((f, i) => f.path === files[i]));
        }
        if (index === -1) index = 0;
        const [call] = list.splice(index, 1);
        if (list.length === 0) calls.delete(key);
        // `post` also for a call that reports an error: a patch can fail after it changed some files.
        // The hook compares each file with its saved bytes and records only a real difference, so a
        // call that changed nothing leaves nothing behind either way.
        await runForFiles('post', call);
      } catch (error) {
        logError('execute.after', error);
      }
    });

    await ctx.session.hook('prompt', async (event) => {
      try {
        const directory = await sessionDirectory(ctx, event.sessionID);
        const note = noteFrom((await runHook('prompt', { session_id: event.sessionID, cwd: directory })).stdout);
        if (note === null) return;
        await ctx.session.synthetic({
          sessionID: event.sessionID,
          text: note,
          description: 'Clause: changes were discarded in the editor',
          resume: false,
        });
      } catch (error) {
        logError('prompt', error);
      }
    });
  },
};

/**
 * @param {string} event the hook.mjs event name
 * @param {Record<string, unknown>} payload as Claude Code would send it
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ started: boolean, stdout: string, stderr?: string, code?: number | null }>} `started` is false only when Node could not be run
 */
export function runHook(event, payload, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    // A Claude Code session that happens to be OpenCode's parent must not decide where this session
    // "started": the payload's cwd, the session's own folder, does.
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
    child.stdin.on('error', () => {}); // the hook exiting before it read its input is its business, not an error here
    child.on('error', () => finish(false, null));
    child.on('close', (code) => finish(true, code));
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * @param {unknown} patchText the `patch` tool's input
 * @returns {string[]} every path the patch names, as written
 *
 * Scans for header lines instead of parsing the patch: every file the tool may change must be found,
 * and finding one it does not change is harmless because the hook then sees no difference. It reads a
 * patch in a heredoc or with CRLF line ends, which OpenCode accepts, the same way as any other.
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
 * Resolves a tool's path argument the way OpenCode's own file tools do: against the folder the
 * session was started in, a leading `~` meaning the home folder.
 * @param {string} directory
 * @param {string} path
 * @param {string} [home]
 */
export function resolveTarget(directory, path, home = homedir()) {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return resolve(directory, expanded);
}

/**
 * @param {string} tool OpenCode's name for the tool
 * @param {unknown} input what the model passed to it
 * @param {string} directory
 * @returns {string[]} absolute paths the call may change
 */
function editedPaths(tool, input, directory) {
  const fields = /** @type {Record<string, unknown>} */ (input !== null && typeof input === 'object' ? input : {});
  const rawPath = fields.path ?? fields.filePath ?? fields.file_path ?? fields.target ?? fields.file;
  const rawPatch = fields.patchText ?? fields.patch ?? fields.patch_text;
  /** @type {string[]} */
  const named = tool === 'patch' ? patchPaths(rawPatch) : typeof rawPath === 'string' ? [rawPath] : [];
  return Array.from(new Set(named.filter((path) => path !== '').map((path) => resolveTarget(directory, path))));
}

/**
 * Runs the hook for each file of a call, a few processes at a time: a patch can name dozens of files,
 * and a Node process per file all at once would be a memory spike on a small machine.
 * @param {'pre' | 'post'} event
 * @param {Call} call
 */
async function runForFiles(event, call) {
  for (let first = 0; first < call.files.length; first += PARALLEL_HOOKS) {
    await Promise.all(call.files.slice(first, first + PARALLEL_HOOKS).map((file) => runHook(event, editPayload(call, file))));
  }
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
 * @param {Context} ctx
 * @param {string} sessionID
 * @returns {Promise<string>} the folder the session was started in: what OpenCode resolves its tools' relative paths against
 */
async function sessionDirectory(ctx, sessionID) {
  try {
    const directory = (await ctx.session.get({ sessionID })).location?.directory;
    if (typeof directory === 'string' && isAbsolute(directory)) return canonical(directory);
  } catch {
    // A session OpenCode cannot describe: the folder this plugin was loaded for is the best guess left.
  }
  return canonical(ctx.location.directory);
}

/**
 * What the hook reads from Claude Code's PreToolUse and PostToolUse payloads, for one file of a call.
 * @param {Call} call
 * @param {{ path: string, key: string }} file
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
 * @param {string} stdout what `hook.mjs prompt` printed: nothing, or Claude Code's JSON for extra context
 * @returns {string | null} the note for the agent, if there is one
 */
function noteFrom(stdout) {
  if (stdout === '') return null;
  const note = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
  return typeof note === 'string' && note !== '' ? note : null;
}

/**
 * @param {string} context
 * @param {unknown} error
 */
function logError(context, error) {
  try {
    openStore().logError(`opencode ${context}`, error);
  } catch {
    // No usable store location, so there is nowhere to record it (as in the hook).
  }
}
