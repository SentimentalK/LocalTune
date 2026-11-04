// YouTube playlist resolution through the public Data API v3.
// Requires a user-supplied API key: anonymous calls return 403 (see
// docs/research/playlist-sources.md). The browser can call the API directly
// because every response, including errors, carries CORS headers.

import { t } from '../../../i18n/index.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const PAGE_SIZE = 50;
const VIDEO_BATCH = 50;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

// (Official Video), [4K], (Lyrics...), (Visualizer), ... — removed from titles.
const TITLE_NOISE =
  /[([【]\s*(?:official[^)\]】]*|lyrics?[^)\]】]*|audio[^)\]】]*|m\/v|mv|visuali[sz]er|hd|hq|4k|8k)\s*[)\]】]/gi;

/** Playlist id from a youtube.com / youtu.be URL, or null. */
export function parseYouTubePlaylistId(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  if (text === '') return null;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const list = parsed.searchParams.get('list');
  if (typeof list !== 'string') return null;
  const id = list.trim();
  return id === '' ? null : id;
}

/**
 * 'Artist - Title (Official Video)' -> { artist: 'Artist', title: 'Title' }.
 * Everything after '|' is dropped; unknown artist is an empty string.
 */
export function parseYouTubeTitle(raw) {
  if (typeof raw !== 'string') return { artist: '', title: '' };

  const text = raw.split('|')[0].trim();
  const index = text.indexOf(' - ');
  const artist = index === -1 ? '' : text.slice(0, index).trim();
  const rest = index === -1 ? text : text.slice(index + 3);

  const title = rest
    .replace(TITLE_NOISE, ' ')
    .replace(/\(\s*\)|\[\s*\]|【\s*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { artist, title };
}

/** ISO 8601 duration from videos.list -> milliseconds, or null. */
export function parseIsoDuration(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = ISO_DURATION.exec(text);
  if (!match) return null;
  if (!text.includes('T')) return null;

  const [, days, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return null;

  const totalSeconds =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return totalSeconds * 1000;
}

function isOk(response) {
  const status = response?.status ?? 0;
  return status >= 200 && status < 300;
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!isOk(response)) {
    throw new Error(t('playlists.error.youtubeFailed', { status: response?.status ?? 0 }));
  }
  return response.json();
}

function thumbUrl(snippet) {
  return snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url ?? null;
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
}

/**
 * Resolves a YouTube playlist into normalized rows.
 * @returns {Promise<{source:'youtube', name:string, items:Array<{title:string,artist:string,durationMs:number,coverUrl:string|null}>, truncated:boolean}>}
 */
export async function resolveYouTubePlaylist({ url, apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(t('playlists.error.needApiKey'));
  }
  const key = apiKey.trim();

  const playlistId = parseYouTubePlaylistId(url);
  if (!playlistId) {
    throw new Error(t('playlists.error.unsupportedUrl'));
  }

  const playlistUrl = new URL(`${API_BASE}/playlists`);
  playlistUrl.searchParams.set('part', 'snippet');
  playlistUrl.searchParams.set('id', playlistId);
  playlistUrl.searchParams.set('maxResults', '1');
  playlistUrl.searchParams.set('key', key);
  const playlist = await getJson(fetchImpl, playlistUrl.toString());
  const name = playlist?.items?.[0]?.snippet?.title ?? '';

  const entries = [];
  let pageToken = '';
  do {
    const pageUrl = new URL(`${API_BASE}/playlistItems`);
    pageUrl.searchParams.set('part', 'snippet,contentDetails');
    pageUrl.searchParams.set('playlistId', playlistId);
    pageUrl.searchParams.set('maxResults', String(PAGE_SIZE));
    pageUrl.searchParams.set('key', key);
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);

    const page = await getJson(fetchImpl, pageUrl.toString());
    for (const item of page?.items ?? []) {
      const snippet = item?.snippet ?? {};
      const videoId = item?.contentDetails?.videoId ?? snippet?.resourceId?.videoId;
      if (typeof videoId !== 'string' || videoId === '') continue;
      entries.push({ videoId, snippet });
    }
    pageToken = typeof page?.nextPageToken === 'string' ? page.nextPageToken : '';
  } while (pageToken);

  const durations = new Map();
  const ids = entries.map((entry) => entry.videoId);
  for (const batch of chunk(ids, VIDEO_BATCH)) {
    const videosUrl = new URL(`${API_BASE}/videos`);
    videosUrl.searchParams.set('part', 'contentDetails');
    videosUrl.searchParams.set('id', batch.join(','));
    videosUrl.searchParams.set('key', key);
    const videos = await getJson(fetchImpl, videosUrl.toString());
    for (const video of videos?.items ?? []) {
      if (typeof video?.id !== 'string') continue;
      const durationMs = parseIsoDuration(video?.contentDetails?.duration);
      if (durationMs !== null) durations.set(video.id, durationMs);
    }
  }

  const items = entries.map(({ videoId, snippet }) => {
    const rawTitle = typeof snippet?.title === 'string' ? snippet.title : '';
    const parsed = parseYouTubeTitle(rawTitle);

    let artist = parsed.artist;
    if (artist === '') {
      const channel = typeof snippet?.videoOwnerChannelTitle === 'string'
        ? snippet.videoOwnerChannelTitle
        : '';
      artist = channel.replace(/\s*-\s*Topic\s*$/i, '').trim();
    }

    const title = parsed.title === '' ? rawTitle.trim() : parsed.title;

    return {
      title,
      artist,
      durationMs: durations.get(videoId) ?? 0,
      coverUrl: thumbUrl(snippet),
    };
  });

  return { source: 'youtube', name: String(name), items, truncated: false };
}
