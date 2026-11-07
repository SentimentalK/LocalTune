// Service worker registration + update flow, consumed by the UI.
// onUpdateReady fires once when a new version has finished installing and the
// page is still controlled by the old one.

// sessionStorage key that keeps a misbehaving update from reloading forever.
export const RELOAD_FLAG = 'localtune:reloading';
// localStorage key holding the build version this browser last ran.
export const VERSION_KEY = 'localtune:version';
// sessionStorage markers that make the version self-heal fire at most once.
export const VERSION_RELOAD_FLAG = 'localtune:version-reload';
export const VERSION_SKIP_FLAG = 'localtune:version-skip';
// A page that loaded less than a minute ago is safe to reload for an update.
export const AUTO_ACTIVATE_WINDOW_MS = 60_000;
// `registration.update()` is cheap but not free: at most once per hour.
export const UPDATE_CHECK_INTERVAL_MS = 3_600_000;

/**
 * Pure update state machine (no DOM): the waiting worker only takes over when
 * the page asks it to, and the resulting controllerchange reloads once.
 * The flag is what distinguishes our own reload from a first-load claim.
 */
export function createUpdateFlow({ postSkipWaiting, reload, storage, beforeReload }) {
  let notified = false;

  return {
    notifyReady() {
      if (notified) return false;
      notified = true;
      return true;
    },

    apply() {
      if (storage.getItem(RELOAD_FLAG)) return false;
      storage.setItem(RELOAD_FLAG, '1');
      postSkipWaiting();
      return true;
    },

    controllerChanged() {
      if (!storage.getItem(RELOAD_FLAG)) return false;
      storage.removeItem(RELOAD_FLAG);
      try {
        beforeReload?.();
      } catch {
        // A failing marker must not block the reload itself.
      }
      reload();
      return true;
    },
  };
}

/**
 * Decide what a waiting worker should do right now. Pure so every branch can
 * be unit tested without a service worker or a document.
 */
export function decideUpdateAction({ waiting, playing, importing, hidden, ageMs }) {
  if (!waiting) return 'idle';
  if (playing || importing) return 'banner';
  return hidden || ageMs < AUTO_ACTIVATE_WINDOW_MS ? 'auto' : 'banner';
}

function readKey(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function writeKey(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // Private mode can reject writes; the app must boot anyway.
  }
}

function dropKey(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // Nothing to clean up then.
  }
}

/**
 * Boot-time navigation guard: consume `?reset=`, and heal a stale build with
 * one hard navigation to `?v=<version>`. Never loops: the version is written
 * before navigating and the session markers make the next load a no-op.
 */
export function prepareNavigation({
  version,
  location = globalThis.location,
  history = globalThis.history,
  storage = globalThis.localStorage,
  session = globalThis.sessionStorage,
  replace = (url) => location.replace(url),
} = {}) {
  const url = new URL(location.href);
  let reset = false;
  let healed = false;

  if (url.searchParams.has('reset')) {
    try {
      history.replaceState(null, '', url.pathname);
    } catch {
      // Address bar cosmetics only; never block boot.
    }
    reset = true;
  }

  const stored = readKey(storage, VERSION_KEY);
  if (stored === version) return { reset, healed };

  if (stored == null) {
    // First visit (or data was just cleared): remember, never navigate.
    writeKey(storage, VERSION_KEY, version);
    return { reset, healed };
  }

  if (readKey(session, VERSION_SKIP_FLAG) || readKey(session, VERSION_RELOAD_FLAG)) {
    // The reload was our own (SW update or earlier heal): this document is
    // already the new build, so only the stored version catches up.
    dropKey(session, VERSION_SKIP_FLAG);
    writeKey(storage, VERSION_KEY, version);
    return { reset, healed };
  }

  writeKey(session, VERSION_RELOAD_FLAG, '1');
  writeKey(storage, VERSION_KEY, version);
  replace(`${url.pathname}?v=${version}`);
  healed = true;
  return { reset, healed };
}

const NO_UPDATE = {
  applyUpdate: () => false,
  checkForUpdate: async () => false,
  evaluate: () => 'idle',
};

export function registerServiceWorker(onUpdateReady = () => {}, options = {}) {
  if (!('serviceWorker' in navigator)) return NO_UPDATE;

  const isBusy = options.isBusy ?? (() => ({}));
  const now = options.now ?? (() => Date.now());
  const doc = options.doc ?? document;
  const loadedAt = now();
  let lastCheck = 0;
  let registration = null;

  const flow = createUpdateFlow({
    // SKIP_WAITING goes to the waiting worker: the controller is the old one.
    postSkipWaiting: () => registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }),
    reload: () => location.reload(),
    storage: sessionStorage,
    // Read by prepareNavigation on the fresh document: no second navigation.
    beforeReload: () => sessionStorage.setItem(VERSION_SKIP_FLAG, '1'),
  });

  const evaluate = () => {
    if (!registration?.waiting || !navigator.serviceWorker.controller) return 'idle';
    const busy = isBusy() ?? {};
    const action = decideUpdateAction({
      waiting: true,
      playing: Boolean(busy.playing),
      importing: Boolean(busy.importing),
      hidden: doc.visibilityState === 'hidden',
      ageMs: now() - loadedAt,
    });
    if (action === 'auto') {
      flow.apply();
      return action;
    }
    if (flow.notifyReady()) onUpdateReady();
    return action;
  };

  const maybeUpdate = () => {
    if (now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = now();
    registration?.update?.()?.catch?.(() => undefined);
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'update-ready') evaluate();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    flow.controllerChanged();
  });

  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((value) => {
      registration = value;
      maybeUpdate();
      evaluate();

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) evaluate();
        });
      });
    })
    .catch((error) => {
      console.warn('service worker registration failed', error);
    });

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') evaluate();
    else maybeUpdate();
  });

  window.addEventListener('focus', () => maybeUpdate());

  return {
    // Without a waiting worker there is nothing to activate, and the page must
    // not reload: that is the loop the update banner used to fall into.
    applyUpdate: () => (registration?.waiting ? flow.apply() : false),
    checkForUpdate: async () => {
      await registration?.update();
      evaluate();
      return Boolean(registration?.waiting);
    },
    evaluate,
  };
}
