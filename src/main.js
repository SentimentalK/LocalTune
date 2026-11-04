import { createApp } from './core/store.js';
import { mountUi } from './ui/app.js';
import { el } from './ui/dom.js';
import { registerServiceWorker } from './pwa.js';

const root = document.getElementById('app');

function renderFatal(error) {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  root.replaceChildren(
    el('div', { class: 'fatal' }, [
      el('h1', { text: 'LocalTune' }),
      el('p', { text: `应用无法启动：${message}` }),
      el('p', { class: 'muted', text: '请重新授权音乐文件夹，或刷新页面重试。' }),
      el('button', {
        class: 'btn-pill',
        type: 'button',
        text: '重新授权',
        onclick: () => location.reload(),
      }),
    ]),
  );
}

let store = null;
try {
  store = await createApp();
  const sw = registerServiceWorker(() => store?.setUpdateReady(true));
  mountUi(root, store, sw);
} catch (error) {
  console.error('LocalTune failed to start', error);
  renderFatal(error);
}
