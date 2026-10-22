import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const HOOK = join(PLUGIN_DIR, 'hook.mjs');
export const STORE_URL = new URL('../store.mjs', import.meta.url).href;

/**
 * Fresh directory removed when the test ends. Resolved through realpath so a
 * symlinked $TMPDIR cannot make expected and stored paths differ.
 * @param {import('node:test').TestContext} t
 */
export function tempDir(t, prefix = 'pe-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs the real hook executable the way Claude Code does: JSON on stdin, one
 * event name argument.
 * @param {string} event
 * @param {unknown} input object (JSON-encoded) or a raw string to send as-is
 * @param {{ root: string, env?: Record<string, string> }} options
 */
export function runHook(event, input, { root, env = {} }) {
  // Not inherited: a developer running these tests inside Claude Code would otherwise decide where
  // "the session was started" for every test. A test that cares passes it in `env`.
  const { CLAUDE_PROJECT_DIR: _ambient, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...inherited, CLAUDE_PENDING_EDITS_DIR: root, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs an ES module snippet in a separate process (for cross-process race
 * tests). Arguments arrive as process.argv.slice(1).
 * @param {string} code
 * @param {string[]} args
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function runModule(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
