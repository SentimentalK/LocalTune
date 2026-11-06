/**
 * Full local-data reset used by Settings → About → Clear all data.
 *
 * Pure module: every browser facility arrives as a parameter, so Node tests
 * can drive it with stubs and importing it never touches the DOM.
 */

import { DB_NAME } from './db.js';

export const RESET_STEPS = ['player','indexedDB','opfs','caches','serviceWorker','localStorage','sessionStorage'];

function deleteDatabase(idb, name, close) {
  return new Promise((resolve) => {
    try { close?.(); } catch {}
    let request;
    try { request = idb?.deleteDatabase?.(name); } catch { resolve('error'); return; }
    if (!request) { resolve('error'); return; }
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    request.onsuccess = () => done('deleted');
    request.onerror = () => done('error');
    request.onblocked = () => { try { close?.(); } catch {} done('blocked'); };
  });
}

export function createResetSteps({ store, indexedDB, caches, serviceWorker, storage, sessionStorage, opfs } = {}) {
  return [
    { name: 'player', run: () => { store?.player?.pause?.(); store?.player?.unload?.(); } },
    { name: 'indexedDB', run: () => deleteDatabase(indexedDB, DB_NAME, () => store?.db?.close?.()) },
    { name: 'opfs', run: async () => {
        const root = await opfs?.getDirectory?.();
        if (!root) return;
        try { await root.removeEntry('music', { recursive: true }); }
        catch (error) { if (error?.name !== 'NotFoundError') throw error; }
      } },
    { name: 'caches', run: async () => {
        const keys = (await caches?.keys?.()) ?? [];
        await Promise.all(keys.map((key) => caches.delete(key)));
      } },
    { name: 'serviceWorker', run: async () => {
        const regs = (await serviceWorker?.getRegistrations?.()) ?? [];
        await Promise.all(regs.map((reg) => reg.unregister()));
      } },
    { name: 'localStorage', run: () => storage?.clear?.() },
    { name: 'sessionStorage', run: () => sessionStorage?.clear?.() },
  ];
}

export async function runResetSteps(steps, { onError } = {}) {
  const failures = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { failures.push({ name: step.name, error }); onError?.(step.name, error); }
  }
  return failures;
}

export async function resetAllData(env = {}) {
  const failures = await runResetSteps(createResetSteps(env), {
    onError: (name, error) => console.warn(`reset step failed: ${name}`, error),
  });
  try { env.reload?.(); } catch {}
  return failures;
}
