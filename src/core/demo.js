/**
 * Demo queue. The tracks live in `src/demo/` and are copied to `dist/demo/`
 * by the build. They are never indexed into the library, so they only appear
 * in the queue until the user plays or clears their own music.
 */

export const DEMO_TRACKS = [
  {
    id: 'demo:baby-girl',
    path: 'demo/baby-girl.mp3',
    title: 'Baby Girl',
    artist: '方大同',
    album: 'Baby Girl',
    year: 0,
    trackNo: 1,
    duration: 273,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/baby-girl.jpg',
    source: 'demo',
    demoUrl: './demo/baby-girl.mp3',
    externalIds: {},
  },
  {
    id: 'demo:just-communication',
    path: 'demo/just-communication.mp3',
    title: 'JUST COMMUNICATION',
    artist: 'TWO-MIX',
    album: 'BPM 132',
    year: 1995,
    trackNo: 1,
    duration: 30,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/just-communication.jpg',
    source: 'demo',
    demoUrl: './demo/just-communication.mp3',
    externalIds: {},
  },
  {
    id: 'demo:hachimitsu',
    path: 'demo/hachimitsu.mp3',
    title: 'ハチミツ',
    artist: 'SPITZ',
    album: 'ハチミツ',
    year: 1995,
    trackNo: 1,
    duration: 30,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/hachimitsu.jpg',
    source: 'demo',
    demoUrl: './demo/hachimitsu.mp3',
    externalIds: {},
  },
  {
    id: 'demo:ziyou-de-ni',
    path: 'demo/ziyou-de-ni.mp3',
    title: '自由的你',
    artist: 'G.E.M.',
    album: '自由的你',
    year: 2026,
    trackNo: 1,
    duration: 30,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/ziyou-de-ni.jpg',
    source: 'demo',
    demoUrl: './demo/ziyou-de-ni.mp3',
    externalIds: {},
  },
];

export const DEMO_BY_ID = new Map(DEMO_TRACKS.map((track) => [track.id, track]));

export const isDemoTrack = (track) => Boolean(track?.id?.startsWith('demo:'));

/** The three 30 s demos fade over their last 1.5 s; Baby Girl plays whole. */
export const DEMO_FADE_SECONDS = 1.5;
const SHORT_DEMO_MAX_SECONDS = 31;

/**
 * Volume factor for a demo track at `position` of `duration`: 1 outside the
 * fade window, 0 at the very end. Only the 30 s demos fade; the full-length
 * Baby Girl and user tracks always return 1.
 */
export function demoEndFade(track, position, duration) {
  if (!isDemoTrack(track)) return 1;
  const total = Number(duration) > 0 ? Number(duration) : Number(track.duration) || 0;
  if (!(total > 0) || total > SHORT_DEMO_MAX_SECONDS) return 1;
  const remaining = total - Math.max(0, Number(position) || 0);
  if (!(remaining < DEMO_FADE_SECONDS)) return 1;
  return Math.max(remaining, 0) / DEMO_FADE_SECONDS;
}
