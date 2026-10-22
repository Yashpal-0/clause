import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Delayed } from '../../src/delayed.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the action runs once, after the delay', async () => {
  let runs = 0;
  const delayed = new Delayed(() => runs++, 30);
  delayed.trigger();
  assert.equal(runs, 0);
  assert.equal(delayed.scheduled, true);
  await sleep(80);
  assert.equal(runs, 1);
  assert.equal(delayed.scheduled, false);
});

test('triggering again restarts the delay, so a burst runs the action once, after it ends', async () => {
  let runs = 0;
  const delayed = new Delayed(() => runs++, 60);
  for (let round = 0; round < 4; round++) {
    delayed.trigger();
    await sleep(30);
  }
  assert.equal(runs, 0);
  await sleep(100);
  assert.equal(runs, 1);
});

test('flushing runs a scheduled action now and not again later', async () => {
  let runs = 0;
  const delayed = new Delayed(() => runs++, 30);
  delayed.trigger();
  delayed.flush();
  assert.equal(runs, 1);
  await sleep(80);
  assert.equal(runs, 1);
});

test('flushing with nothing scheduled does nothing', () => {
  let runs = 0;
  new Delayed(() => runs++, 30).flush();
  assert.equal(runs, 0);
});

test('a cancelled action does not run', async () => {
  let runs = 0;
  const delayed = new Delayed(() => runs++, 30);
  delayed.trigger();
  delayed.cancel();
  assert.equal(delayed.scheduled, false);
  await sleep(80);
  assert.equal(runs, 0);
});

test('the action can schedule itself again', async () => {
  let runs = 0;
  const delayed: Delayed = new Delayed(() => {
    if (++runs < 2) delayed.trigger();
  }, 20);
  delayed.trigger();
  await sleep(120);
  assert.equal(runs, 2);
});
