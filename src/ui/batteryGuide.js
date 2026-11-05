/**
 * Background playback guide dialog. Two platform sections, coloured by how
 * mandatory each step is: must (red), should (amber), note (plain).
 * Battery optimisation is not readable from the web on Android or iOS
 * (docs/research/pwa-background-battery.md), so the copy never claims it is set.
 */

import { el, setHidden } from './dom.js';
import { t } from '../i18n/index.js';

/** Single source of truth for the guide copy; the unit test walks this table. */
export const GUIDE_SECTIONS = {
  android: {
    must: ['battery.android.must1', 'battery.android.must2'],
    should: ['battery.android.should1', 'battery.android.should2'],
    note: ['battery.android.note1', 'battery.android.note2'],
  },
  ios: {
    must: ['battery.ios.must1', 'battery.ios.must2'],
    should: ['battery.ios.should1', 'battery.ios.should2'],
    note: ['battery.ios.note1', 'battery.ios.note2'],
  },
};

/** Title, intro and close label; also walked by the unit test. */
export const GUIDE_DIALOG_KEYS = ['battery.dialog.title', 'battery.dialog.intro', 'battery.dialog.close'];

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function section(platform) {
  const groups = GUIDE_SECTIONS[platform];
  const list = (tag, keys, className) =>
    el(tag, { class: 'guide-list' }, keys.map((key) => el('li', { class: className, text: t(key) })));
  return el('div', { class: 'guide-section', 'data-testid': `battery-dialog-${platform}` }, [
    el('h3', { class: 'guide-section-title', text: platform === 'ios' ? 'iOS' : 'Android' }),
    list('ol', groups.must, 'guide-must'),
    list('ul', groups.should, 'guide-should'),
    list('ul', groups.note, 'guide-note'),
  ]);
}

/**
 * Built once per settings view. `open(platform, trigger)` shows the matching
 * section; closing returns focus to `trigger`.
 */
export function createBatteryGuide({ document: doc = globalThis.document } = {}) {
  const title = el('h2', {
    id: 'battery-dialog-title',
    class: 'guide-title',
    tabindex: '-1',
    'data-testid': 'battery-dialog-title',
    text: t('battery.dialog.title'),
  });
  const closeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'battery-dialog-close',
    text: t('battery.dialog.close'),
  });
  const sections = { android: section('android'), ios: section('ios') };
  const panel = el('div', { class: 'modal-panel battery-guide-panel' }, [
    el('header', { class: 'modal-head' }, [title, closeButton]),
    el('p', { class: 'muted', 'data-testid': 'battery-dialog-intro', text: t('battery.dialog.intro') }),
    sections.android,
    sections.ios,
  ]);
  const node = el('div', {
    class: 'modal battery-guide',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'battery-dialog-title',
    'data-testid': 'battery-dialog',
    hidden: true,
  }, panel);

  let trigger = null;
  let previousOverflow = '';
  let open = false;

  function onKeydown(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll(FOCUSABLE)].filter(
      (item) => !item.hasAttribute('hidden') && item.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openGuide(platform, nextTrigger) {
    if (open) return;
    const target = GUIDE_SECTIONS[platform] ? platform : 'android';
    setHidden(sections.android, target !== 'android');
    setHidden(sections.ios, target !== 'ios');
    trigger = nextTrigger ?? null;
    if (!node.isConnected) doc.body.append(node);
    previousOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';
    setHidden(node, false);
    open = true;
    doc.addEventListener('keydown', onKeydown);
    title.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    setHidden(node, true);
    doc.removeEventListener('keydown', onKeydown);
    doc.body.style.overflow = previousOverflow;
    if (trigger && trigger.isConnected !== false && typeof trigger.focus === 'function') trigger.focus();
  }

  node.addEventListener('click', (event) => {
    if (event.target === node) close();
  });
  closeButton.addEventListener('click', close);

  return { node, open: openGuide, close };
}
