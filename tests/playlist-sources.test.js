import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubePlaylistId,
  parseYouTubeTitle,
  parseIsoDuration,
  resolveYouTubePlaylist,
} from '../src/core/playlist/sources/youtube.js';
import { platformOfUrl, resolveViaProxy } from '../src/core/playlist/sources/proxy.js';

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function response(status) {
  return { status, ok: status >= 200 && status < 300 };
}

test('parseYouTubePlaylistId reads list ids from youtube.com URLs', () => {
  assert.equal(
    parseYouTubePlaylistId('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'),
    'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  );
  assert.equal(
    parseYouTubePlaylistId('https://youtu.be/abc123?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'),
    'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
  );
  assert.equal(
    parseYouTubePlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_kWWP9S8yM'),
    'OLAK5uy_kWWP9S8yM',
  );
  assert.equal(
    parseYouTubePlaylistId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123'),
    'PL123',
  );
});

test('parseYouTubePlaylistId rejects missing or foreign ids', () => {
  assert.equal(parseYouTubePlaylistId('https://www.youtube.com/playlist'), null);
  assert.equal(parseYouTubePlaylistId('https://www.youtube.com/playlist?list='), null);
  assert.equal(parseYouTubePlaylistId('https://example.com/playlist?list=PL123'), null);
  assert.equal(parseYouTubePlaylistId('not a url'), null);
  assert.equal(parseYouTubePlaylistId(null), null);
});

test('parseYouTubeTitle splits artist and strips official-video noise', () => {
  assert.deepEqual(parseYouTubeTitle('Artist - Title (Official Video)'), {
    artist: 'Artist',
    title: 'Title',
  });
});

test('parseYouTubeTitle drops everything after a pipe', () => {
  assert.deepEqual(parseYouTubeTitle('Artist - Title | Lyrics'), {
    artist: 'Artist',
    title: 'Title',
  });
});

test('parseYouTubeTitle keeps qualifiers that are not noise', () => {
  assert.deepEqual(parseYouTubeTitle('Title (Live)'), { artist: '', title: 'Title (Live)' });
});

test('parseYouTubeTitle strips 4K and keeps extra dashes in the title', () => {
  assert.deepEqual(parseYouTubeTitle('Artist - Title [4K]'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseYouTubeTitle('A - B - C'), { artist: 'A', title: 'B - C' });
});

test('parseIsoDuration converts ISO 8601 durations to milliseconds', () => {
  assert.equal(parseIsoDuration('PT3M45S'), 225000);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723000);
  assert.equal(parseIsoDuration('PT0S'), 0);
  assert.equal(parseIsoDuration('PT45S'), 45000);
});

test('parseIsoDuration rejects unsupported shapes', () => {
  assert.equal(parseIsoDuration('P1D'), null);
  assert.equal(parseIsoDuration('PT'), null);
  assert.equal(parseIsoDuration('3:45'), null);
  assert.equal(parseIsoDuration(null), null);
});

test('resolveYouTubePlaylist paginates, batches videos and fills artist fallback', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);

    if (parsed.pathname.endsWith('/playlists')) {
      return jsonResponse({ items: [{ snippet: { title: 'Road Trip' } }] });
    }

    if (parsed.pathname.endsWith('/playlistItems')) {
      if (!parsed.searchParams.get('pageToken')) {
        return jsonResponse({
          items: [
            {
              contentDetails: { videoId: 'vidA' },
              snippet: {
                title: 'Artist One - Song One (Official Video)',
                videoOwnerChannelTitle: 'Artist One - Topic',
                thumbnails: { medium: { url: 'https://i.ytimg.com/vi/vidA/mq.jpg' } },
              },
            },
          ],
          nextPageToken: 'page2',
        });
      }
      return jsonResponse({
        items: [
          {
            contentDetails: { videoId: 'vidB' },
            snippet: {
              title: 'Song Two',
              videoOwnerChannelTitle: 'Channel Two - Topic',
              thumbnails: { default: { url: 'https://i.ytimg.com/vi/vidB/default.jpg' } },
            },
          },
        ],
      });
    }

    if (parsed.pathname.endsWith('/videos')) {
      assert.deepEqual(parsed.searchParams.get('id'), 'vidA,vidB');
      return jsonResponse({
        items: [
          { id: 'vidA', contentDetails: { duration: 'PT3M45S' } },
          { id: 'vidB', contentDetails: { duration: 'PT0S' } },
        ],
      });
    }

    throw new Error(`unexpected url ${url}`);
  };

  const result = await resolveYouTubePlaylist({
    url: 'https://www.youtube.com/playlist?list=PLtest',
    apiKey: 'test-key',
    fetchImpl,
  });

  assert.equal(result.source, 'youtube');
  assert.equal(result.name, 'Road Trip');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items, [
    {
      title: 'Song One',
      artist: 'Artist One',
      durationMs: 225000,
      coverUrl: 'https://i.ytimg.com/vi/vidA/mq.jpg',
    },
    {
      title: 'Song Two',
      artist: 'Channel Two',
      durationMs: 0,
      coverUrl: 'https://i.ytimg.com/vi/vidB/default.jpg',
    },
  ]);

  assert.equal(calls.length, 4);
  assert.ok(calls[0].includes('/playlists'));
  assert.ok(calls[1].includes('/playlistItems'));
  assert.ok(calls[2].includes('pageToken=page2'));
  assert.ok(calls[3].includes('/videos'));
});

test('resolveYouTubePlaylist keeps the raw title when parsing leaves it empty', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/playlists')) return jsonResponse({ items: [] });
    if (parsed.pathname.endsWith('/playlistItems')) {
      return jsonResponse({
        items: [
          {
            contentDetails: { videoId: 'vidA' },
            snippet: { title: '(Official Video)', videoOwnerChannelTitle: 'Topicless' },
          },
        ],
      });
    }
    return jsonResponse({ items: [{ id: 'vidA', contentDetails: {} }] });
  };

  const result = await resolveYouTubePlaylist({
    url: 'https://youtu.be/x?list=PLtest',
    apiKey: 'k',
    fetchImpl,
  });
  assert.equal(result.items[0].title, '(Official Video)');
  assert.equal(result.items[0].artist, 'Topicless');
  assert.equal(result.items[0].durationMs, 0);
  assert.equal(result.items[0].coverUrl, null);
});

test('resolveYouTubePlaylist requires an API key', async () => {
  await assert.rejects(
    resolveYouTubePlaylist({ url: 'https://www.youtube.com/playlist?list=PL1', apiKey: '' }),
    /playlists\.error\.needApiKey/,
  );
  await assert.rejects(
    resolveYouTubePlaylist({ url: 'https://www.youtube.com/playlist?list=PL1' }),
    /playlists\.error\.needApiKey/,
  );
});

test('resolveYouTubePlaylist rejects unsupported URLs', async () => {
  await assert.rejects(
    resolveYouTubePlaylist({ url: 'https://example.com/playlist?list=PL1', apiKey: 'k' }),
    /playlists\.error\.unsupportedUrl/,
  );
});

test('resolveYouTubePlaylist surfaces upstream status failures', async () => {
  await assert.rejects(
    resolveYouTubePlaylist({
      url: 'https://www.youtube.com/playlist?list=PL1',
      apiKey: 'k',
      fetchImpl: async () => response(403),
    }),
    /playlists\.error\.youtubeFailed/,
  );
});

test('platformOfUrl recognizes Spotify playlist URLs', () => {
  assert.equal(platformOfUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'spotify');
  assert.equal(
    platformOfUrl('https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'),
    'spotify',
  );
});

test('platformOfUrl recognizes NetEase query and hash URLs', () => {
  assert.equal(platformOfUrl('https://music.163.com/playlist?id=3778678'), 'netease');
  assert.equal(platformOfUrl('https://music.163.com/#/playlist?id=3778678'), 'netease');
  assert.equal(platformOfUrl('https://music.163.com/playlist'), null);
});

test('platformOfUrl recognizes QQ path and share URLs', () => {
  assert.equal(platformOfUrl('https://y.qq.com/n/ryqq/playlist/7011264342'), 'qq');
  assert.equal(platformOfUrl('https://y.qq.com/playlist/7011264342'), 'qq');
  assert.equal(
    platformOfUrl('https://i.y.qq.com/n2/m/share/details/taoge.html?id=7011264342'),
    'qq',
  );
});

test('platformOfUrl rejects unknown hosts and non-playlist URLs', () => {
  assert.equal(platformOfUrl('https://example.com/playlist?id=1'), null);
  assert.equal(platformOfUrl('https://open.spotify.com/track/7bxaFZ1O3cHkgLKMsdC3xR'), null);
  assert.equal(platformOfUrl('not a url'), null);
  assert.equal(platformOfUrl(null), null);
});

test('resolveViaProxy returns the normalized worker payload', async () => {
  const fetchImpl = async (target) => {
    assert.ok(target.startsWith('https://proxy.example/resolve?url='));
    assert.ok(target.includes(encodeURIComponent('https://open.spotify.com/playlist/abc')));
    return jsonResponse({
      source: 'spotify',
      name: 'Today',
      items: [{ title: 'Loser', artist: 'Tame Impala', durationMs: 223069, coverUrl: 'https://i.scdn.co/x' }],
      truncated: true,
    });
  };

  const result = await resolveViaProxy({
    url: 'https://open.spotify.com/playlist/abc',
    proxyBase: 'https://proxy.example/',
    fetchImpl,
  });

  assert.deepEqual(result, {
    source: 'spotify',
    name: 'Today',
    items: [{ title: 'Loser', artist: 'Tame Impala', durationMs: 223069, coverUrl: 'https://i.scdn.co/x' }],
    truncated: true,
  });
});

test('resolveViaProxy requires a proxy base', async () => {
  await assert.rejects(
    resolveViaProxy({ url: 'https://music.163.com/playlist?id=1', proxyBase: '' }),
    /playlists\.error\.needProxy/,
  );
  await assert.rejects(
    resolveViaProxy({ url: 'https://music.163.com/playlist?id=1' }),
    /playlists\.error\.needProxy/,
  );
});

test('resolveViaProxy surfaces upstream status failures', async () => {
  await assert.rejects(
    resolveViaProxy({
      url: 'https://music.163.com/playlist?id=1',
      proxyBase: 'https://proxy.example',
      fetchImpl: async () => response(502),
    }),
    /playlists\.error\.proxyFailed/,
  );
});

test('resolveViaProxy rejects malformed payloads', async () => {
  const badItems = async () => jsonResponse({ source: 'netease', name: 'x', items: 'nope' });
  await assert.rejects(
    resolveViaProxy({
      url: 'https://music.163.com/playlist?id=1',
      proxyBase: 'https://proxy.example',
      fetchImpl: badItems,
    }),
    /playlists\.error\.proxyBadResponse/,
  );

  const brokenJson = async () => ({ status: 200, ok: true, json: async () => { throw new Error('boom'); } });
  await assert.rejects(
    resolveViaProxy({
      url: 'https://music.163.com/playlist?id=1',
      proxyBase: 'https://proxy.example',
      fetchImpl: brokenJson,
    }),
    /playlists\.error\.proxyBadResponse/,
  );
});

test('resolveViaProxy tolerates items missing optional fields', async () => {
  const result = await resolveViaProxy({
    url: 'https://y.qq.com/n/ryqq/playlist/1',
    proxyBase: 'https://proxy.example',
    fetchImpl: async () => jsonResponse({ name: 'x', items: [{ title: 'T' }] }),
  });
  assert.deepEqual(result.items, [{ title: 'T', artist: '', durationMs: 0, coverUrl: null }]);
  assert.equal(result.truncated, false);
  assert.equal(result.source, 'qq');
});
