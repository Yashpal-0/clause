#!/usr/bin/env node
// @ts-check
//
// Clause for AGY (Antigravity CLI). Edits that an AGY agent makes via write_file
// or edit_file go through the same Keep/Discard review in VS Code and Cursor,
// because they are recorded into the same pending-edits store.
//
// The store and diff logic are not reimplemented here. claude-plugin/hook.mjs
// manages staging, baselines, and discard notices. This adapter translates
// AGY lifecycle hook events into the payloads that the shared hook expects:
//
//   SessionStart   -> sweeps stale staging and initializes discard cursor
//   PreToolUse     -> stages snapshot before write_file or edit_file executes
//   PostToolUse    -> promotes staged baseline (or drops staging on failure)
//   PreInvocation  -> informs AGY about discarded changes on the next prompt

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../claude-plugin/store.mjs';

const SHARED_HOOK = fileURLToPath(new URL('../claude-plugin/hook.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 10_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const TRACKED_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * @typedef {object} TargetInfo
 * @property {string} path canonical or absolute file path
 * @property {string} key staging key
 */

/**
 * Strips matching surrounding quotes, trims whitespace, and converts file:// URIs.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanPath(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (text === '') return null;
  if (text.startsWith('file://')) {
    try {
      text = fileURLToPath(text);
    } catch {
      return null;
    }
  }
  return text === '' ? null : text;
}

/**
 * Determines whether a tool call reported an error or failure in AGY.
 * @param {Record<string, any>} input
 * @returns {boolean}
 */
export function isFailedToolCall(input) {
  if (!input || typeof input !== 'object') return false;
  if (typeof input.status === 'string' && /^(ERROR|FAILED)$/i.test(input.status)) return true;
  if (input.error != null && input.error !== false) {
    if (typeof input.error === 'string') return input.error.trim() !== '';
    return true;
  }
  const responseError = input.toolResponse?.error;
  if (responseError != null && responseError !== false) {
    if (typeof responseError === 'string') return responseError.trim() !== '';
    return true;
  }
  return false;
}

/**
 * @param {Record<string, any>} input
 * @returns {string}
 */
export function getSessionId(input) {
  const convId = input?.conversationId;
  return typeof convId === 'string' && convId.trim() !== '' ? `agy-${convId.trim()}` : 'agy-default';
}

/**
 * @param {Record<string, any>} input
 * @returns {string}
 */
export function getWorkspaceDir(input) {
  const wsPaths = input?.workspacePaths;
  if (Array.isArray(wsPaths) && wsPaths.length > 0 && typeof wsPaths[0] === 'string' && isAbsolute(wsPaths[0])) {
    return wsPaths[0];
  }
  const cwd = input?.cwd;
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
  return process.cwd();
}

/**
 * Extracts target file path and generates a unique staging key for tracked AGY tools.
 * @param {Record<string, any>} input
 * @param {string} workspaceDir
 * @returns {TargetInfo | null}
 */
export function extractTarget(input, workspaceDir) {
  const toolCall = input?.toolCall;
  if (!toolCall || typeof toolCall !== 'object') return null;

  const rawName = String(toolCall.name || '');
  const toolName = rawName.includes(':') ? rawName.split(':').pop() : rawName;
  const normalizedName = toolName ? toolName.toLowerCase() : '';
  if (!normalizedName || !TRACKED_TOOLS.has(normalizedName)) return null;

  const args = toolCall.args;
  if (!args || typeof args !== 'object') return null;

  const rawPath = cleanPath(args.Path ?? args.path ?? args.file_path ?? args.filePath ?? args.target_file ?? args.targetFile ?? args.file);
  if (!rawPath) return null;

  const resolved = isAbsolute(rawPath) ? rawPath : resolve(workspaceDir, rawPath);
  const sessionId = getSessionId(input);
  const stepIdx = input.stepIdx ?? 0;
  const toolId = String(toolCall.id ?? toolCall.toolCallId ?? '');
  const key = 'agy-' + createHash('sha256').update(JSON.stringify([sessionId, stepIdx, toolId, resolved])).digest('hex').slice(0, 32);

  return { path: resolved, key };
}

/**
 * @param {string} context
 * @param {unknown} error
 */
function logError(context, error) {
  try {
    openStore().logError(`agy ${context}`, error);
  } catch {}
}

/**
 * @param {string} event
 * @param {Record<string, any>} payload
 * @param {number} [timeoutMs]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
export function runHook(event, payload, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((done) => {
    const { CLAUDE_PROJECT_DIR: _inherited, ...env } = process.env;
    const nodeBin = process.env.CLAUSE_NODE || process.execPath;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(nodeBin, [SHARED_HOOK, event], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      logError(`spawn ${event}`, error);
      return done({ stdout: '', stderr: String(error), code: null });
    }

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      logError(event, error);
      done({ stdout: '', stderr: String(error), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr.trim() !== '') {
        logError(`${event} exit ${code}`, new Error(stderr.trim()));
      }
      done({ stdout, stderr, code });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Main entry point for the AGY hook adapter.
 */
async function main() {
  const event = process.argv[2] ?? '';
  /** @type {Record<string, any>} */
  let input = {};
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) throw new Error('hook input exceeds limit');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text !== '') input = JSON.parse(text);
  } catch (error) {
    logError(`${event}: unreadable input`, error);
    if (event === 'pre') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
    } else {
      process.stdout.write('{}');
    }
    return;
  }

  const workspaceDir = getWorkspaceDir(input);
  const sessionId = getSessionId(input);

  try {
    switch (event) {
      case 'session-start': {
        await runHook('session-start', { session_id: sessionId, cwd: workspaceDir });
        process.stdout.write('{}');
        break;
      }
      case 'pre': {
        const target = extractTarget(input, workspaceDir);
        if (target) {
          await runHook('pre', {
            session_id: sessionId,
            cwd: workspaceDir,
            tool_name: 'Edit',
            tool_input: { file_path: target.path },
            tool_use_id: target.key,
          });
        }
        process.stdout.write(JSON.stringify({ decision: 'allow' }));
        break;
      }
      case 'post': {
        const target = extractTarget(input, workspaceDir);
        if (target) {
          const hasError = isFailedToolCall(input);
          const subEvent = hasError ? 'failure' : 'post';
          await runHook(subEvent, {
            session_id: sessionId,
            cwd: workspaceDir,
            tool_name: 'Edit',
            tool_input: { file_path: target.path },
            tool_use_id: target.key,
          });
        }
        process.stdout.write('{}');
        break;
      }
      case 'prompt': {
        const { stdout } = await runHook('prompt', { session_id: sessionId, cwd: workspaceDir });
        let note = null;
        if (stdout && stdout.trim() !== '') {
          try {
            const parsed = JSON.parse(stdout);
            const text = parsed?.hookSpecificOutput?.additionalContext;
            if (typeof text === 'string' && text.trim() !== '') note = text.trim();
          } catch (error) {
            logError('prompt parse', error);
          }
        }
        if (note) {
          process.stdout.write(JSON.stringify({
            injectSteps: [
              { ephemeralMessage: note }
            ]
          }));
        } else {
          process.stdout.write('{}');
        }
        break;
      }
      default: {
        logError('unknown event', new Error(`Unknown hook event: ${event}`));
        if (event === 'pre') {
          process.stdout.write(JSON.stringify({ decision: 'allow' }));
        } else {
          process.stdout.write('{}');
        }
      }
    }
  } catch (error) {
    logError(event, error);
    if (event === 'pre') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
    } else {
      process.stdout.write('{}');
    }
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    logError('main', error);
  });
}
