/**
 * Playlist resolving settings: the YouTube API key and the proxy URL live at
 * the bottom of the VIP view, right under the playlists that use them. The
 * node is built once per shell; `render(state)` only refills the inputs the
 * user is not editing.
 */

import { DEFAULT_PROXY_URL } from '../core/playlist/sources/proxy.js';
import { t } from '../i18n/index.js';
import { el } from './dom.js';

const YOUTUBE_KEY_LIMIT = 200;
const PROXY_URL_LIMIT = 300;

export function createPlaylistSettings(store) {
  const node = el('section', {
    class: 'card settings-card vip-playlist-settings',
    'data-testid': 'vip-playlist-settings',
  });

  const toast = (text) => {
    node.dispatchEvent(new CustomEvent('toast', { bubbles: true, detail: { text } }));
  };

  const youtubeKeyInput = el('input', {
    id: 'setting-youtube-key',
    class: 'text-input',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-testid': 'setting-youtube-key',
  });
  const proxyUrlInput = el('input', {
    id: 'setting-proxy-url',
    class: 'text-input',
    type: 'url',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-testid': 'setting-proxy-url',
    placeholder: DEFAULT_PROXY_URL,
  });

  function field(input, labelKey, hintKey) {
    return el('div', { class: 'about-field' }, [
      el('label', { for: input.id, text: t(labelKey) }),
      input,
      el('p', { class: 'about-hint muted', text: t(hintKey) }),
    ]);
  }

  async function save(key, input, limit) {
    const expected = input.value.trim().slice(0, limit);
    await store.setSetting(key, expected);
    if (store.state.settings[key] === expected) toast(t('vip.saved'));
  }

  youtubeKeyInput.addEventListener('change', () => {
    save('youtubeApiKey', youtubeKeyInput, YOUTUBE_KEY_LIMIT).catch(() => {});
  });
  proxyUrlInput.addEventListener('change', () => {
    save('playlistProxyUrl', proxyUrlInput, PROXY_URL_LIMIT).catch(() => {});
  });

  node.append(
    el('h2', { class: 'settings-block-title', text: t('vip.playlistSettings') }),
    field(youtubeKeyInput, 'vip.youtubeKey', 'vip.youtubeKeyHint'),
    field(proxyUrlInput, 'vip.proxyUrl', 'vip.proxyUrlHint'),
  );

  return {
    node,
    render(state) {
      const settings = state.settings ?? {};
      for (const [input, value] of [
        [youtubeKeyInput, settings.youtubeApiKey ?? ''],
        [proxyUrlInput, settings.playlistProxyUrl ?? ''],
      ]) {
        if (document.activeElement !== input && input.value !== value) input.value = value;
      }
    },
  };
}
