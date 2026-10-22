import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// All of these live on the project's disk rather than in /tmp: discarding a file
// Claude created moves it to the trash, which desktops refuse for the tmpfs that
// /tmp often is. They are recreated per run so one run never sees another's files.
// Tests must never touch the real ~/.claude/pending-edits.
// A directory is wiped the first time a name is asked for, and only then: two runs that
// share one (see `scratchKey` below) must not wipe what the first of them left behind.
const scratchDirectories = new Map();
const scratch = (name) => {
  let directory = scratchDirectories.get(name);
  if (directory === undefined) {
    directory = resolve('.vscode-test', name);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    scratchDirectories.set(name, directory);
  }
  return directory;
};
// A seeded entry looks to the extension like Claude editing the file after the window opened, and the
// extension would open every one of them in an editor. Only follow.test.ts wants that, and turns it on.
const userSettings = `${JSON.stringify({ 'clause.followEdits': false }, null, 2)}\n`;
const userData = (scratchKey) => {
  const directory = scratch(`user-data-${scratchKey}`);
  mkdirSync(join(directory, 'User'), { recursive: true });
  writeFileSync(join(directory, 'User', 'settings.json'), userSettings);
  return directory;
};

// Electron prefers Wayland when WAYLAND_DISPLAY is set, so under xvfb-run the test
// window would open on the real desktop instead of the virtual display.
const x11 = process.platform === 'linux' ? ['--ozone-platform=x11'] : [];

/**
 * One VS Code run, with a workspace, a store and user data of its own so that
 * runs cannot see each other's files or windows. Runs that give the same
 * `scratchKey` share all of them: the second finds what the first left behind.
 */
const run = (label, files, { extraArguments = [], scratchKey = label } = {}) => ({
  label,
  files,
  useInstallation: { fromPath: '/usr/share/code/code' },
  workspaceFolder: scratch(`workspace-${scratchKey}`),
  launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox', `--user-data-dir=${userData(scratchKey)}`, ...x11, ...extraArguments],
  // Files moved to the trash land in $XDG_DATA_HOME/Trash on Linux; without this the tests fill the user's real trash.
  // HOME is private too: the editor reads ~/.vscode/argv.json at start-up, and the `enable-proposed-api` entry the
  // README asks for would let the proposal through in the 'default' run, which exists to watch the editor refuse it.
  // It is on the project's disk, not in /tmp, like the rest: with a HOME in /tmp the trash refuses the workspace's files.
  env: { CLAUDE_PENDING_EDITS_DIR: scratch(`store-${scratchKey}`), XDG_DATA_HOME: scratch(`data-${scratchKey}`), HOME: scratch(`home-${scratchKey}`) },
  mocha: { ui: 'bdd', timeout: 20000 },
});

export default defineConfig([
  // The editor as most users have it: the extension has not been allowed to use the editorInsets proposal.
  run('default', 'out/test/integration/*.test.js'),
  // The editor as the README sets it up. Only the editor's own flag can allow a proposal; the manifest cannot.
  run('proposed', 'out/test/integration/proposed/*.test.js', { extraArguments: ['--enable-proposed-api', 'local.clause'] }),
  // The editor closed with changes still pending, then opened again. These two must run in this order and in
  // one `vscode-test` invocation: starting an invocation wipes the scratch directories.
  run('restart-seed', 'out/test/integration/restart/seed.test.js', { scratchKey: 'restart' }),
  run('restart-reopen', 'out/test/integration/restart/reopen.test.js', { scratchKey: 'restart' }),
]);
