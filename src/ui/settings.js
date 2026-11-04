/**
 * Full-screen settings view: library source, storage, language and about.
 * The node is built once per shell; `render(state)` only patches text, values
 * and disabled states so a 4 Hz playback update never rebuilds the cards.
 */

import { BUILD_VERSION } from '../core/version.js';
import { formatBytes } from '../core/storage.js';
import { t } from '../i18n/index.js';
import { el, icon, setHidden, setText } from './dom.js';

const LANGUAGES = [
  { value: 'auto', label: () => t('settings.language.auto') },
  { value: 'zh-CN', label: () => '简体中文' },
  { value: 'zh-TW', label: () => '繁體中文' },
  { value: 'ja', label: () => '日本語' },
  { value: 'en', label: () => 'English' },
];

function run(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function confirmed(message) {
  return typeof window === 'undefined' || window.confirm(message);
}

export function createSettingsView(store, sw) {
  const node = el('section', { class: 'settings-view' });

  const backButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'settings-back',
      'aria-label': t('settings.back'),
      onclick: () => {
        node.dispatchEvent(new CustomEvent('settings-back', { bubbles: true }));
      },
    },
    [el('span', { class: 'back-arrow', 'aria-hidden': 'true', text: '←' })],
  );
  const title = el('h2', { text: t('settings.title') });
  const head = el('div', { class: 'settings-head' }, [backButton, title]);

  const toast = (text) => {
    node.dispatchEvent(new CustomEvent('toast', { bubbles: true, detail: { text } }));
  };

  // ---- library ----
  const sourceName = el('b', { text: t('common.disconnected') });
  const sourceCount = el('span', { text: t('common.trackCount', { count: 0 }) });
  const sourceChip = el('span', { class: 'chip', text: t('settings.source.permissionNone') });

  const rescanButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-rescan',
    text: t('settings.rescan'),
    onclick: () => run(store.rescan()),
  });
  const changeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-source-change',
    text: t('settings.source.change'),
    onclick: () => run(store.connectSource()),
  });
  const removeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-source-remove',
    text: t('settings.source.remove'),
    onclick: () => {
      if (!confirmed(t('settings.source.removeConfirm'))) return;
      run(store.removeSource());
    },
  });

  const sourceRow = el('div', { class: 'source-row' }, [
    el('span', { class: 'source-icon', 'aria-hidden': 'true' }, [icon('folder')]),
    el('span', { class: 'source-body' }, [sourceName, sourceCount]),
    sourceChip,
    el('div', { class: 'source-actions' }, [rescanButton, changeButton, removeButton]),
  ]);

  const progressBar = el('i');
  const progressLabel = el('span');
  const progress = el('div', { class: 'settings-progress', role: 'status' }, [
    progressLabel,
    el('div', { class: 'bar' }, progressBar),
  ]);
  setHidden(progress, true);

  const migrationError = el('p', { class: 'settings-error muted', role: 'alert' });
  setHidden(migrationError, true);

  const localButton = el('button', {
    class: 'btn-pill ghost source-choice',
    type: 'button',
    'data-testid': 'settings-source-local',
    text: t('settings.source.localFolder'),
    onclick: () => run(store.connectSource()),
  });
  const oneDriveButton = el(
    'button',
    {
      class: 'btn-pill ghost source-choice',
      type: 'button',
      'data-testid': 'settings-source-onedrive',
      disabled: true,
    },
    [
      el('span', { text: t('settings.source.onedrive') }),
      el('span', { class: 'source-soon', text: t('settings.source.onedriveSoon') }),
    ],
  );
  const sourceChoices = el('div', { class: 'source-choices' }, [localButton, oneDriveButton]);
  setHidden(sourceChoices, true);

  const addSourceButton = el(
    'button',
    {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'settings-source-add',
      'aria-expanded': 'false',
      text: t('settings.source.add'),
      onclick: () => {
        const next = sourceChoices.hidden;
        setHidden(sourceChoices, !next);
        addSourceButton.setAttribute('aria-expanded', String(next));
      },
    },
  );
  const rescanTagsButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-rescan-tags',
    text: t('settings.rescanTags'),
    onclick: () => run(store.rescanTags()),
  });

  const libraryCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-library' },
    [
      el('h3', { text: t('settings.library.title') }),
      sourceRow,
      progress,
      migrationError,
      el('div', { class: 'settings-actions' }, [
        addSourceButton,
        sourceChoices,
        rescanTagsButton,
      ]),
    ],
  );

  // ---- storage ----
  function storageRow(testid, label) {
    const value = el('b', { text: formatBytes(0) });
    const row = el('div', { class: 'storage-row', 'data-testid': testid }, [
      el('span', { text: label }),
      value,
    ]);
    return { row, value };
  }

  const indexRow = storageRow('storage-index', t('settings.storage.index'));
  const coverRow = storageRow('storage-cover', t('settings.storage.cover'));
  const audioRow = storageRow('storage-audio', t('settings.storage.audio'));
  const usageLine = el('p', { class: 'storage-usage muted' });
  setHidden(usageLine, true);

  const clearCacheButton = el(
    'button',
    {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'clear-cache',
    },
    t('settings.storage.clearCache'),
  );
  const clearLibraryButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'clear-library',
    text: t('settings.storage.clearLibrary'),
  });

  const storageCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-storage' },
    [
      el('h3', { text: t('settings.storage.title') }),
      el('div', { class: 'storage-rows' }, [indexRow.row, coverRow.row, audioRow.row]),
      usageLine,
      el('div', { class: 'settings-actions' }, [clearCacheButton, clearLibraryButton]),
    ],
  );

  // ---- language ----
  const languageButtons = LANGUAGES.map(({ value, label }) => {
    const button = el('button', {
      type: 'button',
      class: 'segment',
      'data-testid': `language-${value}`,
      'aria-pressed': 'false',
      text: label(),
      onclick: () => store.setSetting('language', value),
    });
    return { value, button };
  });

  const languageCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-language' },
    [
      el('h3', { text: t('settings.language.title') }),
      el(
        'div',
        {
          class: 'segmented',
          role: 'group',
          'aria-label': t('settings.language.title'),
        },
        languageButtons.map(({ button }) => button),
      ),
    ],
  );

  // ---- about ----
  const version = el('b', { 'data-testid': 'about-version', text: BUILD_VERSION });
  const updateState = el('span', { class: 'about-state', text: t('settings.about.upToDate') });
  const checkButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'check-update',
    text: t('settings.about.check'),
  });
  const applyButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'settings-update-apply',
    text: t('settings.about.updateNow'),
    onclick: () => sw?.applyUpdate?.(),
  });
  setHidden(applyButton, true);

  let checking = false;
  checkButton.addEventListener('click', async () => {
    if (checking) return;
    checking = true;
    checkButton.disabled = true;
    setText(checkButton, t('settings.about.checking'));
    try {
      const waiting = await sw?.checkForUpdate?.();
      if (waiting) store.setUpdateReady(true);
    } catch {
      // Offline or no registration: the current state stays as it was.
    } finally {
      checking = false;
      checkButton.disabled = false;
      setText(checkButton, t('settings.about.check'));
    }
  });

  const reloadButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-reload',
    text: t('settings.about.reload'),
    onclick: () => {
      if (typeof location !== 'undefined') location.reload();
    },
  });

  const aboutCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-about' },
    [
      el('h3', { text: t('settings.about.title') }),
      el('div', { class: 'about-row' }, [
        el('span', { text: t('settings.about.version') }),
        version,
      ]),
      el('div', { class: 'about-row' }, [
        el('span', { text: t('settings.about.updateState') }),
        updateState,
      ]),
      el('div', { class: 'settings-actions' }, [checkButton, applyButton, reloadButton]),
    ],
  );

  node.append(head, libraryCard, storageCard, languageCard, aboutCard);

  // Storage figures are async and can be expensive on a large cache: throttle
  // to one leading call plus at most one trailing refresh per second.
  let lastEstimateAt = 0;
  let estimateTimer = null;
  let estimateToken = 0;
  let clearingCache = false;
  let clearingLibrary = false;

  async function refreshStorage() {
    lastEstimateAt = Date.now();
    const token = (estimateToken += 1);
    try {
      const estimate = await store.storageEstimate();
      if (token !== estimateToken) return;
      setText(indexRow.value, formatBytes(estimate.indexBytes));
      setText(coverRow.value, formatBytes(estimate.coverBytes));
      setText(audioRow.value, formatBytes(estimate.audioBytes));
      const hasUsage = Number.isFinite(estimate.usage) && Number.isFinite(estimate.quota);
      setHidden(usageLine, !hasUsage);
      if (hasUsage) {
        setText(
          usageLine,
          t('settings.storage.usage', {
            used: formatBytes(estimate.usage),
            quota: formatBytes(estimate.quota),
          }),
        );
      }
    } catch {
      // Storage figures are advisory; a failure leaves the last values.
    }
  }

  function scheduleStorage() {
    const wait = 1000 - (Date.now() - lastEstimateAt);
    if (wait > 0) {
      if (estimateTimer === null) {
        estimateTimer = setTimeout(() => {
          estimateTimer = null;
          void refreshStorage();
        }, wait);
      }
      return;
    }
    void refreshStorage();
  }

  clearCacheButton.addEventListener('click', async () => {
    if (clearingCache) return;
    clearingCache = true;
    clearCacheButton.disabled = true;
    try {
      const size = await store.clearAudioCache();
      toast(t('settings.storage.cacheCleared', { size: formatBytes(size) }));
      await refreshStorage();
    } catch {
      // Nothing was removed; leave the last figures in place.
    } finally {
      clearingCache = false;
      clearCacheButton.disabled = false;
    }
  });

  clearLibraryButton.addEventListener('click', async () => {
    if (clearingLibrary) return;
    if (!confirmed(t('settings.storage.clearConfirm'))) return;
    clearingLibrary = true;
    clearLibraryButton.disabled = true;
    try {
      await store.clearLibrary();
      toast(t('settings.storage.libraryCleared'));
      await refreshStorage();
    } catch {
      // The store keeps whatever it managed to delete.
    } finally {
      clearingLibrary = false;
      clearLibraryButton.disabled = false;
    }
  });

  function render(state) {
    const { source, settings, migration } = state;
    const scanning = Boolean(source.scanning);

    setText(sourceName, source.name || t('settings.source.permissionNone'));
    setText(
      sourceCount,
      t('common.trackCount', { count: state.tracks.length }),
    );

    const permission = source.permission;
    const chipKey =
      permission === 'granted'
        ? 'settings.source.permissionGranted'
        : permission === 'prompt' || permission === 'denied'
          ? 'settings.source.permissionRequired'
          : 'settings.source.permissionNone';
    setText(sourceChip, t(chipKey));
    sourceChip.className = `chip is-${permission}`;

    rescanButton.disabled = scanning || permission === 'none';
    changeButton.disabled = scanning;
    removeButton.disabled = scanning || permission === 'none';
    rescanTagsButton.disabled = scanning || permission === 'none';
    localButton.disabled = scanning;

    setHidden(progress, !scanning);
    if (scanning) {
      const { done, total } = source.progress ?? { done: 0, total: 0 };
      setText(
        progressLabel,
        total > 0
          ? t('common.scanProgress', { done, total })
          : t('common.scanCount', { done }),
      );
      const ratio = total > 0 ? Math.min(done / total, 1) : 0.12;
      progressBar.style.width = `${Math.round(ratio * 100)}%`;
    }

    const migrationMessage = migration?.error;
    setHidden(migrationError, !migrationMessage);
    if (migrationMessage) {
      setText(
        migrationError,
        t('settings.library.migrationFailed', { message: migrationMessage }),
      );
    }

    for (const { value, button } of languageButtons) {
      const active = settings.language === value;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }

    setHidden(applyButton, !state.updateReady);
    setText(
      updateState,
      state.updateReady ? t('settings.about.updateReady') : t('settings.about.upToDate'),
    );

    scheduleStorage();
  }

  return { node, render };
}
