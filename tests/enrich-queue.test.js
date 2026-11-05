import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';

// Exercises the drain lifecycle without IndexedDB: `_flushEnriched` is stubbed,
// and the store prototype methods run against a minimal host object.
test('a sync merged during the final flush restarts the enrich drain', async () => {
  const queues = new Map();
  const queue = { running: false, cancelled: false, pending: new Map(), seen: 0 };
  queue.pending.set('fsa:a.mp3', { entry: { path: 'a.mp3' }, trackId: 'fsa:a.mp3' });
  queues.set('local', queue);

  const drains = [];
  let flushCalls = 0;
  const fake = {
    sources: { local: { trackSource: 'fsa' } },
    _state: {
      tracks: [
        { id: 'fsa:a.mp3', path: 'a.mp3' },
        { id: 'fsa:b.mp3', path: 'b.mp3' },
      ],
    },
    queue: { tracks: [] },
    _enrichQueues: queues,
    _reflectQueue() {},
    _reconcileQueue() {},
    _refreshSource() {},
    _emit() {},
    _savePlayback() {},
    _drainEnrich(kind, target) {
      const pending = Store.prototype._drainEnrich.call(fake, kind, target);
      drains.push(pending);
      return pending;
    },
    async _flushEnriched(accepted) {
      flushCalls += 1;
      accepted.length = 0;
      if (flushCalls === 2) {
        // A second sync lands while the final flush is still awaited.
        Store.prototype._enrich.call(fake, 'local', [
          { entry: { path: 'b.mp3' }, trackId: 'fsa:b.mp3' },
        ]);
      }
    },
  };

  await fake._drainEnrich('local', queue);
  // The finally block restarted exactly one worker for the merged item.
  assert.equal(drains.length, 2);
  await drains[1];

  assert.equal(queue.running, false);
  assert.equal(queue.pending.size, 0);
  assert.equal(fake._enrichQueues.has('local'), false);
  assert.equal(drains.length, 2);
  assert.deepEqual(
    fake._state.tracks.map((track) => track.id),
    ['fsa:a.mp3', 'fsa:b.mp3'],
  );
});
