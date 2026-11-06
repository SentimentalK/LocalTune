/**
 * VIP view: a placeholder header plus one card pointing at Downtify, the
 * external downloader. LocalTune only plays files the user already has, so the
 * view explains the split instead of capturing music itself.
 */

import { t } from '../i18n/index.js';
import { el, icon } from './dom.js';

const GITHUB_URL = 'https://github.com/henriquesebastiao/downtify';
const DOCS_URL = 'https://downtify.henriquesebastiao.com/';

export function createVipView() {
  const head = el('div', { class: 'vip-head card', 'data-testid': 'vip-head' }, [
    el('div', { class: 'vip-crown' }, icon('crown')),
    el('div', {}, [
      el('h2', { text: t('vip.title') }),
      el('p', { class: 'muted', 'data-testid': 'vip-placeholder', text: t('vip.subtitle') }),
      el('p', { class: 'muted', 'data-testid': 'vip-temporary', text: t('vip.downtify.temporary') }),
    ]),
  ]);
  const card = el('section', { class: 'card vip-card', 'data-testid': 'vip-downtify' }, [
    el('h3', { text: t('vip.downtify.title') }),
    el('p', { text: t('vip.downtify.about') }),
    el('p', { text: t('vip.downtify.intro') }),
    el('p', { class: 'muted', text: t('vip.downtify.independent') }),
    el('p', { class: 'muted', text: t('vip.downtify.hint') }),
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
  const node = el('section', { class: 'vip-view', 'data-testid': 'vip-view' }, [head, card]);

  return {
    node,
    render() {},
  };
}
