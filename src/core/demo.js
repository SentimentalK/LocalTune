/**
 * Demo queue. The tracks live in `src/demo/` and are copied to `dist/demo/`
 * by the build. They are never indexed into the library, so they only appear
 * in the queue until the user plays or clears their own music.
 */

export const DEMO_TRACKS = [
  {
    id: 'demo:qingtian',
    path: 'demo/qingtian.mp3',
    title: '晴天',
    artist: 'Jay Chou',
    album: '叶惠美',
    year: 2003,
    trackNo: 1,
    duration: 303,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/qingtian.jpg',
    source: 'demo',
    demoUrl: './demo/qingtian.mp3',
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
    duration: 182,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/hachimitsu.jpg',
    source: 'demo',
    demoUrl: './demo/hachimitsu.mp3',
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
    duration: 259,
    mtime: 0,
    size: 0,
    cover: null,
    coverSrc: './demo/just-communication.jpg',
    source: 'demo',
    demoUrl: './demo/just-communication.mp3',
    externalIds: {},
  },
];

export const DEMO_BY_ID = new Map(DEMO_TRACKS.map((track) => [track.id, track]));

export const isDemoTrack = (track) => Boolean(track?.id?.startsWith('demo:'));
