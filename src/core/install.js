/**
 * PWA install state. The page never calls `prompt()` on its own; the store
 * exposes the state so the UI can decide whether to offer an install action.
 * Pure classification is separated from the event wiring for tests.
 */

const INSTALLED_MODES = new Set(['standalone', 'fullscreen', 'minimal-ui']);

export function classifyInstall({ displayMode = 'browser', canPrompt = false, installed = false } = {}) {
  if (installed || INSTALLED_MODES.has(displayMode)) return 'installed';
  return canPrompt ? 'installable' : 'browser';
}

function displayModeOf(win) {
  try {
    const query = win?.matchMedia;
    if (typeof query === 'function') {
      if (query('(display-mode: standalone)')?.matches) return 'standalone';
      if (query('(display-mode: fullscreen)')?.matches) return 'fullscreen';
      if (query('(display-mode: minimal-ui)')?.matches) return 'minimal-ui';
    }
  } catch {
    // matchMedia is optional.
  }
  if (win?.navigator?.standalone === true) return 'standalone';
  return 'browser';
}

export function initInstall({ window: win = globalThis.window } = {}) {
  let event = null;
  let installed = false;
  const listeners = new Set();

  const state = () => ({
    status: classifyInstall({
      displayMode: displayModeOf(win),
      canPrompt: Boolean(event),
      installed,
    }),
    canPrompt: Boolean(event),
  });

  const emit = () => {
    const snapshot = state();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must not block the rest.
      }
    }
  };

  const onBeforeInstallPrompt = (promptEvent) => {
    try {
      promptEvent.preventDefault?.();
    } catch {
      // Some browsers hand over a non-cancelable event.
    }
    event = promptEvent;
    emit();
  };

  const onAppInstalled = () => {
    installed = true;
    event = null;
    emit();
  };

  if (typeof win?.addEventListener === 'function') {
    win.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    win.addEventListener('appinstalled', onAppInstalled);
  }

  return {
    state,

    async prompt() {
      if (!event) return { outcome: 'unavailable' };
      const promptEvent = event;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        // Accepted is the only outcome that may claim "Installed": dismissed and
        // unavailable keep the environment-derived state. `appinstalled` still
        // fires later as the authoritative fallback.
        if (choice?.outcome === 'accepted') installed = true;
        return choice;
      } catch {
        return { outcome: 'unavailable' };
      } finally {
        event = null;
        emit();
      }
    },

    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    destroy() {
      listeners.clear();
      event = null;
      if (typeof win?.removeEventListener === 'function') {
        win.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        win.removeEventListener('appinstalled', onAppInstalled);
      }
    },
  };
}
