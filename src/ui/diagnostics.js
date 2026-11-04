/**
 * Tag diagnostics dialog. The report is produced by the store (file access
 * stays behind its interface); this module only renders, copies and closes.
 */

import { t } from '../i18n/index.js';
import { el, setText } from './dom.js';

function selectContents(node) {
  if (typeof window === 'undefined') return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * @param {{title?: string}} track
 * @param {{loadReport: () => Promise<string>}} options
 */
export function openTagInfo(track, { loadReport }) {
  const pre = el('pre', { class: 'tag-report', text: t('diagnostics.loading') });
  const reportTitle = el('p', { class: 'tag-track', text: track?.title ?? '' });
  let closed = false;

  const copyButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    text: t('diagnostics.copy'),
    onclick: async () => {
      const text = pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        selectContents(pre);
      }
    },
  });
  const closeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    text: t('diagnostics.close'),
    onclick: () => close(),
  });

  const panel = el(
    'div',
    { class: 'modal-panel', role: 'document' },
    [
      el('header', { class: 'modal-head' }, [
        el('div', {}, [el('h2', { text: t('diagnostics.title') }), reportTitle]),
        closeButton,
      ]),
      pre,
      el('div', { class: 'modal-actions' }, [copyButton]),
    ],
  );

  const overlay = el(
    'div',
    {
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('diagnostics.title'),
      'data-testid': 'tag-info-modal',
    },
    panel,
  );

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.append(overlay);
  closeButton.focus?.();

  Promise.resolve()
    .then(() => loadReport())
    .then((report) => {
      if (!closed) setText(pre, String(report ?? ''));
    })
    .catch((error) => {
      if (closed) return;
      const message = error instanceof Error ? error.message : String(error ?? '');
      setText(pre, t('diagnostics.failed', { message }));
    });

  return { close };
}
