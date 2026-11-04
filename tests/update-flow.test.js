import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RELOAD_FLAG, createUpdateFlow } from '../src/pwa.js';

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
