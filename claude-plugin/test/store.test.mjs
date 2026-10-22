import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultRoot, openStore } from '../store.mjs';
import { STORE_URL, runModule, tempDir } from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bytes a text-oriented store would corrupt: invalid UTF-8, NUL, CRLF, BOM. */
const AWKWARD_BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x62]);

function setup(t) {
  const root = join(tempDir(t), 'store');
  const work = tempDir(t);
  return { root, work, store: openStore(root) };
}

test('defaultRoot honours an absolute CLAUDE_PENDING_EDITS_DIR', () => {
  assert.equal(defaultRoot({ CLAUDE_PENDING_EDITS_DIR: '/somewhere/else' }), '/somewhere/else');
});

test('defaultRoot falls back to ~/.claude/pending-edits', () => {
  assert.equal(defaultRoot({}), join(homedir(), '.claude', 'pending-edits'));
});

test('defaultRoot rejects a relative override instead of silently using the real store', () => {
  assert.throws(() => defaultRoot({ CLAUDE_PENDING_EDITS_DIR: 'relative/dir' }), /absolute/);
});

test('idFor gives a symlink and its target the same id', (t) => {
  const { work, store } = setup(t);
  const target = join(work, 'target.txt');
  writeFileSync(target, 'x');
  symlinkSync(target, join(work, 'link.txt'));
  assert.equal(store.idFor(join(work, 'link.txt')), store.idFor(target));
});

test('idFor resolves a not-yet-existing file through symlinked directories', (t) => {
  const { work, store } = setup(t);
  mkdirSync(join(work, 'real'));
  symlinkSync(join(work, 'real'), join(work, 'alias'));
  assert.equal(store.idFor(join(work, 'alias', 'new', 'deep.txt')), store.idFor(join(work, 'real', 'new', 'deep.txt')));
});

test('idFor distinguishes different files and requires an absolute path', (t) => {
  const { work, store } = setup(t);
  assert.notEqual(store.idFor(join(work, 'a.txt')), store.idFor(join(work, 'b.txt')));
  assert.match(store.idFor(join(work, 'a.txt')), /^[0-9a-f]{64}$/);
  assert.throws(() => store.idFor('relative/a.txt'), /absolute/);
});

test('createEntry stores the exact baseline bytes and metadata', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.bin');
  assert.equal(store.createEntry({ path: file, existed: true, base: AWKWARD_BYTES }), true);

  const entry = store.readEntry(store.idFor(file));
  assert.ok(entry);
  assert.deepEqual(entry.base, AWKWARD_BYTES);
  assert.equal(entry.existed, true);
  assert.equal(entry.path, file);
  assert.equal(entry.id, store.idFor(file));
  assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
});

test('ensureEntriesDir creates the private directory entries are made in, so it can be watched before the first one exists', (t) => {
  const { root, work, store } = setup(t);
  assert.equal(existsSync(root), false);

  const dir = store.ensureEntriesDir();
  assert.equal(dir, join(root, 'entries'));
  assert.equal(statSync(dir).isDirectory(), true);
  assert.equal(statSync(dir).mode & 0o077, 0);

  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('x') });
  assert.deepEqual(readdirSync(dir), [store.idFor(file)]);
});

test('entryDir names the directory an entry is kept in, and refuses an id that could point elsewhere', (t) => {
  const { root, work, store } = setup(t);
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('x') });
  const id = store.idFor(file);

  assert.equal(store.entryDir(id), join(root, 'entries', id));
  assert.deepEqual(readdirSync(store.entryDir(id)).sort(), ['base', 'meta.json']);
  assert.throws(() => store.entryDir('../tmp'), { name: 'TypeError', message: /invalid entry id/ });
});

test('readMeta tells whether an entry is still there, and which creation of it, without reading the baseline', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  assert.equal(store.readMeta(store.idFor(file)), null);

  store.createEntry({ path: file, existed: true, base: Buffer.from('x') });
  const meta = store.readMeta(store.idFor(file));
  assert.ok(meta);
  assert.equal(meta.path, file);
  assert.equal(meta.createdAt, store.readEntry(store.idFor(file))?.createdAt);
  assert.equal('base' in meta, false);

  store.removeEntry(store.idFor(file));
  assert.equal(store.readMeta(store.idFor(file)), null);
});

test('createEntry for a file Claude created records no baseline', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'new.txt');
  assert.equal(store.createEntry({ path: file, existed: false, base: null }), true);

  const entry = store.readEntry(store.idFor(file));
  assert.equal(entry?.existed, false);
  assert.equal(entry?.base, null);
});

test('createEntry refuses an inconsistent existed/base pair', (t) => {
  const { work, store } = setup(t);
  assert.throws(() => store.createEntry({ path: join(work, 'a'), existed: true, base: null }), /base/);
  assert.throws(() => store.createEntry({ path: join(work, 'b'), existed: false, base: Buffer.from('x') }), /base/);
});

test('createEntry never overwrites an existing baseline', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('first') }), true);
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('second') }), false);
  assert.equal(store.readEntry(store.idFor(file))?.base?.toString(), 'first');
});

test('when creators race, exactly one wins and its baseline is the stored one', async (t) => {
  const { root, work } = setup(t);
  const file = join(work, 'raced.txt');
  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, file, tag, goAt] = process.argv.slice(1);
    while (Date.now() < Number(goAt)) {}
    const created = openStore(root).createEntry({ path: file, existed: true, base: Buffer.from('payload-' + tag) });
    console.log((created ? 'created:' : 'lost:') + tag);
  `;
  const goAt = String(Date.now() + 600);
  const runs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => runModule(code, [root, file, String(i), goAt])),
  );

  for (const run of runs) assert.equal(run.status, 0, run.stderr);
  const winners = runs.map((run) => run.stdout.trim()).filter((line) => line.startsWith('created:'));
  assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(runs.map((r) => r.stdout.trim()))}`);
  const store = openStore(root);
  assert.equal(store.readEntry(store.idFor(file))?.base?.toString(), 'payload-' + winners[0].split(':')[1]);
  assert.equal(store.listEntries().length, 1);
});

test('writeBase replaces the baseline of an existing entry', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('old') });
  const id = store.idFor(file);
  assert.equal(store.writeBase(id, Buffer.from('new')), true);
  assert.equal(store.readEntry(id)?.base?.toString(), 'new');
});

test('writeBase on a missing entry does not resurrect it', (t) => {
  const { work, store } = setup(t);
  const id = store.idFor(join(work, 'gone.txt'));
  assert.equal(store.writeBase(id, Buffer.from('x')), false);
  assert.equal(store.readEntry(id), null);
  assert.deepEqual(store.listEntries(), []);
});

test('writeBase never exposes a partially written baseline to a reader', async (t) => {
  const { root, work, store } = setup(t);
  const file = join(work, 'big.txt');
  const first = Buffer.alloc(2_000_000, 'a');
  const second = Buffer.alloc(2_000_000, 'b');
  store.createEntry({ path: file, existed: true, base: first });
  const id = store.idFor(file);

  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, id] = process.argv.slice(1);
    const store = openStore(root);
    const a = Buffer.alloc(2_000_000, 'a'), b = Buffer.alloc(2_000_000, 'b');
    for (let i = 0; i < 150; i++) store.writeBase(id, i % 2 ? a : b);
  `;
  let writerDone = false;
  const writer = runModule(code, [root, id]).then((run) => {
    writerDone = true;
    return run;
  });

  let reads = 0;
  let torn = 0;
  while (!writerDone) {
    const base = store.readEntry(id)?.base;
    reads++;
    if (!base || !(base.equals(first) || base.equals(second))) torn++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const run = await writer;
  assert.equal(run.status, 0, run.stderr);
  assert.ok(reads > 5, `reader only managed ${reads} reads`);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw a torn baseline`);
});

test('writeBase leaves no temporary files behind', (t) => {
  const { root, work, store } = setup(t);
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('a') });
  store.writeBase(store.idFor(file), Buffer.from('b'));
  const entryDir = join(root, 'entries', store.idFor(file));
  assert.deepEqual(readdirSync(entryDir).sort(), ['base', 'meta.json']);
});

test('removeEntry deletes the entry and lets a later edit start a fresh baseline', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('v1') });
  const id = store.idFor(file);

  assert.equal(store.removeEntry(id), true);
  assert.equal(store.readEntry(id), null);
  assert.equal(store.removeEntry(id), false);
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('v2') }), true);
  assert.equal(store.readEntry(id)?.base?.toString(), 'v2');
});

test('listEntries returns metadata for every entry and skips half-written ones', (t) => {
  const { root, work, store } = setup(t);
  store.createEntry({ path: join(work, 'a.txt'), existed: true, base: Buffer.from('a') });
  store.createEntry({ path: join(work, 'b.txt'), existed: false, base: null });
  mkdirSync(join(root, 'entries', 'deadbeef'), { recursive: true });
  writeFileSync(join(root, 'entries', 'deadbeef', 'base'), 'orphan');

  const listed = store.listEntries().map((entry) => entry.path).sort();
  assert.deepEqual(listed, [join(work, 'a.txt'), join(work, 'b.txt')]);
  assert.equal(store.readEntry('deadbeef'), null);
});

test('a corrupt entry reads as absent and is reported in errors.log', (t) => {
  const { root, work, store } = setup(t);
  const file = join(work, 'a.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('a') });
  const id = store.idFor(file);
  writeFileSync(join(root, 'entries', id, 'meta.json'), '{ not json');

  assert.equal(store.readEntry(id), null);
  assert.match(readLog(root), /corrupt/i);
});

function readLog(root) {
  const log = join(root, 'errors.log');
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

const touchedFile = (root, id) => join(root, 'entries', id, 'touched');

/** A pending file and its id, ready to be touched. */
function pendingFile(work, store) {
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('old') });
  return { file, id: store.idFor(file) };
}

test('touch records the tool call and the line, and readTouch gives them back', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);

  const before = Date.now();
  assert.equal(store.touch(id, { tool: 'toolu_01', line: 41 }), true);
  const after = Date.now();

  const touched = store.readTouch(id);
  assert.equal(touched?.tool, 'toolu_01');
  assert.equal(touched?.line, 41);
  assert.ok(touched !== null && touched.at >= before && touched.at <= after, `at ${touched?.at} is outside ${before}..${after}`);
});

test('readTouch is null for an entry nothing has touched, and for one that does not exist', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);

  assert.equal(store.readTouch(id), null);
  assert.equal(store.readTouch(store.idFor(join(work, 'nothing.txt'))), null);
});

test('a later touch replaces the earlier one', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.touch(id, { tool: 'toolu_01', line: 3 });
  store.touch(id, { tool: 'toolu_02', line: 0 });

  const touched = store.readTouch(id);
  assert.equal(touched?.tool, 'toolu_02');
  assert.equal(touched?.line, 0);
});

test('touching an entry that is gone does not bring it back or leave scratch files', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.removeEntry(id);

  assert.equal(store.touch(id, { tool: 'toolu_01', line: 0 }), false);
  assert.equal(store.readEntry(id), null);
  assert.deepEqual(store.listEntries(), []);
  assert.equal(existsSync(join(root, 'entries', id)), false);
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
});

test('touch leaves only the record behind', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.touch(id, { tool: 'toolu_01', line: 1 });

  assert.deepEqual(readdirSync(join(root, 'entries', id)).sort(), ['base', 'meta.json', 'touched']);
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
});

test('touch refuses a record that readTouch would not accept', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);
  const refused = [
    ['an empty tool id', { tool: '', line: 0 }, /tool must/],
    ['a tool id over 200 characters', { tool: 'x'.repeat(201), line: 0 }, /tool must/],
    ['a tool id that is not a string', { tool: 7, line: 0 }, /tool must/],
    ['a negative line', { tool: 't', line: -1 }, /line must/],
    ['a fractional line', { tool: 't', line: 1.5 }, /line must/],
    ['a line that is a string', { tool: 't', line: '3' }, /line must/],
    ['a line past a billion', { tool: 't', line: 1e9 + 1 }, /line must/],
    ['an infinite line', { tool: 't', line: Infinity }, /line must/],
    ['a line that is NaN', { tool: 't', line: NaN }, /line must/],
  ];
  for (const [name, info, message] of refused) {
    assert.throws(() => store.touch(id, info), { name: 'TypeError', message }, name);
  }
  assert.throws(() => store.touch('../escape', { tool: 't', line: 0 }), { name: 'TypeError', message: /invalid entry id/ });
  assert.equal(store.readTouch(id), null);
});

test('touch writes the largest record it allows, and readTouch reads it back', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);
  // Control characters are the worst case once JSON escapes them.
  for (const tool of ['x'.repeat(200), String.fromCharCode(1).repeat(200)]) {
    assert.equal(store.touch(id, { tool, line: 1e9 }), true);
    assert.equal(store.readTouch(id)?.tool, tool);
    assert.equal(store.readTouch(id)?.line, 1e9);
  }
  assert.equal(store.touch(id, { tool: 'x', line: 0 }), true);
  assert.equal(store.readTouch(id)?.line, 0);
});

test('readTouch reads anything but the exact shape as null', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  const ok = { v: 1, at: 1_700_000_000_000, tool: 'toolu_01', line: 3 };
  const unreadable = [
    ['text that is not JSON', '{ nope'],
    ['an empty file', ''],
    ['a JSON array', JSON.stringify([ok])],
    ['JSON null', 'null'],
    ['a JSON number', '7'],
    ['another format version', JSON.stringify({ ...ok, v: 2 })],
    ['no format version', JSON.stringify({ at: ok.at, tool: ok.tool, line: ok.line })],
    ['no tool', JSON.stringify({ ...ok, tool: undefined })],
    ['an empty tool', JSON.stringify({ ...ok, tool: '' })],
    ['a tool over 200 characters', JSON.stringify({ ...ok, tool: 'x'.repeat(201) })],
    ['a tool that is a number', JSON.stringify({ ...ok, tool: 5 })],
    ['a negative line', JSON.stringify({ ...ok, line: -1 })],
    ['a fractional line', JSON.stringify({ ...ok, line: 0.5 })],
    ['a line that is a string', JSON.stringify({ ...ok, line: '3' })],
    ['a line past a billion', JSON.stringify({ ...ok, line: 1e9 + 1 })],
    ['a time that is a string', JSON.stringify({ ...ok, at: 'now' })],
    ['a negative time', JSON.stringify({ ...ok, at: -1 })],
    ['a file over 4 KiB', JSON.stringify({ ...ok, padding: 'x'.repeat(5000) })],
  ];
  for (const [name, content] of unreadable) {
    writeFileSync(touchedFile(root, id), content);
    assert.equal(store.readTouch(id), null, name);
  }

  writeFileSync(touchedFile(root, id), JSON.stringify({ ...ok, somethingNew: 'ignored' }));
  assert.deepEqual(store.readTouch(id), { at: ok.at, tool: ok.tool, line: ok.line });
});

test('readTouch is null, not an error, when the record cannot be read at all', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  mkdirSync(touchedFile(root, id));

  assert.equal(store.readTouch(id), null);
});

test('touch never exposes a partial record to a reader', async (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  const a = 'a'.repeat(200);
  const b = 'b'.repeat(200);
  store.touch(id, { tool: a, line: 1 });

  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, id] = process.argv.slice(1);
    const store = openStore(root);
    for (let i = 0; i < 400; i++) store.touch(id, { tool: (i % 2 ? 'a' : 'b').repeat(200), line: i % 2 });
  `;
  let writerDone = false;
  const writer = runModule(code, [root, id]).then((run) => {
    writerDone = true;
    return run;
  });

  let reads = 0;
  let torn = 0;
  while (!writerDone) {
    const touched = store.readTouch(id);
    reads++;
    if (touched === null || (touched.tool !== a && touched.tool !== b)) torn++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const run = await writer;
  assert.equal(run.status, 0, run.stderr);
  assert.ok(reads > 5, `reader only managed ${reads} reads`);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw a torn record`);
});

test('removeEntry takes the touched record with it, and a later entry starts without one', (t) => {
  const { work, store } = setup(t);
  const { file, id } = pendingFile(work, store);
  store.touch(id, { tool: 'toolu_01', line: 2 });

  assert.equal(store.removeEntry(id), true);
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('v2') }), true);
  assert.equal(store.readTouch(id), null);
});

test('a touched record does not disturb reading, listing, sweeping or keeping an entry', (t) => {
  const { root, work, store } = setup(t);
  const { file, id } = pendingFile(work, store);
  store.touch(id, { tool: 'toolu_01', line: 2 });
  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
  utimesSync(touchedFile(root, id), twoDaysAgo, twoDaysAgo);
  utimesSync(join(root, 'entries', id), twoDaysAgo, twoDaysAgo);

  store.sweep({ maxAgeMs: DAY_MS });
  assert.equal(store.writeBase(id, Buffer.from('new')), true);

  assert.deepEqual(store.listEntries().map((entry) => entry.path), [file]);
  assert.equal(store.readEntry(id)?.base?.toString(), 'new');
  assert.equal(store.readTouch(id)?.tool, 'toolu_01');
});

const sessionsFile = (root, id) => join(root, 'entries', id, 'sessions');

/** Session folders only have to be absolute paths; none of these exists on disk. */
const PROJECT = '/work/project';
const OTHER = '/work/other';

/** What createEntry and addSessionDir refuse, because readSessionDirs would not accept it back. */
const UNUSABLE_SESSION_DIRS = [
  ['a relative path', 'project'],
  ['an empty string', ''],
  ['a path over 1024 characters', `/${'x'.repeat(1024)}`],
  ['a number', 7],
  ['null', null],
];

test('createEntry with a session folder keeps it in the entry from the moment the entry exists', (t) => {
  const { root, work, store } = setup(t);
  const file = join(work, 'f.txt');
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('old'), sessionDir: PROJECT }), true);

  const id = store.idFor(file);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT]);
  assert.deepEqual(store.readEntry(id)?.sessionDirs, [PROJECT]);
  assert.deepEqual(readdirSync(join(root, 'entries', id)).sort(), ['base', 'meta.json', 'sessions']);
});

test('readEntry carries the session folder of a file Claude created too', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'new.txt');
  store.createEntry({ path: file, existed: false, base: null, sessionDir: OTHER });

  assert.deepEqual(store.readEntry(store.idFor(file))?.sessionDirs, [OTHER]);
});

test('no reader sees a new entry before its session folder', async (t) => {
  const { root, work, store } = setup(t);
  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, work] = process.argv.slice(1);
    const store = openStore(root);
    for (let i = 0; i < 150; i++) {
      store.createEntry({ path: work + '/f' + i + '.txt', existed: true, base: Buffer.from('old'), sessionDir: '/work/project' });
    }
  `;
  let writerDone = false;
  const writer = runModule(code, [root, work]).then((run) => {
    writerDone = true;
    return run;
  });

  let seen = 0;
  let unrecorded = 0;
  while (!writerDone) {
    for (const meta of store.listEntries()) {
      seen++;
      if (store.readEntry(meta.id)?.sessionDirs.length !== 1) unrecorded++;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const run = await writer;
  assert.equal(run.status, 0, run.stderr);
  assert.ok(seen > 5, `reader only saw ${seen} entries`);
  assert.equal(unrecorded, 0, `${unrecorded} of ${seen} entries were visible without their session folder`);
});

test('an entry created without a session folder has none', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);

  assert.deepEqual(store.readSessionDirs(id), []);
  assert.deepEqual(store.readEntry(id)?.sessionDirs, []);
  assert.deepEqual(store.readSessionDirs(store.idFor(join(work, 'nothing.txt'))), []);
});

test('createEntry refuses a session folder that readSessionDirs would not accept, and creates nothing', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  for (const [name, sessionDir] of UNUSABLE_SESSION_DIRS) {
    assert.throws(() => store.createEntry({ path: file, existed: true, base: Buffer.from('old'), sessionDir }), /session folder/, name);
  }

  assert.deepEqual(store.listEntries(), []);
});

test('a createEntry that loses to an earlier one leaves the earlier session folders alone', (t) => {
  const { work, store } = setup(t);
  const file = join(work, 'f.txt');
  store.createEntry({ path: file, existed: true, base: Buffer.from('old'), sessionDir: PROJECT });

  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('newer'), sessionDir: OTHER }), false);
  assert.deepEqual(store.readSessionDirs(store.idFor(file)), [PROJECT]);
});

test('addSessionDir adds a folder to an entry that has none yet, and then to one that has', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);

  assert.equal(store.addSessionDir(id, PROJECT), true);
  assert.equal(store.addSessionDir(id, OTHER), true);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT, OTHER]);
});

test('addSessionDir for a folder already listed returns false and does not rewrite the record', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);
  const longAgo = new Date(Date.now() - 2 * DAY_MS);
  utimesSync(sessionsFile(root, id), longAgo, longAgo);
  const before = statSync(sessionsFile(root, id));

  assert.equal(store.addSessionDir(id, PROJECT), false);

  const after = statSync(sessionsFile(root, id));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT]);
});

test('addSessionDir keeps the newest 16 folders, dropping the oldest', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);
  const dirs = Array.from({ length: 17 }, (_, i) => `/work/p${i}`);
  for (const dir of dirs) assert.equal(store.addSessionDir(id, dir), true);

  assert.deepEqual(store.readSessionDirs(id), dirs.slice(1));
});

test('addSessionDir for an entry that is gone returns false and brings nothing back or leaves scratch files', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.removeEntry(id);

  assert.equal(store.addSessionDir(id, PROJECT), false);
  assert.equal(store.readEntry(id), null);
  assert.deepEqual(store.listEntries(), []);
  assert.equal(existsSync(join(root, 'entries', id)), false);
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
});

test('addSessionDir refuses a folder that readSessionDirs would not accept, and takes one of 1024 characters', (t) => {
  const { work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);
  for (const [name, dir] of UNUSABLE_SESSION_DIRS) assert.throws(() => store.addSessionDir(id, dir), /session folder/, name);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT]);

  const longest = `/${'x'.repeat(1023)}`;
  assert.equal(store.addSessionDir(id, longest), true);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT, longest]);
});

test('addSessionDir leaves only the record behind', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);

  assert.deepEqual(readdirSync(join(root, 'entries', id)).sort(), ['base', 'meta.json', 'sessions']);
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
});

test('addSessionDir replaces a record nobody could read with a good one', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  writeFileSync(sessionsFile(root, id), '{ nope');

  assert.equal(store.addSessionDir(id, PROJECT), true);
  assert.deepEqual(store.readSessionDirs(id), [PROJECT]);
});

test('readSessionDirs reads anything but the exact shape as no folders', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  const ok = { v: 1, dirs: [PROJECT, OTHER] };
  const unreadable = [
    ['text that is not JSON', '{ nope'],
    ['an empty file', ''],
    ['a JSON array', JSON.stringify([ok])],
    ['JSON null', 'null'],
    ['a JSON number', '7'],
    ['another format version', JSON.stringify({ ...ok, v: 2 })],
    ['no format version', JSON.stringify({ dirs: ok.dirs })],
    ['no folder list', JSON.stringify({ v: 1 })],
    ['a folder list that is an object', JSON.stringify({ v: 1, dirs: { 0: PROJECT } })],
    ['a folder that is a number', JSON.stringify({ v: 1, dirs: [PROJECT, 5] })],
    ['a relative folder', JSON.stringify({ v: 1, dirs: [PROJECT, 'project'] })],
    ['an empty folder', JSON.stringify({ v: 1, dirs: [''] })],
    ['a folder over 1024 characters', JSON.stringify({ v: 1, dirs: [`/${'x'.repeat(1024)}`] })],
    ['17 folders', JSON.stringify({ v: 1, dirs: Array.from({ length: 17 }, (_, i) => `/work/p${i}`) })],
    ['a file over 64 KiB', JSON.stringify({ ...ok, padding: 'x'.repeat(64 * 1024) })],
  ];
  for (const [name, content] of unreadable) {
    writeFileSync(sessionsFile(root, id), content);
    assert.deepEqual(store.readSessionDirs(id), [], name);
  }

  writeFileSync(sessionsFile(root, id), JSON.stringify({ ...ok, somethingNew: 'ignored' }));
  assert.deepEqual(store.readSessionDirs(id), ok.dirs);
});

test('readSessionDirs is empty, not an error, when the record cannot be read at all', (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  mkdirSync(sessionsFile(root, id));

  assert.deepEqual(store.readSessionDirs(id), []);
});

test('addSessionDir never exposes a partial record to a reader', async (t) => {
  const { root, work, store } = setup(t);
  const { id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);

  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, id] = process.argv.slice(1);
    const store = openStore(root);
    for (let i = 0; i < 300; i++) store.addSessionDir(id, '/work/p' + i);
  `;
  let writerDone = false;
  const writer = runModule(code, [root, id]).then((run) => {
    writerDone = true;
    return run;
  });

  let reads = 0;
  let torn = 0;
  while (!writerDone) {
    reads++;
    // PROJECT is in every version of the record, so an empty answer is a record read half-written.
    if (store.readSessionDirs(id).length === 0) torn++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const run = await writer;
  assert.equal(run.status, 0, run.stderr);
  assert.ok(reads > 5, `reader only managed ${reads} reads`);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw a torn record`);
});

test('removeEntry takes the session record with it, and a later entry starts without one', (t) => {
  const { work, store } = setup(t);
  const { file, id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);

  assert.equal(store.removeEntry(id), true);
  assert.equal(store.createEntry({ path: file, existed: true, base: Buffer.from('v2') }), true);
  assert.deepEqual(store.readSessionDirs(id), []);
});

test('a session record does not disturb reading, listing, sweeping or keeping an entry', (t) => {
  const { root, work, store } = setup(t);
  const { file, id } = pendingFile(work, store);
  store.addSessionDir(id, PROJECT);
  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
  utimesSync(sessionsFile(root, id), twoDaysAgo, twoDaysAgo);
  utimesSync(join(root, 'entries', id), twoDaysAgo, twoDaysAgo);

  store.sweep({ maxAgeMs: DAY_MS });
  assert.equal(store.writeBase(id, Buffer.from('new')), true);

  assert.deepEqual(store.listEntries().map((entry) => entry.path), [file]);
  assert.equal(store.readEntry(id)?.base?.toString(), 'new');
  assert.deepEqual(store.readSessionDirs(id), [PROJECT]);
});

test('staging round-trips the pre-edit bytes of an existing file', (t) => {
  const { work, store } = setup(t);
  store.stage('toolu_01', { path: join(work, 'f.bin'), existed: true, bytes: AWKWARD_BYTES });
  const staged = store.readStaging('toolu_01');
  assert.deepEqual(staged, { path: join(work, 'f.bin'), existed: true, bytes: AWKWARD_BYTES });
});

test('staging records that a file did not exist', (t) => {
  const { work, store } = setup(t);
  store.stage('toolu_02', { path: join(work, 'new.txt'), existed: false, bytes: null });
  assert.deepEqual(store.readStaging('toolu_02'), { path: join(work, 'new.txt'), existed: false, bytes: null });
});

test('readStaging is null for an unknown key and after dropStaging', (t) => {
  const { work, store } = setup(t);
  assert.equal(store.readStaging('nope'), null);
  store.stage('toolu_03', { path: join(work, 'f'), existed: false, bytes: null });
  store.dropStaging('toolu_03');
  assert.equal(store.readStaging('toolu_03'), null);
  store.dropStaging('toolu_03');
});

test('a hostile staging key cannot escape the staging directory', (t) => {
  const parent = tempDir(t);
  const root = join(parent, 'store');
  const store = openStore(root);
  store.stage('../../evil', { path: '/x', existed: false, bytes: null });
  assert.deepEqual(readdirSync(parent), ['store']);
  assert.equal(readdirSync(join(root, 'staging')).length, 1);
  assert.deepEqual(store.readStaging('../../evil'), { path: '/x', existed: false, bytes: null });
});

test('sweep removes stale staging and scratch data but keeps recent staging and all entries', (t) => {
  const { root, work, store } = setup(t);
  store.createEntry({ path: join(work, 'e.txt'), existed: true, base: Buffer.from('e') });
  store.stage('old', { path: join(work, 'o'), existed: false, bytes: null });
  mkdirSync(join(root, 'tmp', 'leftover'), { recursive: true });

  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
  for (const dir of [join(root, 'tmp', 'leftover'), ...readdirSync(join(root, 'staging')).map((name) => join(root, 'staging', name))]) {
    utimesSync(dir, twoDaysAgo, twoDaysAgo);
  }
  store.stage('fresh', { path: join(work, 'f'), existed: false, bytes: null });

  store.sweep({ maxAgeMs: DAY_MS });

  assert.equal(store.readStaging('old'), null);
  assert.notEqual(store.readStaging('fresh'), null);
  assert.equal(existsSync(join(root, 'tmp', 'leftover')), false);
  assert.equal(store.listEntries().length, 1);
});

test('appendDiscard then readDiscards returns the records once and advances the offset', (t) => {
  const { store } = setup(t);
  store.appendDiscard({ path: '/p/a.ts', scope: 'block', detail: 'lines 3-5' });
  store.appendDiscard({ path: '/p/b.ts', scope: 'file' });

  const first = store.readDiscards(0);
  assert.deepEqual(first.records.map((r) => [r.path, r.scope, r.detail]), [
    ['/p/a.ts', 'block', 'lines 3-5'],
    ['/p/b.ts', 'file', undefined],
  ]);
  assert.ok(first.records.every((r) => r.v === 1 && !Number.isNaN(Date.parse(r.ts))));
  assert.equal(first.nextOffset, store.logSize());
  assert.deepEqual(store.readDiscards(first.nextOffset).records, []);
});

test('readDiscards leaves a half-written last line for the next read', (t) => {
  const { root, store } = setup(t);
  store.appendDiscard({ path: '/p/a.ts', scope: 'block' });
  const afterFirst = store.logSize();
  appendFileSync(join(root, 'discards.jsonl'), '{"v":1,"path":"/p/b');

  const read = store.readDiscards(0);
  assert.equal(read.records.length, 1);
  assert.equal(read.nextOffset, afterFirst);
});

test('readDiscards skips a malformed line and keeps going', (t) => {
  const { root, store } = setup(t);
  store.appendDiscard({ path: '/p/a.ts', scope: 'block' });
  appendFileSync(join(root, 'discards.jsonl'), 'garbage\n');
  store.appendDiscard({ path: '/p/c.ts', scope: 'file' });

  assert.deepEqual(store.readDiscards(0).records.map((r) => r.path), ['/p/a.ts', '/p/c.ts']);
});

test('readDiscards treats an offset beyond the log as already caught up', (t) => {
  const { store } = setup(t);
  store.appendDiscard({ path: '/p/a.ts', scope: 'block' });
  const read = store.readDiscards(1_000_000);
  assert.deepEqual(read.records, []);
  assert.equal(read.nextOffset, store.logSize());
});

test('logSize is 0 before anything was discarded', (t) => {
  assert.equal(setup(t).store.logSize(), 0);
});

test('concurrent appends from several processes never interleave', async (t) => {
  const { root, store } = setup(t);
  const code = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const [root, tag] = process.argv.slice(1);
    const store = openStore(root);
    for (let i = 0; i < 50; i++) store.appendDiscard({ path: '/p/' + tag + '/' + i, scope: 'block', detail: 'x'.repeat(1500) });
  `;
  const runs = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => runModule(code, [root, tag])));
  for (const run of runs) assert.equal(run.status, 0, run.stderr);

  const { records } = store.readDiscards(0);
  assert.equal(records.length, 200);
  assert.equal(new Set(records.map((r) => r.path)).size, 200);
});

test('cursors are per session and start unset', (t) => {
  const { store } = setup(t);
  assert.equal(store.getCursor('session-1'), null);
  store.setCursor('session-1', 42);
  store.setCursor('session-2', 7);
  assert.equal(store.getCursor('session-1'), 42);
  assert.equal(store.getCursor('session-2'), 7);
});

test('a hostile session id cannot escape the cursors directory', (t) => {
  const parent = tempDir(t);
  const root = join(parent, 'store');
  const store = openStore(root);
  store.setCursor('../../evil', 5);
  assert.deepEqual(readdirSync(parent), ['store']);
  assert.equal(store.getCursor('../../evil'), 5);
});

test('logError appends a line naming the context and the error', (t) => {
  const { root, store } = setup(t);
  store.logError('post', new Error('boom'));
  const log = readLog(root);
  assert.match(log, /post/);
  assert.match(log, /boom/);
});

test('errors.log stays bounded', (t) => {
  const { root, store } = setup(t);
  const long = 'x'.repeat(10_000);
  for (let i = 0; i < 400; i++) store.logError('post', new Error(long));
  assert.ok(statSync(join(root, 'errors.log')).size <= 300 * 1024);
});
