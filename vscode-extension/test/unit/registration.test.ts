import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewestRegistration } from '../../src/registration.ts';

/** Hands out registrations and writes down what happens to each, so a test can read the order of events. */
function registrar(failOn?: number) {
  const events: string[] = [];
  let made = 0;
  let live = 0;
  return {
    events,
    live: () => live,
    register() {
      made += 1;
      if (made === failOn) throw new Error(`registration ${made} refused`);
      const id = made;
      live += 1;
      events.push(`register ${id}`);
      return {
        dispose() {
          live -= 1;
          events.push(`dispose ${id}`);
        },
      };
    },
  };
}

/** Lets every queued microtask run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const ignore = () => {};

test('registers as soon as it is made', () => {
  const log = registrar();

  new NewestRegistration(() => log.register(), ignore);

  assert.deepEqual(log.events, ['register 1']);
});

test('renewing registers again first, and only then lets the old registration go', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.renew();
  await settle();

  // The new one has to exist before the old one goes: if making it fails, the old one is still there.
  assert.deepEqual(log.events, ['register 1', 'register 2', 'dispose 1']);
  assert.equal(log.live(), 1);
});

test('renewing waits for the end of the turn, so that whatever else is being registered in it comes first', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.renew();
  assert.deepEqual(log.events, ['register 1']);
  log.events.push('someone else registers in the same turn');
  await settle();

  assert.deepEqual(log.events, ['register 1', 'someone else registers in the same turn', 'register 2', 'dispose 1']);
});

test('renewing several times in one turn renews once', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.renew();
  newest.renew();
  newest.renew();
  await settle();

  assert.deepEqual(log.events, ['register 1', 'register 2', 'dispose 1']);
});

test('renewing in a later turn renews again', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.renew();
  await settle();
  newest.renew();
  await settle();

  assert.deepEqual(log.events, ['register 1', 'register 2', 'dispose 1', 'register 3', 'dispose 2']);
  assert.equal(log.live(), 1);
});

test('disposing releases the registration that is live, and a renewal still waiting then does nothing', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.renew();
  newest.dispose();
  await settle();

  assert.deepEqual(log.events, ['register 1', 'dispose 1']);
  assert.equal(log.live(), 0);
});

test('renewing after it is disposed does nothing', async () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);
  newest.dispose();

  newest.renew();
  await settle();

  assert.deepEqual(log.events, ['register 1', 'dispose 1']);
});

test('disposing twice releases once', () => {
  const log = registrar();
  const newest = new NewestRegistration(() => log.register(), ignore);

  newest.dispose();
  newest.dispose();

  assert.deepEqual(log.events, ['register 1', 'dispose 1']);
});

test('a registration that fails is reported and leaves the old one in place, and a later renewal can still succeed', async () => {
  const log = registrar(2);
  const errors: unknown[] = [];
  const newest = new NewestRegistration(() => log.register(), (error) => errors.push(error));

  newest.renew();
  await settle();

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /registration 2 refused/);
  assert.deepEqual(log.events, ['register 1']);
  assert.equal(log.live(), 1);

  newest.renew();
  await settle();

  assert.deepEqual(log.events, ['register 1', 'register 3', 'dispose 1']);
  assert.equal(log.live(), 1);
});
