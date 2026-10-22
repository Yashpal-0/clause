import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyedQueue } from '../../src/queue.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tasks with the same key run one after another, in the order they were queued', async () => {
  const queue = new KeyedQueue();
  const log: string[] = [];
  const slow = queue.run('a', async () => {
    log.push('slow start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    log.push('slow end');
  });
  const fast = queue.run('a', async () => {
    log.push('fast');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ['slow start', 'slow end', 'fast']);
});

test('tasks with different keys do not wait for each other', async () => {
  const queue = new KeyedQueue();
  let release!: () => void;
  const blocked = queue.run('a', () => new Promise<void>((resolve) => (release = resolve)));
  let ran = false;
  await queue.run('b', async () => {
    ran = true;
  });
  assert.equal(ran, true);
  release();
  await blocked;
});

test('a task gets the result of its own work', async () => {
  const queue = new KeyedQueue();
  assert.equal(await queue.run('a', async () => 42), 42);
});

test('a failing task rejects its own caller and lets the next one run', async () => {
  const queue = new KeyedQueue();
  const failing = queue.run('a', async () => {
    throw new Error('boom');
  });
  const next = queue.run('a', async () => 'ran');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ran');
});

test('a key with nothing left to run is forgotten', async () => {
  const queue = new KeyedQueue();
  await queue.run('a', async () => {});
  await tick();
  assert.equal(queue.size, 0);

  const pending = queue.run('b', () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  assert.equal(queue.size, 1);
  await pending;
  await tick();
  assert.equal(queue.size, 0);
});
