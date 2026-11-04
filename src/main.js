import { createApp } from './core/store.js';
import { mountUi } from './ui/app.js';
import { el } from './ui/dom.js';
import { registerServiceWorker } from './pwa.js';
import {
  applyDocumentLang,
  resolveLanguage,
  setLocale,
  t,
} from './i18n/index.js';

const root = document.getElementById('app');

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
  store = await createApp();
  setLocale(resolveLanguage(store.state.settings.language, navigator.languages));
  applyDocumentLang();
  const sw = registerServiceWorker(() => store?.setUpdateReady(true));
  mountUi(root, store, sw);
} catch (error) {
  console.error('LocalTune failed to start', error);
  renderFatal(error);
}
