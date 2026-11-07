import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELOAD_FLAG,
  VERSION_KEY,
  VERSION_SKIP_FLAG,
  createUpdateFlow,
  decideUpdateAction,
  prepareNavigation,
} from '../src/pwa.js';

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function createFlow() {
  const calls = { post: 0, reload: 0 };
  const storage = memoryStorage();
  const flow = createUpdateFlow({
    postSkipWaiting: () => {
      calls.post += 1;
    },
    reload: () => {
      calls.reload += 1;
    },
    storage,
  });
  return { flow, calls, storage };
}

test('notifyReady is idempotent', () => {
  const { flow } = createFlow();
  assert.equal(flow.notifyReady(), true);
  assert.equal(flow.notifyReady(), false);
  assert.equal(flow.notifyReady(), false);
});

test('apply writes the reload flag and asks the worker to skip waiting', () => {
  const { flow, calls, storage } = createFlow();
  assert.equal(flow.apply(), true);
  assert.equal(storage.getItem(RELOAD_FLAG), '1');
  assert.equal(calls.post, 1);
  assert.equal(calls.reload, 0);
});

test('a second apply does not post again while a reload is pending', () => {
  const { flow, calls } = createFlow();
  assert.equal(flow.apply(), true);
  assert.equal(flow.apply(), false);
  assert.equal(calls.post, 1);
});

test('controllerChanged clears the flag and reloads exactly once', () => {
  const { flow, calls, storage } = createFlow();
  flow.apply();

  assert.equal(flow.controllerChanged(), true);
  assert.equal(storage.getItem(RELOAD_FLAG), null);
  assert.equal(flow.controllerChanged(), false);
  assert.equal(calls.reload, 1);
});

test('controllerChanged without a pending apply never reloads', () => {
  const { flow, calls } = createFlow();
  // The first-load clients.claim() also fires controllerchange.
  assert.equal(flow.controllerChanged(), false);
  assert.equal(calls.reload, 0);
});

test('apply after a completed reload cycle works again', () => {
  const { flow, calls } = createFlow();
  assert.equal(flow.apply(), true);
  assert.equal(flow.controllerChanged(), true);
  assert.equal(flow.apply(), true);
  assert.equal(calls.post, 2);
});

test('decideUpdateAction only auto-activates an idle page at a safe moment', () => {
  const base = { waiting: true, playing: false, importing: false, hidden: false, ageMs: 10_000 };

  // Hidden with a long-lived page is still safe to reload.
  assert.equal(decideUpdateAction({ ...base, hidden: true, ageMs: 10 * 60_000 }), 'auto');
  // A page that just loaded is safe even while visible.
  assert.equal(decideUpdateAction({ ...base, ageMs: 1000 }), 'auto');
  // Playback and imports must never be interrupted.
  assert.equal(decideUpdateAction({ ...base, playing: true }), 'banner');
  assert.equal(decideUpdateAction({ ...base, importing: true }), 'banner');
  // Visible and past the boot window: let the user decide.
  assert.equal(decideUpdateAction({ ...base, ageMs: 61_000 }), 'banner');
  // No waiting worker: nothing to do.
  assert.equal(decideUpdateAction({ ...base, waiting: false }), 'idle');
});

const VERSION = 'abc1234567';

function runPrepare({ href = 'https://x.test/', storage = memoryStorage(), session = memoryStorage() } = {}) {
  const replaces = [];
  const states = [];
  const result = prepareNavigation({
    version: VERSION,
    location: { href },
    history: { replaceState: (...args) => states.push(args) },
    storage,
    session,
    replace: (url) => replaces.push(url),
  });
  return { result, replaces, states, storage, session };
}

test('prepareNavigation records the version on a first visit without navigating', () => {
  const { result, replaces, storage } = runPrepare();
  assert.deepEqual(result, { reset: false, healed: false });
  assert.deepEqual(replaces, []);
  assert.equal(storage.getItem(VERSION_KEY), VERSION);
});

test('prepareNavigation heals a stale version exactly once', () => {
  const storage = memoryStorage();
  const session = memoryStorage();
  storage.setItem(VERSION_KEY, 'stale');

  const first = runPrepare({ storage, session });
  assert.deepEqual(first.result, { reset: false, healed: true });
  assert.deepEqual(first.replaces, [`/?v=${VERSION}`]);
  assert.equal(storage.getItem(VERSION_KEY), VERSION);

  const second = runPrepare({ storage, session });
  assert.deepEqual(second.result, { reset: false, healed: false });
  assert.deepEqual(second.replaces, []);
});

test('prepareNavigation skips the heal when our own reload marked the session', () => {
  const storage = memoryStorage();
  const session = memoryStorage();
  storage.setItem(VERSION_KEY, 'stale');
  session.setItem(VERSION_SKIP_FLAG, '1');

  const { result, replaces } = runPrepare({ storage, session });
  assert.deepEqual(result, { reset: false, healed: false });
  assert.deepEqual(replaces, []);
  assert.equal(session.getItem(VERSION_SKIP_FLAG), null);
  assert.equal(storage.getItem(VERSION_KEY), VERSION);
});

test('prepareNavigation strips the reset query from the address bar', () => {
  const { result, replaces, states } = runPrepare({ href: 'https://x.test/?reset=123#frag' });
  assert.deepEqual(states, [[null, '', '/']]);
  assert.equal(result.reset, true);
  assert.equal(result.healed, false);
  assert.deepEqual(replaces, []);
});

test('beforeReload runs once, after the flag is cleared and before the reload', () => {
  const order = [];
  const storage = memoryStorage();
  const flow = createUpdateFlow({
    postSkipWaiting: () => {},
    reload: () => order.push('reload'),
    storage,
    beforeReload: () => {
      assert.equal(storage.getItem(RELOAD_FLAG), null);
      order.push('before');
    },
  });

  flow.apply();
  assert.equal(flow.controllerChanged(), true);
  assert.deepEqual(order, ['before', 'reload']);
});

test('a throwing beforeReload still reloads', () => {
  let reloads = 0;
  const flow = createUpdateFlow({
    postSkipWaiting: () => {},
    reload: () => {
      reloads += 1;
    },
    storage: memoryStorage(),
    beforeReload: () => {
      throw new Error('marker failed');
    },
  });

  flow.apply();
  assert.equal(flow.controllerChanged(), true);
  assert.equal(reloads, 1);
});
