// QQ Music: the old qzone fcg endpoint. It requires a Referer header that a
// browser cannot set, and it reports failures with subcode 1 while code stays 0.

import { UpstreamChangedError, assertOk, safeFetch } from './shared.js';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
  referer: 'https://y.qq.com/',
};

export async function resolve(id, { fetchImpl = fetch } = {}) {
  const target =
    'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg' +
    `?type=1&json=1&utf8=1&disstid=${encodeURIComponent(id)}&format=json`;
  const response = await safeFetch(fetchImpl, target, { headers: HEADERS });
  assertOk(response);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new UpstreamChangedError();
  }

  // code 0 + subcode 0 is the only success; subcode 1 means "invalid referer".
  if (!body || body.code !== 0 || (body.subcode !== undefined && body.subcode !== 0)) {
    throw new UpstreamChangedError();
  }

  const entry = Array.isArray(body.cdlist) ? body.cdlist[0] : null;
  const songs = entry?.songlist;
  if (!Array.isArray(songs)) throw new UpstreamChangedError();

  const items = songs.map((song) => ({
    title: typeof song?.songname === 'string' ? song.songname : '',
    artist: Array.isArray(song?.singer)
      ? song.singer
          .map((singer) => (typeof singer === 'string' ? singer : singer?.name))
          .filter((name) => typeof name === 'string' && name !== '')
          .join(', ')
      : '',
    // QQ reports interval in seconds; normalize to milliseconds.
    durationMs: Number.isFinite(song?.interval) ? song.interval * 1000 : 0,
    coverUrl:
      typeof song?.albummid === 'string' && song.albummid !== ''
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
        : null,
  }));

  return {
    name: typeof entry?.dissname === 'string' ? entry.dissname : '',
    items,
    truncated: false,
  };
}
