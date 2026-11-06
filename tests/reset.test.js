import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESET_STEPS,
  createResetSteps,
  resetAllData,
  runResetSteps,
} from '../src/core/reset.js';

function request() {
  const req = {};
  // Settle on the next microtask, the way IndexedDB delivers events.
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

test('runResetSteps runs in order, continues past a failure and reports only it', async () => {
  const order = [];
  const steps = ['first', 'second', 'third'].map((name) => ({
    name,
    run: () => {
      order.push(name);
      if (name === 'second') throw new Error('boom');
    },
  }));

  const seen = [];
  const failures = await runResetSteps(steps, {
    onError: (name, error) => seen.push([name, error.message]),
  });

  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.deepEqual(failures.map((item) => item.name), ['second']);
  assert.equal(failures[0].error.message, 'boom');
  assert.deepEqual(seen, [['second', 'boom']]);
});

test('the indexedDB step closes the open connection before deleting localtune', async () => {
  const calls = [];
  let req = null;
  const factory = {
    deleteDatabase(name) {
      calls.push(`delete:${name}`);
      req = request();
      return req;
    },
  };
  const store = { db: { close: () => calls.push('close') } };

  const step = createResetSteps({ store, indexedDB: factory }).find(
    (item) => item.name === 'indexedDB',
  );
  const done = step.run();

  assert.deepEqual(calls, ['close', 'delete:localtune']);
  assert.equal(await done, 'deleted');
});

test('a blocked deleteDatabase closes again and resolves instead of hanging', async () => {
  const calls = [];
  let req = null;
  const factory = {
    deleteDatabase(name) {
      calls.push(`delete:${name}`);
      req = {};
      return req;
    },
  };
  const store = { db: { close: () => calls.push('close') } };

  const step = createResetSteps({ store, indexedDB: factory }).find(
    (item) => item.name === 'indexedDB',
  );
  const done = step.run();

  req.onblocked();

  assert.equal(await done, 'blocked');
  assert.deepEqual(calls, ['close', 'delete:localtune', 'close']);
});

test('every facility is wiped: caches, workers, storages and the OPFS music folder', async () => {
  const deletedCaches = [];
  const unregistered = [];
  const removals = [];
  const cleared = [];
  const missing = new Error('missing');
  missing.name = 'NotFoundError';

  const steps = createResetSteps({
    caches: {
      keys: async () => ['localtune-1', 'other-cache'],
      delete: async (key) => deletedCaches.push(key),
    },
    serviceWorker: {
      getRegistrations: async () => [
        { unregister: async () => unregistered.push('a') },
        { unregister: async () => unregistered.push('b') },
      ],
    },
    opfs: {
      getDirectory: async () => ({
        removeEntry: async (name, options) => removals.push([name, options]),
      }),
    },
    storage: { clear: () => cleared.push('localStorage') },
    sessionStorage: { clear: () => cleared.push('sessionStorage') },
  });

  assert.deepEqual(
    steps.map((item) => item.name),
    RESET_STEPS,
  );

  const failures = await runResetSteps(steps);

  assert.deepEqual(failures, []);
  assert.deepEqual(deletedCaches, ['localtune-1', 'other-cache']);
  assert.deepEqual(unregistered, ['a', 'b']);
  assert.deepEqual(removals, [['music', { recursive: true }]]);
  assert.deepEqual(cleared, ['localStorage', 'sessionStorage']);

  // A missing OPFS folder is not a failure; other errors are.
  const swallowing = createResetSteps({
    opfs: { getDirectory: async () => ({ removeEntry: async () => { throw missing; } }) },
  });
  assert.deepEqual(await runResetSteps(swallowing), []);

  const denied = new Error('denied');
  const failing = createResetSteps({
    opfs: { getDirectory: async () => ({ removeEntry: async () => { throw denied; } }) },
  });
  const reported = await runResetSteps(failing);
  assert.deepEqual(reported.map((item) => item.name), ['opfs']);
});

test('resetAllData reloads even when a step fails', async () => {
  let reloads = 0;
  const failures = await resetAllData({
    store: { player: { pause: () => { throw new Error('pause failed'); } } },
    indexedDB: { deleteDatabase: () => request() },
    reload: () => {
      reloads += 1;
    },
  });

  assert.equal(reloads, 1);
  assert.deepEqual(failures.map((item) => item.name), ['player']);
});
