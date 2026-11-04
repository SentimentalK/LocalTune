// Service worker registration + update flow, consumed by the UI.
// onUpdateReady fires once when a new version has finished installing and the
// page is still controlled by the old one.

// sessionStorage key that keeps a misbehaving update from reloading forever.
export const RELOAD_FLAG = 'localtune:reloading';

/**
 * Pure update state machine (no DOM): the waiting worker only takes over when
 * the page asks it to, and the resulting controllerchange reloads once.
 * The flag is what distinguishes our own reload from a first-load claim.
 */
export function createUpdateFlow({ postSkipWaiting, reload, storage }) {
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
      reload();
      return true;
    },
  };
}

const NO_UPDATE = { applyUpdate: () => false, checkForUpdate: async () => false };

export function registerServiceWorker(onUpdateReady = () => {}) {
  if (!('serviceWorker' in navigator)) return NO_UPDATE;

  let registration = null;
  const flow = createUpdateFlow({
    // SKIP_WAITING goes to the waiting worker: the controller is the old one.
    postSkipWaiting: () => registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }),
    reload: () => location.reload(),
    storage: sessionStorage,
  });

  const notify = () => {
    if (flow.notifyReady()) onUpdateReady();
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'update-ready') notify();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    flow.controllerChanged();
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((value) => {
      registration = value;
      if (registration.waiting && navigator.serviceWorker.controller) notify();

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) notify();
        });
      });
    })
    .catch((error) => {
      console.warn('service worker registration failed', error);
    });

  return {
    // Without a waiting worker there is nothing to activate, and the page must
    // not reload: that is the loop the update banner used to fall into.
    applyUpdate: () => (registration?.waiting ? flow.apply() : false),
    checkForUpdate: async () => {
      await registration?.update();
      return Boolean(registration?.waiting);
    },
  };
}
