// NetEase: the legacy /api/playlist/detail endpoint returns the whole track
// list in one response. It does not check Referer or UA, but a browser UA and
// Referer are sent anyway because they cost nothing.

import { UpstreamChangedError, assertOk, safeFetch } from './shared.js';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
  referer: 'https://music.163.com/',
};

function upgradeCover(url) {
  if (typeof url !== 'string' || url === '') return null;
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

export async function resolve(id, { fetchImpl = fetch } = {}) {
  const target = `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`;
  const response = await safeFetch(fetchImpl, target, { headers: HEADERS });
  assertOk(response);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new UpstreamChangedError();
  }

  if (body && body.code !== undefined && body.code !== 200) throw new UpstreamChangedError();

  const result = body?.result;
  if (!result || !Array.isArray(result.tracks)) throw new UpstreamChangedError();

  const items = result.tracks.map((track) => ({
    title: typeof track?.name === 'string' ? track.name : '',
    artist: Array.isArray(track?.artists)
      ? track.artists
          .map((artist) => (typeof artist === 'string' ? artist : artist?.name))
          .filter((name) => typeof name === 'string' && name !== '')
          .join(', ')
      : '',
    durationMs: Number.isFinite(track?.duration) ? track.duration : 0,
    coverUrl: upgradeCover(track?.album?.picUrl),
  }));

  return {
    name: typeof result.name === 'string' ? result.name : '',
    items,
    truncated: false,
  };
}
