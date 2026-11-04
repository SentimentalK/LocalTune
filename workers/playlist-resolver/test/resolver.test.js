import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../src/index.js';
import * as spotify from '../src/providers/spotify.js';
import * as netease from '../src/providers/netease.js';
import * as qq from '../src/providers/qq.js';
import { UpstreamChangedError, safeFetch } from '../src/providers/shared.js';

const SPOTIFY_URL = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const NETEASE_URL = 'https://music.163.com/playlist?id=3778678';
const QQ_URL = 'https://y.qq.com/n/ryqq/playlist/7011264342';

function spotifyHtml(trackList, name = 'Today’s Top Hits') {
  const payload = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name,
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function neteaseFixture() {
  return {
    code: 200,
    result: {
      name: '热歌榜',
      trackCount: 2,
      tracks: [
        {
          name: 'Hong Kong',
          artists: [{ name: 'The Weeknd' }, { name: '王菲' }],
          duration: 216993,
          album: { picUrl: 'http://p2.music.126.net/cover.jpg' },
        },
        {
          name: 'Solo',
          artists: [{ name: 'Soloist' }],
          duration: 200000,
          album: { picUrl: 'https://p2.music.126.net/other.jpg' },
        },
      ],
    },
  };
}

function qqFixture() {
  return {
    code: 0,
    subcode: 0,
    cdlist: [
      {
        dissname: '温暖的今日私享',
        songnum: 1,
        songlist: [
          {
            songname: '在你的世界迷路 (抒情版)',
            singer: [{ name: '糖晓晓' }, { name: '某某' }],
            interval: 231,
            albummid: '000v6G9a48jTpr',
          },
        ],
      },
    ],
  };
}

function memoryCache() {
  const map = new Map();
  return {
    map,
    async match(key) {
      const hit = map.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      map.set(key, response.clone());
    },
  };
}

function request(path, options = {}) {
  return new Request(`https://resolver.example${path}`, options);
}

test('spotify provider parses title, multi-artist subtitle, duration and cover', async () => {
  const html = spotifyHtml([
    {
      uri: 'spotify:track:1',
      title: 'Loser',
      subtitle: 'KAROL G,\u00a0Judeline,\u00a0rusowsky',
      duration: 223069,
      isExplicit: true,
      audioPreview: { format: 'MP3_96', url: 'https://p.scdn.co/mp3-preview/abc' },
      entityType: 'track',
    },
  ]);

  const result = await spotify.resolve('abc', { fetchImpl: async () => new Response(html) });

  assert.equal(result.name, 'Today’s Top Hits');
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    title: 'Loser',
    artist: 'KAROL G, Judeline, rusowsky',
    durationMs: 223069,
    coverUrl: 'https://i.scdn.co/image/cover',
  });
  assert.equal(JSON.stringify(result).includes('p.scdn.co'), false);
});

test('spotify provider flags a 100-track payload as truncated', async () => {
  const trackList = Array.from({ length: 100 }, (_, index) => ({
    title: `Track ${index}`,
    subtitle: 'Artist',
    duration: 1000,
  }));

  const result = await spotify.resolve('abc', {
    fetchImpl: async () => new Response(spotifyHtml(trackList)),
  });

  assert.equal(result.items.length, 100);
  assert.equal(result.truncated, true);
});

test('spotify provider rejects a page without __NEXT_DATA__', async () => {
  await assert.rejects(
    spotify.resolve('abc', { fetchImpl: async () => new Response('<html>nope</html>') }),
    UpstreamChangedError,
  );
});

test('netease provider parses artists, milliseconds and upgrades covers', async () => {
  const result = await netease.resolve('3778678', {
    fetchImpl: async () => json(neteaseFixture()),
  });

  assert.equal(result.name, '热歌榜');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items, [
    {
      title: 'Hong Kong',
      artist: 'The Weeknd, 王菲',
      durationMs: 216993,
      coverUrl: 'https://p2.music.126.net/cover.jpg',
    },
    {
      title: 'Solo',
      artist: 'Soloist',
      durationMs: 200000,
      coverUrl: 'https://p2.music.126.net/other.jpg',
    },
  ]);
});

test('netease provider rejects a non-2xx upstream', async () => {
  await assert.rejects(
    netease.resolve('1', { fetchImpl: async () => new Response('down', { status: 503 }) }),
    (error) => error.name === 'UpstreamError' && error.status === 503,
  );
});

test('qq provider parses names, seconds to milliseconds and album cover', async () => {
  const result = await qq.resolve('7011264342', {
    fetchImpl: async () => json(qqFixture()),
  });

  assert.equal(result.name, '温暖的今日私享');
  assert.deepEqual(result.items, [
    {
      title: '在你的世界迷路 (抒情版)',
      artist: '糖晓晓, 某某',
      durationMs: 231000,
      coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000v6G9a48jTpr.jpg',
    },
  ]);
});

test('qq provider treats subcode 1 as an upstream change', async () => {
  await assert.rejects(
    qq.resolve('1', {
      fetchImpl: async () => json({ code: 0, subcode: 1, msg: 'invalid referer' }),
    }),
    UpstreamChangedError,
  );
});

test('safeFetch blocks non-https and non-whitelisted hosts', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('{}');
  };

  await assert.rejects(safeFetch(fetchImpl, 'http://open.spotify.com/embed/playlist/abc'), UpstreamChangedError);
  await assert.rejects(safeFetch(fetchImpl, 'https://evil.example/steal'), UpstreamChangedError);
  assert.equal(called, false);

  const redirected = await safeFetch(fetchImpl, 'https://open.spotify.com/embed/playlist/abc');
  assert.equal(redirected.status, 200);
  assert.equal(called, true);
});

test('handler answers /healthz without an origin', async () => {
  const handle = createHandler({ fetchImpl: async () => json({}), cache: null });
  const response = await handle(request('/healthz'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('handler rejects a disallowed origin with 403', async () => {
  const handle = createHandler({ fetchImpl: async () => json({}), cache: null });
  const response = await handle(
    request(`/resolve?url=${encodeURIComponent(NETEASE_URL)}`, {
      headers: { origin: 'https://evil.example' },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('handler rejects a missing or unsupported url with 400', async () => {
  const handle = createHandler({ fetchImpl: async () => json({}), cache: null });

  const missing = await handle(request('/resolve'));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'unsupported' });

  const foreign = await handle(
    request(`/resolve?url=${encodeURIComponent('https://example.com/playlist?id=1')}`),
  );
  assert.equal(foreign.status, 400);
  assert.deepEqual(await foreign.json(), { error: 'unsupported' });
});

test('handler rate-limits after max requests in the window', async () => {
  const clock = 1_000;
  const handle = createHandler({
    fetchImpl: async () => json(neteaseFixture()),
    cache: null,
    now: () => clock,
    rateLimit: { windowMs: 60_000, max: 2 },
  });
  const target = `/resolve?url=${encodeURIComponent(NETEASE_URL)}`;

  assert.equal((await handle(request(target))).status, 200);
  assert.equal((await handle(request(target))).status, 200);

  const limited = await handle(request(target));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(await limited.json(), { error: 'rate_limited' });
});

test('handler serves a cached payload without calling upstream twice', async () => {
  let fetches = 0;
  const cache = memoryCache();
  const handle = createHandler({
    fetchImpl: async () => {
      fetches += 1;
      return json(neteaseFixture());
    },
    cache,
    now: () => 0,
  });

  const first = await handle(request(`/resolve?url=${encodeURIComponent(NETEASE_URL)}`));
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  const second = await handle(request(`/resolve?url=${encodeURIComponent(NETEASE_URL)}`));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstBody);
  assert.equal(fetches, 1);
  assert.equal(cache.map.size, 1);

  // Cross-origin allowed traffic to the same key reuses the cache entry.
  const third = await handle(
    request(`/resolve?url=${encodeURIComponent(NETEASE_URL)}`, {
      headers: { origin: 'https://tune.mainstayx.com' },
    }),
  );
  assert.equal(third.headers.get('access-control-allow-origin'), 'https://tune.mainstayx.com');
  assert.equal(fetches, 1);
});

test('handler attaches CORS headers to error responses for allowed origins', async () => {
  const handle = createHandler({ fetchImpl: async () => json({}), cache: null });
  const response = await handle(
    request('/resolve', { headers: { origin: 'http://localhost:4173' } }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4173');
});

test('handler answers OPTIONS preflight with 204 and CORS headers', async () => {
  const handle = createHandler({ fetchImpl: async () => json({}), cache: null });
  const response = await handle(
    request('/resolve', {
      method: 'OPTIONS',
      headers: { origin: 'https://tune.mainstayx.com' },
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://tune.mainstayx.com');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET,OPTIONS');
  assert.equal(response.headers.get('access-control-max-age'), '86400');
});

test('handler maps an empty upstream track list to upstream_changed', async () => {
  const empty = {
    code: 200,
    result: { name: 'Empty', tracks: [] },
  };
  const handle = createHandler({
    fetchImpl: async () => json(empty),
    cache: null,
    now: () => 0,
  });

  const response = await handle(request(`/resolve?url=${encodeURIComponent(NETEASE_URL)}`));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream_changed' });
});

test('handler never includes audio preview URLs in its payload', async () => {
  const html = spotifyHtml([
    {
      title: 'Loser',
      subtitle: 'Tame Impala',
      duration: 223069,
      audioPreview: { format: 'MP3_96', url: 'https://p.scdn.co/mp3-preview/abc' },
    },
  ]);
  const handle = createHandler({
    fetchImpl: async () => new Response(html),
    cache: null,
    now: () => 0,
  });

  const response = await handle(request(`/resolve?url=${encodeURIComponent(SPOTIFY_URL)}`));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('p.scdn.co'), false);
  assert.equal(text.includes('audioPreview'), false);
  assert.equal(text.includes('mp3-preview'), false);

  const body = JSON.parse(text);
  assert.equal(body.source, 'spotify');
  assert.deepEqual(body.items[0], {
    title: 'Loser',
    artist: 'Tame Impala',
    durationMs: 223069,
    coverUrl: 'https://i.scdn.co/image/cover',
  });
});

test('handler normalizes QQ seconds to milliseconds end-to-end', async () => {
  const handle = createHandler({
    fetchImpl: async () => json(qqFixture()),
    cache: null,
    now: () => 0,
  });
  const response = await handle(request(`/resolve?url=${encodeURIComponent(QQ_URL)}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'qq');
  assert.equal(body.items[0].durationMs, 231000);
});
