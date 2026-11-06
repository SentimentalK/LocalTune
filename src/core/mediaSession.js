/**
 * navigator.mediaSession bridge. All functions are no-ops when the API is
 * missing (Node, unsupported browsers).
 */

const SEEK_STEP = 10;

function getSession() {
  if (typeof navigator === 'undefined') return null;
  return navigator.mediaSession ?? null;
}

/**
 * Artwork entries for one track. The store owns the object URL lifetime (and
 * the covers store owns the Blob), so this module only maps a resolved string.
 */
function artworkFor(track, url) {
  if (!track || typeof url !== 'string' || url === '') return [];
  return [{ src: url, type: track.coverType || 'image/jpeg' }];
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

export function syncMediaSession(state, artworkUrl = null) {
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
        artwork: artworkFor(track, artworkUrl),
      });
    } catch {
      // Metadata assignment is best-effort.
    }
  } else if (!track) {
    session.metadata = null;
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
