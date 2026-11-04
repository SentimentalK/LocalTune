// Spotify: the embed page embeds a __NEXT_DATA__ JSON payload with the full
// track list (title / subtitle / duration in ms). Fields are Next.js internals
// and may change without notice.

import { UpstreamChangedError, assertOk, safeFetch } from './shared.js';

const NEXT_DATA = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;

function splitArtists(subtitle) {
  if (typeof subtitle !== 'string') return '';
  return subtitle
    .split(',')
    .map((part) => part.replace(/[\u00a0\u2007\u202f]/g, ' ').trim())
    .filter((part) => part !== '')
    .join(', ');
}

export async function resolve(id, { fetchImpl = fetch } = {}) {
  const target = `https://open.spotify.com/embed/playlist/${encodeURIComponent(id)}`;
  const response = await safeFetch(fetchImpl, target);
  assertOk(response);

  const html = await response.text();
  const match = NEXT_DATA.exec(html);
  if (!match) throw new UpstreamChangedError();

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    throw new UpstreamChangedError();
  }

  const entity = payload?.props?.pageProps?.state?.data?.entity;
  const trackList = entity?.trackList;
  if (!Array.isArray(trackList)) throw new UpstreamChangedError();

  const coverUrl =
    typeof entity?.coverArt?.sources?.[0]?.url === 'string'
      ? entity.coverArt.sources[0].url
      : null;

  const items = trackList.map((track) => {
    const trackCover = track?.coverArt?.sources?.[0]?.url;
    return {
      title: typeof track?.title === 'string' ? track.title : '',
      artist: splitArtists(track?.subtitle),
      durationMs: Number.isFinite(track?.duration) ? track.duration : 0,
      // audioPreview and any other playable URL is deliberately dropped.
      coverUrl: typeof trackCover === 'string' ? trackCover : coverUrl,
    };
  });

  return {
    name: typeof entity?.name === 'string' ? entity.name : '',
    items,
    // The embed payload has no total count; 100 is the observed hard cap.
    truncated: trackList.length >= 100,
  };
}
