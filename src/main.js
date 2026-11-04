// Placeholder entry point: proves the build, SW and e2e wiring end to end.
// The UI worker replaces this file (and src/ui/) with the real app.

import { registerServiceWorker } from './pwa.js';

const root = document.getElementById('app');
root.innerHTML = '<h1>LocalTune</h1><p id="status">准备就绪</p>';

registerServiceWorker(() => {
  const status = document.getElementById('status');
  if (status) status.textContent = '有新版本，刷新';
});
