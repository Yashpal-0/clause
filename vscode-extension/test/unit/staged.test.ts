import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inBatches, lastMoveWasCommit, stagedOrCommitted, watchRepositories, type CommitsSince, type GitApi, type GitRepository } from '../../src/staged.ts';

// The user's own git configuration (autocrlf, hooks, signing) must not decide what these tests see.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;

interface Scratch {
  readonly dir: string;
  git(...args: string[]): string;
  write(name: string, text: string): string;
  /** Puts `text` in the index as the file's content without touching the disk, which is what staging part of a file leaves. */
  stage(name: string, text: string): void;
}

function withRepository(run: (scratch: Scratch) => Promise<void> | void): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clause-staged-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const stage = (name: string, text: string) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
  };
  git('init', '-q', '-b', 'master');
  return Promise.resolve(run({ dir, git, write, stage })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const commitAll = (scratch: Scratch, message = 'work') => {
  scratch.git('add', '-A');
  scratch.git('commit', '-q', '-m', message);
};

const head = (scratch: Scratch) => scratch.git('rev-parse', 'HEAD').trim();

test('a file you staged is taken, and a changed file you did not stage is not', () =>
  withRepository(async (scratch) => {
    const staged = scratch.write('a.txt', 'one\n');
    const left = scratch.write('b.txt', 'two\n');
    commitAll(scratch);
    writeFileSync(staged, 'one\nand more\n');
    writeFileSync(left, 'two\nand more\n');
    scratch.git('add', 'a.txt');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [staged, left]), new Set([staged]));
  }));

test('a file edited after you staged it is not taken, because the edit is not staged', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\n');
    commitAll(scratch);
    writeFileSync(path, 'two\n');
    scratch.git('add', 'a.txt');
    writeFileSync(path, 'three\n');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path]), new Set());
  }));

test('a file staged in part is not taken, because what is left is still pending', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\ntwo\nthree\n');
    commitAll(scratch);
    writeFileSync(path, 'ONE\ntwo\nTHREE\n');
    scratch.stage('a.txt', 'ONE\ntwo\nthree\n');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path]), new Set());
  }));

test('a new file you staged is taken, and one you left alone is not', () =>
  withRepository(async (scratch) => {
    scratch.write('first.txt', 'x\n');
    commitAll(scratch);
    const staged = scratch.write('new.txt', 'y\n');
    const left = scratch.write('left.txt', 'z\n');
    scratch.git('add', 'new.txt');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [staged, left]), new Set([staged]));
  }));

test('a file that is exactly as git has it is not taken unless you staged something: nothing of it was handed over', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\n');
    commitAll(scratch);

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path]), new Set());
  }));

test('a deletion you staged is taken, and one you did not is not', () =>
  withRepository(async (scratch) => {
    const staged = scratch.write('a.txt', 'one\n');
    const left = scratch.write('b.txt', 'two\n');
    commitAll(scratch);
    scratch.git('rm', '-q', 'a.txt');
    rmSync(left);

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [staged, left]), new Set([staged]));
  }));

test('a file git does not track is not taken, whether it is untracked or ignored', () =>
  withRepository(async (scratch) => {
    scratch.write('.gitignore', 'ignored.txt\n');
    scratch.write('tracked.txt', 'x\n');
    commitAll(scratch);
    const untracked = scratch.write('untracked.txt', 'y\n');
    const ignored = scratch.write('ignored.txt', 'z\n');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [untracked, ignored]), new Set());
  }));

test('file names are matched as they are, with spaces, brackets, stars and a leading dash', () =>
  withRepository(async (scratch) => {
    const names = ['we ird [1].txt', 'star*.txt', '-dash.txt', 'ünï.txt', ':(top)magic.txt'];
    const paths = names.map((name) => scratch.write(name, `${name}\n`));
    const decoy = scratch.write('starfish.txt', 'a decoy that the glob star* would match\n');
    scratch.git('--literal-pathspecs', 'add', '--', ...names);

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [...paths, decoy]), new Set(paths));
  }));

test('a file staged with other line endings than the disk has is taken, since git decides what a change is', () =>
  withRepository(async (scratch) => {
    scratch.git('config', 'core.autocrlf', 'true');
    const path = scratch.write('a.txt', 'one\r\ntwo\r\n');
    scratch.git('add', 'a.txt');

    assert.equal(scratch.git('show', ':a.txt'), 'one\ntwo\n', 'control: the index holds LF and the disk CRLF');
    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path]), new Set([path]));
  }));

test('a file staged in a repository that has no commit yet is taken', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\n');
    scratch.git('add', 'a.txt');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path]), new Set([path]));
  }));

test('files outside the repository are left out, and asking about none starts no git', async () => {
  await withRepository(async (scratch) => {
    const inside = scratch.write('a.txt', 'one\n');
    scratch.git('add', 'a.txt');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [inside, join(dirname(scratch.dir), 'elsewhere.txt'), '/etc/hostname']), new Set([inside]));
  });
  // A folder that is no repository would make git fail, and there was nothing to ask about.
  assert.deepEqual(await stagedOrCommitted(tmpdir(), []), new Set());
});

test('names are split in order into batches under the limit, and a name longer than the limit gets a batch of its own', () => {
  assert.deepEqual([...inBatches(['aaaa', 'bbbb', 'cccc', 'dddddddddddd', 'e'], 10)], [['aaaa', 'bbbb'], ['cccc'], ['dddddddddddd'], ['e']]);
  assert.deepEqual([...inBatches([], 10)], []);
});

test('many files are all looked at', () =>
  withRepository(async (scratch) => {
    const paths = Array.from({ length: 700 }, (_, index) => scratch.write(`generated/directory-${index % 7}/file-with-a-long-name-${String(index).padStart(5, '0')}.txt`, `${index}\n`));
    scratch.git('add', '-A');
    const edited = paths[650]!;
    writeFileSync(edited, 'changed\n');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, paths), new Set(paths.filter((path) => path !== edited)));
  }));

test('git failing is reported to the caller, not turned into "nothing is taken"', async () => {
  const notARepository = realpathSync(mkdtempSync(join(tmpdir(), 'clause-not-git-')));
  try {
    await assert.rejects(stagedOrCommitted(notARepository, [join(notARepository, 'a.txt')]));
  } finally {
    rmSync(notARepository, { recursive: true });
  }
});

// ---- commits ------------------------------------------------------------------------------------------------------

test('a file committed since a commit is taken, even when you never staged it by hand', () =>
  withRepository(async (scratch) => {
    const committed = scratch.write('a.txt', 'one\n');
    const untouched = scratch.write('b.txt', 'two\n');
    commitAll(scratch);
    const from = head(scratch);
    writeFileSync(committed, 'one\nand more\n');
    scratch.git('commit', '-q', '-a', '-m', 'the edit');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [committed, untouched], { from }), new Set([committed]));
  }));

test('without a commit to look since, a committed file is not taken: nothing says you handed it over', () =>
  withRepository(async (scratch) => {
    const committed = scratch.write('a.txt', 'one\n');
    commitAll(scratch);
    writeFileSync(committed, 'one\nand more\n');
    scratch.git('commit', '-q', '-a', '-m', 'the edit');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [committed]), new Set());
  }));

test('a file committed and then edited is not taken, because the edit is not committed', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\n');
    commitAll(scratch);
    const from = head(scratch);
    writeFileSync(path, 'two\n');
    scratch.git('commit', '-q', '-a', '-m', 'the edit');
    writeFileSync(path, 'three\n');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path], { from }), new Set());
  }));

test('every commit since the given one counts, not only the newest', () =>
  withRepository(async (scratch) => {
    const first = scratch.write('a.txt', 'one\n');
    const second = scratch.write('b.txt', 'two\n');
    const third = scratch.write('c.txt', 'three\n');
    commitAll(scratch);
    const from = head(scratch);
    writeFileSync(first, 'one!\n');
    scratch.git('commit', '-q', '-a', '-m', 'a');
    writeFileSync(second, 'two!\n');
    scratch.git('commit', '-q', '-a', '-m', 'b');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [first, second, third], { from }), new Set([first, second]));
  }));

test('the first commit of a repository counts, when the commits start from nothing', () =>
  withRepository(async (scratch) => {
    const committed = scratch.write('a.txt', 'one\n');
    commitAll(scratch);

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [committed], { from: undefined }), new Set([committed]));
  }));

test('a deletion committed since a commit is taken', () =>
  withRepository(async (scratch) => {
    const path = scratch.write('a.txt', 'one\n');
    commitAll(scratch);
    const from = head(scratch);
    rmSync(path);
    scratch.git('commit', '-q', '-a', '-m', 'remove it');

    assert.deepEqual(await stagedOrCommitted(scratch.dir, [path], { from }), new Set([path]));
  }));

test('the last move of HEAD is a commit after a commit, an amend and the first commit', () =>
  withRepository(async (scratch) => {
    scratch.write('a.txt', 'one\n');
    commitAll(scratch, 'first');
    assert.equal(await lastMoveWasCommit(scratch.dir), true, 'the first commit');

    scratch.write('a.txt', 'two\n');
    commitAll(scratch, 'second');
    assert.equal(await lastMoveWasCommit(scratch.dir), true, 'a commit');

    scratch.git('commit', '-q', '--amend', '-m', 'second, reworded');
    assert.equal(await lastMoveWasCommit(scratch.dir), true, 'an amend');
  }));

test('the last move of HEAD is not a commit after a checkout, a merge or a reset', () =>
  withRepository(async (scratch) => {
    scratch.write('a.txt', 'one\n');
    commitAll(scratch, 'first');
    scratch.git('checkout', '-q', '-b', 'side');
    scratch.write('b.txt', 'two\n');
    commitAll(scratch, 'on side');

    scratch.git('checkout', '-q', 'master');
    assert.equal(await lastMoveWasCommit(scratch.dir), false, 'a checkout');

    scratch.git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    assert.equal(await lastMoveWasCommit(scratch.dir), false, 'a merge git made by itself');

    scratch.git('reset', '-q', '--soft', 'HEAD~1');
    assert.equal(await lastMoveWasCommit(scratch.dir), false, 'a reset');
  }));

test('a repository that has no commit has no last move', () =>
  withRepository(async (scratch) => {
    assert.equal(await lastMoveWasCommit(scratch.dir), false);
  }));

// ---- watching the repositories the git extension has open ---------------------------------------------------------

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown) => {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }
  get listeners(): number {
    return this.#listeners.size;
  }
}

type Head = { commit?: string } | undefined;

/** A repository the way the git extension reports one: `HEAD` is undefined until its first status has run. */
function fakeRepository(root: string, head?: Head) {
  let current = head;
  const changed = new Emitter<void>();
  const repository: GitRepository = { rootUri: { fsPath: root }, state: { get HEAD() { return current; }, onDidChange: changed.event } };
  return {
    repository,
    changed,
    report(next: Head) {
      current = next;
      changed.fire();
    },
  };
}

function fakeGit(...open: GitRepository[]) {
  const opened = new Emitter<GitRepository>();
  const closed = new Emitter<GitRepository>();
  const api: GitApi = { repositories: open, onDidOpenRepository: opened.event, onDidCloseRepository: closed.event };
  return { api, opened, closed };
}

/** Lets the checks that run after an event finish: they are promises, not timers. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function watching(git: ReturnType<typeof fakeGit>, movedByCommit: (root: string) => Promise<boolean> = () => Promise.resolve(true)) {
  const looked: string[] = [];
  const logged: string[] = [];
  const watch = watchRepositories(
    git.api,
    (root, commits?: CommitsSince) => looked.push(commits === undefined ? root : `${root} since ${commits.from ?? 'the start'}`),
    (message) => logged.push(message),
    movedByCommit,
  );
  return { looked, logged, watch };
}

test('looks at a repository that is already open when watching starts, and at one that opens later', async () => {
  const early = fakeRepository('/work/early');
  const git = fakeGit(early.repository);
  const { looked } = watching(git);
  await settle();
  assert.deepEqual(looked, ['/work/early'], 'catching up on what was staged while the window was closed');

  git.opened.fire(fakeRepository('/work/late').repository);
  await settle();
  assert.deepEqual(looked, ['/work/early', '/work/late']);
});

test('looks again every time the git extension refreshes the repository, which is when a stage shows', async () => {
  const repository = fakeRepository('/work/a', { commit: 'c1' });
  const { looked } = watching(fakeGit(repository.repository));
  await settle();
  looked.length = 0;

  repository.report({ commit: 'c1' });
  repository.report({ commit: 'c1' });
  await settle();

  assert.deepEqual(looked, ['/work/a', '/work/a']);
});

test('says which commit HEAD was at when a commit moved it, and says nothing of commits when HEAD moved some other way', async () => {
  const repository = fakeRepository('/work/a', { commit: 'c1' });
  let commit = true;
  const { looked } = watching(fakeGit(repository.repository), () => Promise.resolve(commit));
  await settle();
  looked.length = 0;

  repository.report({ commit: 'c2' });
  await settle();
  assert.deepEqual(looked, ['/work/a since c1'], 'a commit');

  looked.length = 0;
  commit = false;
  repository.report({ commit: 'c3' });
  await settle();
  assert.deepEqual(looked, ['/work/a'], 'a checkout or a pull');
});

test('does not take the first report of a repository\'s HEAD for a commit, and ignores a refresh that has no HEAD yet', async () => {
  const repository = fakeRepository('/work/a', undefined);
  let asked = 0;
  const { looked } = watching(fakeGit(repository.repository), () => (asked++, Promise.resolve(true)));
  await settle();
  looked.length = 0;

  repository.report(undefined);
  await settle();
  assert.deepEqual(looked, [], 'nothing to go by yet');

  repository.report({ commit: 'c1' });
  await settle();
  assert.deepEqual({ looked, asked }, { looked: ['/work/a'], asked: 0 });
});

test('starts the commits from nothing when the first commit of a repository that had none moves HEAD', async () => {
  const repository = fakeRepository('/work/a', { commit: undefined });
  const { looked } = watching(fakeGit(repository.repository));
  await settle();
  looked.length = 0;

  repository.report({ commit: 'c1' });
  await settle();

  assert.deepEqual(looked, ['/work/a since the start']);
});

test('stops watching a repository that closes, and every repository when disposed', async () => {
  const first = fakeRepository('/work/a', { commit: 'c1' });
  const second = fakeRepository('/work/b', { commit: 'c1' });
  const git = fakeGit(first.repository, second.repository);
  const { looked, watch } = watching(git);
  await settle();
  looked.length = 0;

  git.closed.fire(first.repository);
  first.report({ commit: 'c1' });
  second.report({ commit: 'c1' });
  await settle();
  assert.deepEqual(looked, ['/work/b'], 'the closed repository is not watched');

  watch.dispose();
  second.report({ commit: 'c1' });
  git.opened.fire(fakeRepository('/work/c').repository);
  await settle();
  assert.deepEqual(looked, ['/work/b']);
  assert.equal(second.changed.listeners, 0, 'nothing is left listening');
  assert.equal(git.opened.listeners + git.closed.listeners, 0);
});

test('watches a repository once, however many times it is announced', async () => {
  const repository = fakeRepository('/work/a', { commit: 'c1' });
  const git = fakeGit(repository.repository);
  const { looked } = watching(git);

  git.opened.fire(repository.repository);
  await settle();

  assert.deepEqual(looked, ['/work/a']);
  assert.equal(repository.changed.listeners, 1);
});

test('reports a check of the last move that fails, looks without commits all the same, and goes on watching', async () => {
  const repository = fakeRepository('/work/a', { commit: 'c1' });
  let fail = true;
  const { looked, logged } = watching(fakeGit(repository.repository), () => (fail ? Promise.reject(new Error('git is gone')) : Promise.resolve(true)));
  await settle();
  looked.length = 0;

  repository.report({ commit: 'c2' });
  await settle();
  assert.deepEqual(looked, ['/work/a'], 'what was staged still counts');
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /\/work\/a.*git is gone/);

  fail = false;
  repository.report({ commit: 'c3' });
  await settle();
  assert.deepEqual(looked, ['/work/a', '/work/a since c2']);
});

test('reports a look that fails and goes on watching', async () => {
  const repository = fakeRepository('/work/a', { commit: 'c1' });
  const logged: string[] = [];
  let fail = true;
  watchRepositories(
    fakeGit(repository.repository).api,
    () => {
      if (fail) throw new Error('model is gone');
    },
    (message) => logged.push(message),
  );
  await settle();
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /\/work\/a.*model is gone/);

  fail = false;
  repository.report({ commit: 'c1' });
  await settle();
  assert.equal(logged.length, 1, 'the next look works');
});
