/**
 * Full-screen settings view: library source, storage, language and about.
 * The node is built once per shell; `render(state)` only patches text, values
 * and disabled states so a 4 Hz playback update never rebuilds the cards.
 */

import { BUILD_VERSION } from '../core/version.js';
import { BATTERY_BRANDS, BATTERY_STEP_KEYS, batteryTarget } from '../core/battery.js';
import { formatBytes } from '../core/storage.js';
import { CACHE_LIMIT_VALUES } from '../core/persist.js';
import { DEFAULT_PROXY_URL } from '../core/playlist/sources/proxy.js';
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based copy.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
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
  let modeBusy = false;
  const localModeButtons = [
    { value: 'reference', key: 'settings.library.modeReference' },
    { value: 'import', key: 'settings.library.modeImport' },
  ].map(({ value, key }) =>
    el('button', {
      type: 'button',
      class: 'segment',
      'data-testid': `local-mode-${value}`,
      'aria-pressed': 'false',
      text: t(key),
      onclick: async () => {
        if (modeBusy) return;
        modeBusy = true;
        try {
          await store.setLocalMode(value);
          if (value === 'import') void store.connectSource();
        } finally {
          modeBusy = false;
        }
      },
    }),
  );

  const modeRow = el('div', { class: 'storage-limit' }, [
    el('span', { text: t('settings.library.modeTitle') }),
    el(
      'div',
      {
        class: 'segmented',
        role: 'group',
        'aria-label': t('settings.library.modeTitle'),
        'data-testid': 'local-mode',
      },
      localModeButtons,
    ),
  ]);

  const importProgress = el('p', {
    class: 'settings-progress muted',
    role: 'status',
    'data-testid': 'import-progress',
  });
  setHidden(importProgress, true);

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
      modeRow,
      createSourceRow('onedrive'),
      importProgress,
      progress,
      migrationError,
      el('div', { class: 'settings-actions' }, [
        addSourceButton,
        sourceChoices,
        rescanTagsButton,
      ]),
    ],
  );

  // ---- background playback ----
  const BRAND_LABELS = {
    samsung: 'settings.background.batteryBrandSamsung',
    xiaomi: 'settings.background.batteryBrandXiaomi',
    huawei: 'settings.background.batteryBrandHuawei',
    stock: 'settings.background.batteryBrandStock',
  };

  function openBatteryGuide() {
    const steps = el('ol', { class: 'tag-report', 'data-testid': 'battery-steps' });
    const userAgent = globalThis.navigator?.userAgent ?? '';
    let brand = batteryTarget({ userAgent });

    const tabButtons = BATTERY_BRANDS.map((value) =>
      el('button', {
        type: 'button',
        class: 'segment',
        'data-testid': `battery-brand-${value}`,
        'aria-pressed': 'false',
        text: t(BRAND_LABELS[value]),
        onclick: () => {
          brand = value;
          renderBrand();
        },
      }),
    );

    function renderBrand() {
      for (const button of tabButtons) {
        const value = button.getAttribute('data-testid').replace('battery-brand-', '');
        const active = value === brand;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('is-active', active);
      }
      steps.replaceChildren(
        ...(BATTERY_STEP_KEYS[brand] ?? []).map((key) => el('li', { text: t(key) })),
      );
    }

    function close() {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    const closeButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'battery-guide-close',
      text: t('diagnostics.close'),
      onclick: () => close(),
    });

    const panel = el('div', { class: 'modal-panel', role: 'document' }, [
      el('header', { class: 'modal-head' }, [
        el('div', {}, [
          el('h2', { text: t('settings.background.batteryGuideTitle') }),
          el('p', { class: 'tag-track', text: t('settings.background.batteryGuideHint') }),
        ]),
        closeButton,
      ]),
      el(
        'div',
        {
          class: 'segmented',
          role: 'group',
          'aria-label': t('settings.background.batteryGuideTitle'),
        },
        tabButtons,
      ),
      steps,
    ]);

    const overlay = el(
      'div',
      {
        class: 'modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('settings.background.batteryGuideTitle'),
        'data-testid': 'battery-guide',
      },
      panel,
    );

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    document.body.append(overlay);
    renderBrand();

    // The model arrives asynchronously; render the UA guess first, then switch
    // tabs only when the high-entropy model changes the answer.
    Promise.resolve()
      .then(() => globalThis.navigator?.userAgentData?.getHighEntropyValues?.(['model']))
      .then((values) => {
        const next = batteryTarget({ userAgent, model: values?.model ?? '' });
        if (next !== brand) {
          brand = next;
          renderBrand();
        }
      })
      .catch(() => {});
  }

  const installStatus = el('p', { class: 'muted', 'data-testid': 'install-status' });
  const installHint = el('p', {
    class: 'muted',
    text: t('settings.background.hint'),
  });
  const installButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'install-button',
    text: t('settings.background.install'),
    onclick: async () => {
      installButton.disabled = true;
      try {
        await store.install?.prompt();
      } finally {
        installButton.disabled = false;
      }
    },
  });
  setHidden(installButton, true);

  const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? '');
  const batteryButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'battery-button',
    text: t('settings.background.batteryOpen'),
    onclick: () => openBatteryGuide(),
  });
  const batteryDesktop = el('p', {
    class: 'muted',
    text: t('settings.background.batteryDesktop'),
  });
  setHidden(batteryButton, !isAndroid);
  setHidden(batteryDesktop, isAndroid);

  const backgroundCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-background' },
    [
      el('h3', { text: t('settings.background.title') }),
      installHint,
      installStatus,
      el('div', { class: 'settings-actions' }, [installButton]),
      batteryButton,
      batteryDesktop,
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
  const importValue = el('b', {
    text: `${formatBytes(0)} · ${t('settings.storage.importCount', { count: 0 })}`,
  });
  let clearingImport = false;
  const clearImportButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'storage-clear-import',
    text: t('settings.storage.clearImport'),
    onclick: async () => {
      if (clearingImport) return;
      if (!confirmed(t('settings.storage.clearImportConfirm'))) return;
      clearingImport = true;
      clearImportButton.disabled = true;
      try {
        await store.clearImported();
        toast(t('settings.storage.importCleared'));
        await refreshStorage();
      } finally {
        clearingImport = false;
        clearImportButton.disabled = false;
      }
    },
  });
  const importRow = el('div', { class: 'storage-row', 'data-testid': 'storage-import' }, [
    el('span', { text: t('settings.storage.imported') }),
    importValue,
    clearImportButton,
  ]);

  const pinnedLabel = el('span', { text: t('settings.storage.pinnedCount', { count: 0 }) });
  const pinnedRow = el('div', { class: 'storage-row', 'data-testid': 'storage-pins' }, [
    pinnedLabel,
  ]);
  const usageLine = el('p', { class: 'storage-usage muted' });
  setHidden(usageLine, true);

  const CACHE_LIMIT_LABELS = [
    'settings.storage.limit05',
    'settings.storage.limit1',
    'settings.storage.limit2',
    'settings.storage.limit5',
    'settings.storage.limitUnlimited',
  ];
  const cacheLimitButtons = CACHE_LIMIT_VALUES.map((value, index) => {
    const button = el('button', {
      type: 'button',
      class: 'segment',
      'data-testid': `cache-limit-${index}`,
      'aria-pressed': 'false',
      text: t(CACHE_LIMIT_LABELS[index] ?? 'settings.storage.limit'),
      onclick: () => run(store.setSetting('cacheLimitBytes', value)),
    });
    return { value, button };
  });
  const limitRow = el('div', { class: 'storage-limit' }, [
    el('span', { text: t('settings.storage.limit') }),
    el(
      'div',
      {
        class: 'segmented',
        role: 'group',
        'aria-label': t('settings.storage.limit'),
        'data-testid': 'cache-limit',
      },
      cacheLimitButtons.map(({ button }) => button),
    ),
  ]);

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
      limitRow,
      el('div', { class: 'storage-rows' }, [
        indexRow.row,
        coverRow.row,
        audioRow.row,
        importRow,
        pinnedRow,
      ]),
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

  async function saveAboutSetting(key, input, limit) {
    const expected = input.value.trim().slice(0, limit);
    await store.setSetting(key, expected);
    if (store.state.settings[key] === expected) toast(t('settings.about.saved'));
  }

  youtubeKeyInput.addEventListener('change', () => {
    run(saveAboutSetting('youtubeApiKey', youtubeKeyInput, 200));
  });
  proxyUrlInput.addEventListener('change', () => {
    run(saveAboutSetting('playlistProxyUrl', proxyUrlInput, 300));
  });

  function aboutField(input, labelKey, hintKey) {
    return el('div', { class: 'about-field' }, [
      el('label', { for: input.id, text: t(labelKey) }),
      input,
      el('p', { class: 'about-hint muted', text: t(hintKey) }),
    ]);
  }

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

  function openPlayLog() {
    const pre = el('pre', {
      class: 'tag-report',
      'data-testid': 'playlog-text',
      text: t('common.loading'),
    });

    function close() {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    const copyButton = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': 'playlog-copy',
      text: t('diagnostics.copy'),
      onclick: async () => {
        await copyText(pre.textContent ?? '');
        toast(t('settings.about.playLogCopied'));
      },
    });
    const clearButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlog-clear',
      text: t('settings.about.playLogClear'),
      onclick: async () => {
        await store.clearPlayLog();
        setText(pre, '');
      },
    });
    const closeButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlog-close',
      text: t('settings.about.playLogClose'),
      onclick: () => close(),
    });

    const panel = el('div', { class: 'modal-panel', role: 'document' }, [
      el('header', { class: 'modal-head' }, [
        el('h2', { text: t('settings.about.playLog') }),
        closeButton,
      ]),
      pre,
      el('div', { class: 'modal-actions' }, [copyButton, clearButton]),
    ]);

    const overlay = el(
      'div',
      {
        class: 'modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('settings.about.playLog'),
        'data-testid': 'playlog-panel',
      },
      panel,
    );

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    document.body.append(overlay);

    Promise.resolve()
      .then(() => store.playLogText())
      .then((text) => setText(pre, String(text ?? '')))
      .catch(() => setText(pre, ''));
  }

  const playLogButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'playlog-open',
    text: t('settings.about.playLog'),
    onclick: () => openPlayLog(),
  });

  const aboutCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-about' },
    [
      el('h3', { text: t('settings.about.title') }),
      aboutField(youtubeKeyInput, 'settings.about.youtubeKey', 'settings.about.youtubeKeyHint'),
      aboutField(proxyUrlInput, 'settings.about.proxyUrl', 'settings.about.proxyUrlHint'),
      el('div', { class: 'about-row' }, [
        el('span', { text: t('settings.about.version') }),
        version,
      ]),
      el('div', { class: 'about-row' }, [
        el('span', { text: t('settings.about.updateState') }),
        updateState,
      ]),
      el('div', { class: 'settings-actions' }, [
        checkButton,
        applyButton,
        reloadButton,
        playLogButton,
      ]),
    ],
  );

  node.append(
    head,
    libraryCard,
    pickerCard,
    backgroundCard,
    storageCard,
    languageCard,
    aboutCard,
  );

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
      setText(
        importValue,
        `${formatBytes(estimate.importBytes)} · ${t('settings.storage.importCount', {
          count: estimate.importCount,
        })}`,
      );
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
    if (!confirmed(t('settings.storage.clearConfirmCache'))) return;
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
    const localRow = rows.find((row) => row.id === 'local') ?? null;
    // `emptyRow` does not carry the mode, so fall back to the store's value
    // until a source refresh patches the row.
    const localMode =
      (localRow?.mode ?? store.localMode) === 'import' ? 'import' : 'reference';

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
      if (kind === 'local') {
        setText(
          view.changeButton,
          localMode === 'import' ? t('settings.library.import') : t('settings.source.change'),
        );
      }

      setHidden(view.error, !row.error);
      if (row.error) setText(view.error, row.error);
    }

    for (const button of localModeButtons) {
      const value = button.getAttribute('data-testid').replace('local-mode-', '');
      const active = value === localMode;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }
    setText(
      localButton,
      localMode === 'import' ? t('settings.library.import') : t('settings.source.localFolder'),
    );

    const importState = localRow?.kind === 'opfs' ? localRow.progress : null;
    const importing = importState?.phase === 'copy' || importState?.phase === 'remove';
    setHidden(importProgress, !importing);
    if (importState?.phase === 'copy') {
      setText(
        importProgress,
        t('settings.library.importProgress', {
          copied: Number(importState.copied) || 0,
          total: Number(importState.total) || 0,
          bytes: formatBytes(Number(importState.bytes) || 0),
        }),
      );
    } else if (importState?.phase === 'remove') {
      setText(
        importProgress,
        t('settings.library.importRemoving', {
          removed: Number(importState.removed) || 0,
          removedTotal: Number(importState.removedTotal) || 0,
        }),
      );
    }

    const install = state.install ?? { status: 'browser' };
    const installKey =
      install.status === 'installed'
        ? 'settings.background.installed'
        : install.status === 'installable'
          ? 'settings.background.installable'
          : 'settings.background.browserMode';
    setText(installStatus, t(installKey));
    setHidden(installHint, install.status === 'installed');
    setHidden(installButton, install.status !== 'installable');

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

    for (const { value, button } of cacheLimitButtons) {
      const active = settings.cacheLimitBytes === value;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }

    setText(
      pinnedLabel,
      t('settings.storage.pinnedCount', { count: (state.pins ?? []).length }),
    );

    setHidden(applyButton, !state.updateReady);
    setText(
      updateState,
      state.updateReady ? t('settings.about.updateReady') : t('settings.about.upToDate'),
    );

    for (const [input, value] of [
      [youtubeKeyInput, settings.youtubeApiKey ?? ''],
      [proxyUrlInput, settings.playlistProxyUrl ?? ''],
    ]) {
      if (document.activeElement !== input && input.value !== value) input.value = value;
    }

    renderPicker(state);

    if (state.view === 'settings') scheduleStorage();
  }

  return { node, render };
}
