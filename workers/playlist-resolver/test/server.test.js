import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer, stripApiPrefix } from '../server.mjs';

function spotifyHtml(trackList) {
  const payload = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name: 'Today’s Top Hits',
              duration: 0,
              coverArt: { sources: [{ url: 'https://i.scdn.co/image/cover' }] },
              trackList,
            },
          },
        },
      },
    },
  };
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

const SPOTIFY_FIXTURE = spotifyHtml([
  { title: 'Loser', subtitle: 'Tame Impala', duration: 223069 },
]);

async function start(t, options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('stripApiPrefix strips only the /api prefix', () => {
  assert.equal(stripApiPrefix('/api/healthz'), '/healthz');
  assert.equal(stripApiPrefix('/api/resolve'), '/resolve');
  assert.equal(stripApiPrefix('/healthz'), '/healthz');
  assert.equal(stripApiPrefix('/api'), '/api');
});

test('server answers /healthz and /api/healthz with plain ok', async (t) => {
  const base = await start(t, { fetchImpl: async () => new Response(SPOTIFY_FIXTURE) });

  for (const path of ['/healthz', '/api/healthz']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'ok');
  }
});

test('server resolves spotify playlists and serves repeats from memory', async (t) => {
  let fetches = 0;
  const base = await start(t, {
    fetchImpl: async () => {
      fetches += 1;
      return new Response(SPOTIFY_FIXTURE);
    },
  });
  const target = `${base}/api/resolve?url=${encodeURIComponent('https://open.spotify.com/playlist/abc')}`;

  const first = await fetch(target);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.ok(body.items.length > 0);
  assert.equal(body.items[0].title, 'Loser');

  const second = await fetch(target);
  assert.equal(second.status, 200);
  assert.ok((await second.json()).items.length > 0);
  assert.equal(fetches, 1);
});

test('server rejects an unsupported url without touching upstream', async (t) => {
  let fetches = 0;
  const base = await start(t, {
    fetchImpl: async () => {
      fetches += 1;
      return new Response(SPOTIFY_FIXTURE);
    },
  });

  const response = await fetch(
    `${base}/api/resolve?url=${encodeURIComponent('https://example.com/x')}`,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'unsupported');
  assert.equal(fetches, 0);
});

test('server rate-limits per forwarded client and sets retry-after', async (t) => {
  const base = await start(t, {
    fetchImpl: async () => new Response(SPOTIFY_FIXTURE),
    rateLimit: { windowMs: 60_000, max: 2 },
  });
  const target = `${base}/api/resolve?url=${encodeURIComponent('https://open.spotify.com/playlist/abc')}`;
  const headers = { 'x-forwarded-for': '203.0.113.9' };

  assert.equal((await fetch(target, { headers })).status, 200);
  assert.equal((await fetch(target, { headers })).status, 200);

  const limited = await fetch(target, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await limited.json()).error, 'rate_limited');
});

test('server answers unknown paths with 404', async (t) => {
  const base = await start(t, { fetchImpl: async () => new Response(SPOTIFY_FIXTURE) });

  const response = await fetch(`${base}/api/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});
