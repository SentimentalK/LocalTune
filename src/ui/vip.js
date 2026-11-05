/**
 * VIP view: a placeholder header, the single persistent playlist view and the
 * playlist resolving settings card at the bottom. The playlists node is
 * created once by createPlaylistView and moved in here, so switching views
 * never rebuilds playlist state.
 */

import { t } from '../i18n/index.js';
import { el, icon } from './dom.js';

export function createVipView(playlistView, playlistSettings) {
  const head = el('div', { class: 'vip-head card', 'data-testid': 'vip-head' }, [
    el('div', { class: 'vip-crown' }, icon('crown')),
    el('div', {}, [
      el('h2', { text: t('vip.title') }),
      el('p', { class: 'muted', 'data-testid': 'vip-placeholder', text: t('vip.subtitle') }),
    ]),
  ]);
  const node = el('section', { class: 'vip-view', 'data-testid': 'vip-view' }, [
    head,
    playlistView.node,
    playlistSettings.node,
  ]);

  return {
    node,
    render(state) {
      playlistView.render(state);
      playlistSettings.render(state);
    },
  };
}
