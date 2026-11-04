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
  const sourceViews = new Map();

  function createSourceRow(kind) {
    const name = el('b', { text: t('common.disconnected') });
    const count = el('span', { text: t('settings.source.trackCount', { count: 0 }) });
    const chip = el('span', { class: 'chip', text: t('settings.source.permissionNone') });
    const rowError = el('p', { class: 'settings-error muted', role: 'alert' });
    setHidden(rowError, true);

    const view = { name, count, chip, error: rowError, syncing: false };

    view.syncButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': `settings-sync-${kind}`,
      text: t('settings.source.sync'),
      onclick: async () => {
        if (view.syncing) return;
        view.syncing = true;
        view.syncButton.disabled = true;
        setText(view.syncButton, t('settings.source.syncing'));
        try {
          const result = await store.syncSource(kind);
          if (result) {
            toast(
              t('settings.source.syncResult', {
                added: result.added,
                removed: result.removed,
              }),
            );
          }
        } finally {
          view.syncing = false;
          view.syncButton.disabled = false;
          setText(view.syncButton, t('settings.source.sync'));
        }
      },
    });

    view.changeButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': kind === 'local' ? 'settings-source-change' : 'settings-onedrive-change',
      text: t('settings.source.change'),
      onclick: () => run(kind === 'local' ? store.connectSource() : store.browseOneDrive('')),
    });

    view.removeButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': kind === 'local' ? 'settings-source-remove' : 'settings-onedrive-remove',
      text: t('settings.source.remove'),
      onclick: () => {
        if (!confirmed(t('settings.source.removeConfirm'))) return;
        run(store.removeSource(kind));
      },
    });

    view.node = el('div', { class: 'source-row', 'data-testid': `source-row-${kind}` }, [
      el('span', { class: 'source-icon', 'aria-hidden': 'true' }, [icon('folder')]),
      el('span', { class: 'source-body' }, [name, count]),
      chip,
      el('div', { class: 'source-actions' }, [
        view.syncButton,
        view.changeButton,
        view.removeButton,
      ]),
      rowError,
    ]);

    sourceViews.set(kind, view);
    return view.node;
  }

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

  let oneDriveAction = () => run(store.connectOneDrive());
  const oneDriveButton = el('button', {
    class: 'btn-pill ghost source-choice',
    type: 'button',
    'data-testid': 'settings-source-onedrive',
    text: t('settings.source.onedrive'),
    onclick: () => oneDriveAction(),
  });

  const sourceChoices = el('div', { class: 'source-choices' }, [localButton, oneDriveButton]);
  setHidden(sourceChoices, true);

  const addSourceButton = el('button', {
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
  });
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
      createSourceRow('local'),
      createSourceRow('onedrive'),
      progress,
      migrationError,
      el('div', { class: 'settings-actions' }, [
        addSourceButton,
        sourceChoices,
        rescanTagsButton,
      ]),
    ],
  );

  // ---- OneDrive folder picker ----
  const pickerCard = el('section', {
    class: 'card settings-card onedrive-picker',
    'data-testid': 'onedrive-picker',
  });
  setHidden(pickerCard, true);
  let pickerSignature = null;

  function parentPath(path) {
    const segments = String(path ?? '').split('/').filter(Boolean);
    segments.pop();
    return segments.join('/');
  }

  function renderPicker(state) {
    const picker = state.onedrivePicker ?? { open: false };
    setHidden(pickerCard, !picker.open);
    if (!picker.open) {
      pickerSignature = null;
      return;
    }

    const path = picker.path ?? '';
    const items = picker.items ?? [];
    const signature = JSON.stringify({
      path,
      loading: Boolean(picker.loading),
      ids: items.map((item) => item.id),
    });
    if (signature === pickerSignature) return;
    pickerSignature = signature;

    const crumbs = [el('span', { class: 'picker-crumb', text: t('settings.onedrive.root') })];
    for (const segment of path.split('/').filter(Boolean)) {
      crumbs.push(el('span', { class: 'picker-crumb', text: segment }));
    }

    const children = [
      el('h3', { text: t('settings.onedrive.title') }),
      el('div', { class: 'picker-crumbs' }, crumbs),
    ];

    if (picker.loading) {
      children.push(el('p', { class: 'muted', text: t('settings.onedrive.loading') }));
    } else if (!items.length) {
      children.push(el('p', { class: 'muted', text: t('settings.onedrive.empty') }));
    } else {
      children.push(
        el(
          'ul',
          { class: 'picker-list' },
          items.map((item) =>
            el('li', {}, [
              el('button', {
                class: 'picker-folder',
                type: 'button',
                'data-testid': 'onedrive-folder',
                text: item.name,
                onclick: () => run(store.browseOneDrive(item.path)),
              }),
            ]),
          ),
        ),
      );
    }

    const current = picker.current ?? null;
    const upButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'onedrive-picker-up',
      text: t('settings.onedrive.up'),
      disabled: !path,
      onclick: () => run(store.browseOneDrive(parentPath(path))),
    });
    const chooseButton = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': 'onedrive-picker-choose',
      text: t('settings.onedrive.choose'),
      disabled: !path || !current,
      onclick: () => {
        if (!current) return;
        run(
          store.chooseOneDriveRoot({ id: current.id, path: current.path, name: current.name }),
        );
      },
    });
    const cancelButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'onedrive-picker-cancel',
      text: t('settings.onedrive.cancel'),
      onclick: () => store.closeOneDrivePicker(),
    });

    children.push(el('div', { class: 'settings-actions' }, [upButton, chooseButton, cancelButton]));
    pickerCard.replaceChildren(...children);
  }

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

  node.append(head, libraryCard, pickerCard, storageCard, languageCard, aboutCard);

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
    const { settings, migration } = state;
    const rows = state.sources ?? [];
    const scanningRow = rows.find((row) => row.scanning) ?? null;
    const anyScanning = Boolean(scanningRow);
    const anyGranted = rows.some((row) => row.permission === 'granted');

    for (const [kind, view] of sourceViews) {
      const row = rows.find((item) => item.id === kind) ?? {
        permission: 'none',
        name: '',
        trackCount: 0,
        scanning: false,
        progress: { done: 0, total: 0 },
        error: null,
      };
      setText(view.name, row.name || t('settings.source.permissionNone'));
      setText(view.count, t('settings.source.trackCount', { count: row.trackCount ?? 0 }));

      const permission = row.permission;
      const chipKey =
        permission === 'granted'
          ? 'settings.source.permissionGranted'
          : permission === 'prompt' || permission === 'denied'
            ? 'settings.source.permissionRequired'
            : 'settings.source.permissionNone';
      setText(view.chip, t(chipKey));
      view.chip.className = `chip is-${permission}`;

      const scanning = Boolean(row.scanning);
      view.syncButton.disabled = view.syncing || scanning || permission === 'none';
      if (!view.syncing) setText(view.syncButton, t('settings.source.sync'));
      view.changeButton.disabled = scanning;
      view.removeButton.disabled = scanning || permission === 'none';

      setHidden(view.error, !row.error);
      if (row.error) setText(view.error, row.error);
    }

    const onedrive = rows.find((row) => row.id === 'onedrive') ?? {
      permission: 'none',
      connected: false,
      root: null,
    };
    if (onedrive.permission === 'prompt') {
      oneDriveAction = () => run(store.reauthenticateOneDrive());
      setText(oneDriveButton, t('settings.source.onedriveReauth'));
    } else if (onedrive.permission === 'granted' && onedrive.root) {
      oneDriveAction = () => run(store.browseOneDrive(''));
      setText(oneDriveButton, t('settings.source.onedriveChange'));
    } else if (onedrive.connected || onedrive.permission === 'granted') {
      oneDriveAction = () => run(store.browseOneDrive(''));
      setText(oneDriveButton, t('settings.source.onedrivePick'));
    } else {
      oneDriveAction = () => run(store.connectOneDrive());
      setText(oneDriveButton, t('settings.source.onedriveSignIn'));
    }

    rescanTagsButton.disabled = anyScanning || !anyGranted;
    localButton.disabled = anyScanning;

    setHidden(progress, !anyScanning);
    if (scanningRow) {
      const { done, total } = scanningRow.progress ?? { done: 0, total: 0 };
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

    renderPicker(state);

    if (state.view === 'settings') scheduleStorage();
  }

  return { node, render };
}
