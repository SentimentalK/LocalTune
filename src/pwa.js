// Service worker registration + update detection, consumed by the UI.
// onUpdateReady fires once when a new version has finished installing and the
// page is still controlled by the old one (a refresh is needed to pick it up).

export function registerServiceWorker(onUpdateReady = () => {}) {
  if (!('serviceWorker' in navigator)) return;

  let notified = false;
  const notify = () => {
    if (notified) return;
    notified = true;
    onUpdateReady();
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'update-ready') notify();
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((registration) => {
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
}
