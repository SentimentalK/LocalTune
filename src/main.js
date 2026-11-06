import { createApp } from './core/store.js';
import { mountUi } from './ui/app.js';
import { el } from './ui/dom.js';
import { registerServiceWorker } from './pwa.js';
import {
  applyDocumentLang,
  browserLanguages,
  ensureLocale,
  resolveLanguage,
  resolveLocale,
  setLocale,
  t,
} from './i18n/index.js';

const root = document.getElementById('app');

// First paint: show the brand and the loading line while createApp() hydrates
// the store. mountUi() replaces this tree once the app is ready.
root.replaceChildren(
  el('div', { class: 'app' }, [
    el('div', { class: 'main-col' }, [
      el('header', { class: 'topbar' }, [
        el('div', { class: 'brand-group' }, [
          el('div', { class: 'wordmark' }, ['localtune', el('span', { text: '.' })]),
          el('span', { class: 'status-sep', 'aria-hidden': 'true' }),
          el('span', { class: 'status', id: 'status', text: t('common.loading') }),
        ]),
      ]),
    ]),
  ]),
);

function renderFatal(error) {
  const message = error instanceof Error ? error.message : String(error ?? t('common.unknownError'));
  root.replaceChildren(
    el('div', { class: 'fatal' }, [
      el('h1', { text: 'LocalTune' }),
      el('p', { text: t('fatal.message', { message }) }),
      el('p', { class: 'muted', text: t('fatal.hint') }),
      el('button', {
        class: 'btn-pill',
        type: 'button',
        text: t('fatal.reauthorize'),
        onclick: () => location.reload(),
      }),
    ]),
  );
}

let store = null;
try {
  // createApp() turns OneDrive redirect failures into strings while it
  // restores state, before the saved setting is known. Load the browser
  // table first so those boot strings follow the browser (the pre-lazy-load
  // behaviour); the saved setting's own chunk loads right after.
  await ensureLocale(resolveLocale(browserLanguages()));
  store = await createApp();
  // Load the resolved locale chunk before the first real render; a failed
  // chunk falls back to English without touching the stored setting.
  const target = resolveLanguage(store.state.settings.language, browserLanguages());
  const loaded = await ensureLocale(target);
  setLocale(loaded);
  applyDocumentLang();
  const sw = registerServiceWorker(() => store?.setUpdateReady(true));
  mountUi(root, store, sw);
} catch (error) {
  console.error('LocalTune failed to start', error);
  renderFatal(error);
}
