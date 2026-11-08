/**
 * VIP view: the panel shell already draws the kicker and the "VIP" title, so
 * this view opens on the statement itself — better downloads are in progress.
 * It then says what LocalTune does with music (nothing but play what you have)
 * and points at Downtify, the external downloader, in a single card.
 */

import { t } from '../i18n/index.js';
import { el } from './dom.js';

const GITHUB_URL = 'https://github.com/henriquesebastiao/downtify';
const DOCS_URL = 'https://downtify.henriquesebastiao.com/';

export function createVipView() {
  const lead = el('div', { class: 'vip-lead' }, [
    el('h2', { 'data-testid': 'vip-lead', text: t('vip.subtitle') }),
    el('p', {
      class: 'vip-note muted',
      'data-testid': 'vip-note',
      text: t('vip.downtify.about'),
    }),
  ]);
  const card = el('section', { class: 'card vip-card', 'data-testid': 'vip-downtify' }, [
    el('h3', { text: t('vip.downtify.temporary') }),
    el('p', { class: 'muted', text: t('vip.downtify.independent') }),
    el('div', { class: 'vip-actions' }, [
      el('a', {
        class: 'btn-pill',
        href: GITHUB_URL,
        target: '_blank',
        rel: 'noreferrer noopener',
        'data-testid': 'vip-downtify-github',
        text: t('vip.downtify.github'),
      }),
      el('a', {
        class: 'btn-pill ghost',
        href: DOCS_URL,
        target: '_blank',
        rel: 'noreferrer noopener',
        'data-testid': 'vip-downtify-docs',
        text: t('vip.downtify.docs'),
      }),
    ]),
  ]);
  const node = el('section', { class: 'vip-view', 'data-testid': 'vip-view' }, [lead, card]);

  return {
    node,
    render() {},
  };
}
