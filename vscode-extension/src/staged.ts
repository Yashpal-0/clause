import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** File names given to one git command stay under this many characters: Windows refuses a command line over 32,767. */
const MAX_NAME_CHARS = 16_000;

type Event<T> = (listener: (value: T) => unknown) => { dispose(): unknown };

/** The part of the git extension's repository that is used here. */
export interface GitRepository {
  readonly rootUri: { readonly fsPath: string };
  readonly state: {
    /** Undefined until the extension's first status of the repository has run; `commit` is undefined before the first commit. */
    readonly HEAD?: { readonly commit?: string };
    readonly onDidChange: Event<void>;
  };
}

/** The part of the git extension's API that is used here. */
export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

/** The commits made after `from`, up to HEAD. `from` is undefined when the repository had no commit before them. */
export interface CommitsSince {
  readonly from: string | undefined;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    // File names are matched as they are, and looking must never hold the index lock against the user's own commands.
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

/** Whether HEAD names a commit: it does not in a repository that has none yet. */
async function hasCommit(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch (error) {
    // Exit status 1 is the answer "no"; anything else (git missing, not a repository) is a failure.
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

/**
 * Which of `files` (real paths) the user has handed to git, and so are decided: staged with nothing left unstaged,
 * or, when `commits` is given, part of a commit made since then and unchanged after it. A file that merely
 * matches what git holds, without the user staging or committing it, is not in the answer. Neither is a file
 * staged in part, or edited after it was staged or committed. Git does the comparing, because what counts as
 * equal depends on settings it owns (line endings, filters).
 *
 * Files outside `root` are not in the answer either.
 *
 * @throws when git cannot be run in `root`.
 */
export async function stagedOrCommitted(root: string, files: readonly string[], commits?: CommitsSince): Promise<Set<string>> {
  const repository = realpathSync.native(root);
  const byName = new Map<string, string>();
  for (const file of files) {
    const name = relative(repository, file);
    if (name === '' || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) continue;
    byName.set(name.split(sep).join('/'), file);
  }

  const taken = new Set<string>();
  for (const names of inBatches([...byName.keys()])) {
    const listed = async (...args: string[]) => new Set(zeroSeparated(await git(repository, [...args, '--', ...names])));
    const [staged, unstaged] = await Promise.all([
      listed('diff', '--cached', '--name-only', '--no-renames', '-z'),
      listed('diff', '--name-only', '--no-renames', '-z'),
    ]);
    const [committed, dirty] =
      commits === undefined
        ? [new Set<string>(), new Set<string>()]
        : await Promise.all([
            listed(
              ...(commits.from === undefined
                ? ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '--no-renames', '-z', 'HEAD']
                : ['diff-tree', '-r', '--name-only', '--no-renames', '-z', commits.from, 'HEAD']),
            ),
            listed('diff', '--name-only', '--no-renames', '-z', 'HEAD'),
          ]);
    for (const name of names) {
      if ((staged.has(name) && !unstaged.has(name)) || (committed.has(name) && !dirty.has(name))) taken.add(byName.get(name)!);
    }
  }
  return taken;
}

/** Splits `names` in order into batches of at most `maxChars` characters, a name that is longer alone in its own. */
export function* inBatches(names: readonly string[], maxChars = MAX_NAME_CHARS): Generator<string[]> {
  let batch: string[] = [];
  let size = 0;
  for (const name of names) {
    if (batch.length > 0 && size + name.length + 1 > maxChars) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(name);
    size += name.length + 1;
  }
  if (batch.length > 0) yield batch;
}

const zeroSeparated = (output: string) => output.split('\0').filter((name) => name !== '');

/**
 * Whether the reflog says the newest move of HEAD was a commit ("commit: …", "commit (amend): …"), as opposed to
 * a checkout, a pull, a reset or a rebase. False when the repository has no commit.
 */
export async function lastMoveWasCommit(root: string): Promise<boolean> {
  if (!(await hasCommit(root))) return false;
  return (await git(root, ['reflog', 'show', '--format=%gs', '-n', '1', 'HEAD'])).startsWith('commit');
}

/**
 * Calls `onChanged(root)` for each repository the git extension has open, when it opens or is first seen, and
 * every time the extension refreshes its status, which is when a stage shows. When the refresh shows that a
 * commit moved HEAD, `commits` says which commit HEAD was at before.
 *
 * A terminal's stage or commit is noticed only once the window has focus again: the extension does not look at a
 * repository while it is in the background.
 */
export function watchRepositories(
  api: GitApi,
  onChanged: (root: string, commits?: CommitsSince) => unknown,
  log: (message: string) => void,
  movedByCommit: (root: string) => Promise<boolean> = lastMoveWasCommit,
): { dispose(): void } {
  const watching = new Map<GitRepository, { dispose(): unknown }>();

  const notify = (root: string, commits?: CommitsSince) =>
    void Promise.resolve()
      .then(() => onChanged(root, commits))
      .catch((error: unknown) => log(`could not keep what was staged or committed in ${root}: ${describe(error)}`));

  const watch = (repository: GitRepository) => {
    if (watching.has(repository)) return;
    const root = repository.rootUri.fsPath;
    // Before its first status the extension has no HEAD to report, and the one it reports then is not a move.
    let known = repository.state.HEAD === undefined ? undefined : { commit: repository.state.HEAD.commit };
    watching.set(
      repository,
      repository.state.onDidChange(() => {
        const head = repository.state.HEAD;
        if (head === undefined) return;
        const before = known;
        known = { commit: head.commit };
        if (before === undefined || before.commit === head.commit) return notify(root);
        movedByCommit(root).then(
          (committed) => notify(root, committed ? { from: before.commit } : undefined),
          (error: unknown) => (log(`could not tell how HEAD moved in ${root}: ${describe(error)}`), notify(root)),
        );
      }),
    );
    notify(root);
  };

  const subscriptions = [
    api.onDidOpenRepository(watch),
    api.onDidCloseRepository((repository) => {
      watching.get(repository)?.dispose();
      watching.delete(repository);
    }),
  ];
  api.repositories.forEach(watch);

  return {
    dispose() {
      for (const subscription of [...subscriptions, ...watching.values()]) subscription.dispose();
      watching.clear();
    },
  };
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
