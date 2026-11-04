/**
 * navigator.mediaSession bridge. All functions are no-ops when the API is
 * missing (Node, unsupported browsers).
 */

const SEEK_STEP = 10;
const artworkCache = { trackId: null, url: null };

function getSession() {
  if (typeof navigator === 'undefined') return null;
  return navigator.mediaSession ?? null;
}

function artworkFor(track) {
  if (!track || !track.cover || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return [];
  }
  if (artworkCache.trackId === track.id && artworkCache.url) {
    return [{ src: artworkCache.url, type: track.cover.type || 'image/jpeg' }];
  }
  if (artworkCache.url) {
    URL.revokeObjectURL(artworkCache.url);
    artworkCache.url = null;
    artworkCache.trackId = null;
  }
  const url = URL.createObjectURL(track.cover);
  artworkCache.trackId = track.id;
  artworkCache.url = url;
  return [{ src: url, type: track.cover.type || 'image/jpeg' }];
}

function clearArtwork() {
  if (artworkCache.url) URL.revokeObjectURL(artworkCache.url);
  artworkCache.url = null;
  artworkCache.trackId = null;
}

export function installMediaSession(store) {
  const session = getSession();
  if (!session || typeof session.setActionHandler !== 'function') return;

  const handlers = {
    play: () => {
      store.log('mediasession', { action: 'play' });
      store.resume();
    },
    pause: () => {
      store.log('mediasession', { action: 'pause' });
      store.pause();
    },
    previoustrack: () => {
      store.log('mediasession', { action: 'previoustrack' });
      void store.prev('notification');
    },
    nexttrack: () => {
      store.log('mediasession', { action: 'nexttrack' });
      void store.next('notification');
    },
    seekto: (details) => {
      store.log('mediasession', { action: 'seekto', seekTime: details?.seekTime ?? null });
      if (typeof details?.seekTime === 'number') void store.seek(details.seekTime);
    },
    seekforward: (details) => {
      store.log('mediasession', {
        action: 'seekforward',
        offset: details?.seekOffset ?? SEEK_STEP,
      });
      const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : SEEK_STEP;
      void store.seek((store.state.current.position ?? 0) + offset);
    },
    seekbackward: (details) => {
      store.log('mediasession', {
        action: 'seekbackward',
        offset: details?.seekOffset ?? SEEK_STEP,
      });
      const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : SEEK_STEP;
      void store.seek((store.state.current.position ?? 0) - offset);
    },
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Action unsupported by this browser.
    }
  }
}

export function syncMediaSession(state) {
  const session = getSession();
  if (!session) return;

  const current = state?.current ?? {};
  const track = current.track ?? null;

  if (track && typeof MediaMetadata === 'function') {
    try {
      session.metadata = new MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: artworkFor(track),
      });
    } catch {
      // Metadata assignment is best-effort.
    }
  } else if (!track) {
    session.metadata = null;
    clearArtwork();
  }

  session.playbackState = current.playing ? 'playing' : track ? 'paused' : 'none';

  const duration = Number(current.duration) || 0;
  if (duration > 0 && typeof session.setPositionState === 'function') {
    const position = Math.min(Math.max(Number(current.position) || 0, 0), duration);
    try {
      session.setPositionState({ duration, playbackRate: 1, position });
    } catch {
      // Ignore transient position errors.
    }
  }
}
