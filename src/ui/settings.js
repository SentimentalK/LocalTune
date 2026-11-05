/**
 * Full-screen settings view: library source, storage, playback, language and
 * about. The node is built once per shell; `render(state)` only patches text,
 * values and disabled states so a 4 Hz playback update never rebuilds the
 * cards.
 */

import { BUILD_VERSION } from '../core/version.js';
import { BATTERY_BRANDS, BATTERY_STEP_KEYS } from '../core/battery.js';
import { formatBytes } from '../core/storage.js';
import { formatTime } from '../core/selectors.js';
import { CACHE_LIMIT_VALUES } from '../core/persist.js';
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

  const toast = (text) => {
    node.dispatchEvent(new CustomEvent('toast', { bubbles: true, detail: { text } }));
  };

  // ---- library ----
  const sourceViews = new Map();

  function createSourceRow(kind) {
    const name = el('b', { text: t('settings.source.permissionNone') });
    const count = el('span', { text: t('settings.source.trackCount', { count: 0 }) });
    const rowError = el('p', { class: 'settings-error muted', role: 'alert' });
    setHidden(rowError, true);
    // Distinct from `.settings-error`: existing specs target that class to
    // probe the sync failure, and a second match would break them.
    const hint = el('p', {
      class: 'settings-hint muted',
      role: 'status',
      'data-testid': `source-hint-${kind}`,
      style: { margin: '0', padding: '0 16px 12px', fontSize: '12px' },
    });
    setHidden(hint, true);
    const progressLabel = el('span');
    const progressBar = el('i');
    const progress = el('div', { class: 'settings-progress', role: 'status' }, [
      progressLabel,
      el('div', { class: 'bar' }, progressBar),
    ]);
    setHidden(progress, true);

    const view = {
      name,
      count,
      hint,
      error: rowError,
      progress,
      progressLabel,
      progressBar,
      syncing: false,
      connected: null,
    };

    // Disconnected rows show one text button; connected rows show three icon
    // buttons. The actions node is swapped rather than hidden so the row never
    // carries buttons the user cannot see.
    view.connectButton = el('button', {
      class: 'btn-pill source-connect',
      type: 'button',
      'data-testid': `source-connect-${kind}`,
      text: kind === 'onedrive'
        ? t('settings.source.connectOneDrive')
        : t('settings.source.connectLocal'),
      onclick: () => changeSource(kind),
    });

    view.syncButton = el(
      'button',
      {
        class: 'icon-action',
        type: 'button',
        'data-testid': `settings-sync-${kind}`,
        'aria-label': t('settings.source.sync'),
        title: t('settings.source.sync'),
        onclick: async () => {
          if (view.syncing) return;
          view.syncing = true;
          view.syncButton.disabled = true;
          view.syncButton.classList.add('is-busy');
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
            view.syncButton.classList.remove('is-busy');
          }
        },
      },
      [icon('refresh')],
    );

    view.changeButton = el(
      'button',
      {
        class: 'icon-action',
        type: 'button',
        'data-testid': kind === 'local' ? 'settings-source-change' : 'settings-source-onedrive',
        onclick: () => changeSource(kind),
      },
      [icon('pencil')],
    );

    view.removeButton = el(
      'button',
      {
        class: 'icon-action',
        type: 'button',
        'data-testid': kind === 'local' ? 'settings-source-remove' : 'settings-onedrive-remove',
        'aria-label': t('settings.source.remove'),
        title: t('settings.source.remove'),
        onclick: () => {
          if (!confirmed(t('settings.source.removeConfirm'))) return;
          run(store.removeSource(kind));
        },
      },
      [icon('trash')],
    );

    view.iconGroup = el('div', { class: 'source-actions-icons' }, [
      view.syncButton,
      view.changeButton,
      view.removeButton,
    ]);
    setHidden(view.iconGroup, true);

    view.actions = el('div', { class: 'source-actions' }, [view.connectButton]);

    view.node = el('div', { class: 'source-card-body', 'data-testid': `source-row-${kind}` }, [
      el('div', { class: 'source-summary' }, [
        el('span', {
          class: `source-icon source-icon-${kind}`,
          'aria-hidden': 'true',
        }, [icon(kind === 'onedrive' ? 'onedrive' : 'folder')]),
        el('span', { class: 'source-body' }, [name, count]),
        view.actions,
      ]),
      progress,
      hint,
      rowError,
    ]);

    sourceViews.set(kind, view);
    return view.node;
  }

  /** Swap the actions between the connect button and the icon trio. */
  function syncActions(view, connected) {
    if (view.connected === connected) return;
    view.connected = connected;
    view.actions.replaceChildren(...(connected ? [view.iconGroup] : [view.connectButton]));
    setHidden(view.connectButton, connected);
    setHidden(view.iconGroup, !connected);
  }

  function changeSource(kind) {
    const row = (store.state.sources ?? []).find((item) => item.id === kind) ?? {
      permission: 'none',
    };
    if (kind === 'local') {
      run(row.permission === 'prompt' ? store.requestSourcePermission() : store.connectSource());
      return;
    }
    if (row.permission === 'prompt') run(store.reauthenticateOneDrive());
    else if (row.permission === 'none') run(store.connectOneDrive());
    else run(store.browseOneDrive(''));
  }

  const migrationError = el('p', { class: 'settings-error muted', role: 'alert' });
  setHidden(migrationError, true);

  const importProgress = el('p', {
    class: 'settings-progress muted',
    role: 'status',
    'data-testid': 'import-progress',
  });
  setHidden(importProgress, true);

  function sourceCard(kind, title) {
    return el('div', { 'data-testid': `settings-library-${kind === 'local' ? 'local' : 'cloud'}` }, [
      el('h4', { class: 'settings-card-title', text: title }),
      el('section', { class: 'card settings-card source-card' }, [
        createSourceRow(kind),
        ...(kind === 'local' ? [importProgress] : []),
      ]),
    ]);
  }

  const libraryCard = el(
    'div',
    { class: 'settings-block', 'data-testid': 'settings-section-library' },
    [
      el('h3', { class: 'settings-block-title', text: t('settings.library.title') }),
      el('div', { class: 'settings-sources' }, [
        sourceCard('local', t('settings.library.localGroup')),
        sourceCard('onedrive', t('settings.library.cloudGroup')),
      ]),
      migrationError,
    ],
  );

  // ---- background playback ----
  const BRAND_LABELS = {
    samsung: 'settings.background.batteryBrandSamsung',
    xiaomi: 'settings.background.batteryBrandXiaomi',
    huawei: 'settings.background.batteryBrandHuawei',
    stock: 'settings.background.batteryBrandStock',
  };

  const installStatus = el('p', { class: 'muted', 'data-testid': 'install-status' });

  const installButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'install-button',
    text: t('settings.background.install'),
    onclick: async () => {
      installButton.disabled = true;
      try {
        const result = await store.install?.prompt();
        if (result?.outcome === 'accepted') {
          setText(installStatus, t('settings.background.installNext'));
          toast(t('settings.background.installNext'));
        }
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
    text: t('settings.background.batteryGuide'),
    onclick: () => {
      for (const node of batterySteps.querySelectorAll('details')) node.open = true;
      batterySteps.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
  const batteryDesktop = el('p', {
    class: 'muted',
    text: t('settings.background.batteryDesktop'),
  });
  setHidden(batteryButton, !isAndroid);
  setHidden(batteryDesktop, isAndroid);

  const ua = globalThis.navigator?.userAgent ?? '';
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes('Macintosh') && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);
  const iosGuide = el('div', { 'data-testid': 'ios-install-guide' }, [
    el('h4', { text: t('settings.background.iosTitle') }),
    el('p', { class: 'muted', text: t('settings.background.iosHint') }),
    el('ol', { class: 'tag-report' }, [1, 2, 3].map((step) =>
      el('li', { 'data-testid': `ios-step-${step}`, text: t(`settings.background.ios${step}`) }),
    )),
  ]);

  const backgroundCopy = el('div', { class: 'background-copy' }, [
    el('h4', { class: 'background-title', text: t('settings.background.cardTitle') }),
    el('p', { class: 'muted', text: t('settings.background.cardBody') }),
  ]);
  const backgroundGrid = el('div', { class: 'background-grid', 'data-testid': 'background-grid' }, [
    backgroundCopy,
    el('div', { class: 'background-actions' }, [installButton, batteryButton]),
  ]);
  const batterySteps = el(
    'div',
    { class: 'battery-steps', 'data-testid': 'battery-steps-section' },
    [
      el('h5', { class: 'battery-steps-title', text: t('settings.background.stepsTitle') }),
      el('div', { class: 'battery-brand-stock', 'data-testid': 'battery-steps-stock' }, [
        el('ol', { class: 'battery-steps-list', 'data-testid': 'battery-steps-stock-list' },
          BATTERY_STEP_KEYS.stock.map((key) => el('li', { text: t(key) }))),
      ]),
      ...BATTERY_BRANDS.filter((brand) => brand !== 'stock').map((brand) => {
        const list = el('ol', { class: 'battery-steps-list' },
          (BATTERY_STEP_KEYS[brand] ?? []).map((key) => el('li', { text: t(key) })));
        const details = el('details', { class: 'battery-brand-details', 'data-testid': `battery-brand-details-${brand}` }, [
          el('summary', { text: t(BRAND_LABELS[brand]) }),
          list,
        ]);
        return details;
      }),
    ],
  );

  const backgroundCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-background' },
    [backgroundGrid, installStatus, batteryDesktop, batterySteps, iosGuide],
  );

  // ---- OneDrive folder picker ----
  const pickerCard = el('section', {
    class: 'card settings-card onedrive-picker',
    'data-testid': 'onedrive-picker',
    tabindex: '-1',
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
    el('span', { class: 'storage-limit-label', text: t('settings.storage.limit') }),
    el(
      'div',
      {
        class: 'segmented storage-limit-options',
        role: 'group',
        'aria-label': t('settings.storage.limit'),
        'data-testid': 'cache-limit',
      },
      cacheLimitButtons.map(({ button }) => button),
    ),
  ]);

  const clearAllButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'clear-all',
    text: t('settings.storage.clearAll'),
  });

  const storageCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-storage' },
    [
      limitRow,
      el('div', { class: 'storage-rows' }, [indexRow.row, coverRow.row, audioRow.row]),
      usageLine,
      el('div', { class: 'settings-actions' }, [clearAllButton]),
    ],
  );

  // ---- playback ----
  const SLEEP_OPTIONS = [
    { value: 'off', labelKey: 'settings.playback.sleepOff' },
    { value: '15', labelKey: 'settings.playback.sleep15' },
    { value: '30', labelKey: 'settings.playback.sleep30' },
    { value: '45', labelKey: 'settings.playback.sleep45' },
    { value: '60', labelKey: 'settings.playback.sleep60' },
    { value: 'end', labelKey: 'settings.playback.sleepEnd' },
  ];
  const sleepSelect = el('select', {
    class: 'sleep-select',
    'data-testid': 'sleep-timer',
    'aria-label': t('settings.playback.sleep'),
  }, SLEEP_OPTIONS.map(({ value, labelKey }) => el('option', { value, text: t(labelKey) })));
  sleepSelect.addEventListener('change', () => store.setSleepMode(sleepSelect.value));

  const sleepRemaining = el('p', {
    class: 'hint',
    'data-testid': 'sleep-remaining',
    hidden: true,
  });

  function toggleButton(key, testid) {
    return el(
      'button',
      {
        class: 'toggle-switch',
        type: 'button',
        role: 'switch',
        'data-testid': testid,
        'aria-checked': 'false',
        'aria-label': t(`settings.playback.${key}`),
        onclick: () => store.setSetting(key, !store.state.settings[key]),
      },
      [el('span', { class: 'toggle-knob', 'aria-hidden': 'true' })],
    );
  }

  const levelingButton = toggleButton('leveling', 'setting-leveling');
  const gaplessButton = toggleButton('gapless', 'setting-gapless');

  const playbackCard = el(
    'section',
    { class: 'card settings-card', 'data-testid': 'settings-section-playback' },
    [
      el('div', { class: 'playback-line', 'data-testid': 'playback-line' }, [
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.sleep') }),
          sleepSelect,
        ]),
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.leveling') }),
          levelingButton,
        ]),
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.gapless') }),
          gaplessButton,
        ]),
      ]),
      sleepRemaining,
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

  function settingsBlock(title, card) {
    return el('div', { class: 'settings-block' }, [
      el('h3', { class: 'settings-block-title', text: title }),
      card,
    ]);
  }

  node.append(
    libraryCard,
    pickerCard,
    settingsBlock(t('settings.background.title'), backgroundCard),
    settingsBlock(t('settings.storage.title'), storageCard),
    settingsBlock(t('settings.playback.title'), playbackCard),
    settingsBlock(t('settings.language.title'), languageCard),
    settingsBlock(t('settings.about.title'), aboutCard),
  );

  // Storage figures are async and can be expensive on a large cache: throttle
  // to one leading call plus at most one trailing refresh per second.
  let lastEstimateAt = 0;
  let estimateTimer = null;
  let estimateToken = 0;
  let clearingAll = false;

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

  clearAllButton.addEventListener('click', async () => {
    if (clearingAll) return;
    if (!confirmed(t('settings.storage.clearAllConfirm'))) return;
    clearingAll = true;
    clearAllButton.disabled = true;
    try {
      await store.clearAll();
      toast(t('settings.storage.clearedAll'));
      await refreshStorage();
    } catch {
      // Leave the figures as they were; the store keeps whatever it deleted.
    } finally {
      clearingAll = false;
      clearAllButton.disabled = false;
    }
  });

  function render(state) {
    const { settings, migration } = state;
    const rows = state.sources ?? [];
    const localRow = rows.find((row) => row.id === 'local') ?? null;

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
      const scanning = Boolean(row.scanning);
      const trackCount = row.trackCount ?? 0;
      const connected = permission === 'granted' || trackCount > 0;
      const needsReconnect = permission !== 'granted' && trackCount > 0;
      syncActions(view, connected);
      setHidden(view.hint, !needsReconnect);
      if (needsReconnect) setText(view.hint, t('library.expiredHint'));

      const connectLabel =
        permission === 'prompt'
          ? t('settings.source.reconnect')
          : kind === 'onedrive'
            ? t('settings.source.connectOneDrive')
            : t('settings.source.connectLocal');
      setText(view.connectButton, connectLabel);
      view.connectButton.setAttribute('aria-label', connectLabel);
      view.connectButton.setAttribute('title', connectLabel);

      view.syncButton.disabled = view.syncing || scanning || permission === 'none';
      view.changeButton.disabled = scanning;
      const changeLabel = needsReconnect
        ? t('library.reconnect')
        : t('settings.source.changeFolder');
      view.changeButton.setAttribute('aria-label', changeLabel);
      view.changeButton.setAttribute('title', changeLabel);
      view.removeButton.disabled = scanning || (permission === 'none' && trackCount === 0);
      setHidden(view.progress, !scanning);
      if (scanning) {
        const { done, total, phase } = row.progress ?? { done: 0, total: 0 };
        setText(
          view.progressLabel,
          phase === 'cache'
            ? t('settings.source.caching', { done, total })
            : total > 0
              ? t('common.scanProgress', { done, total })
              : t('common.scanCount', { done }),
        );
        const ratio = total > 0 ? Math.min(done / total, 1) : 0.12;
        view.progressBar.style.width = `${Math.round(ratio * 100)}%`;
      }

      const failures = Array.isArray(row.cacheFailures) ? row.cacheFailures : [];
      const warning =
        failures.length > 0
          ? t('settings.source.cacheFailed', {
              count: failures.length,
              paths: `${failures.slice(0, 3).join('、')}${failures.length > 3 ? '…' : ''}`,
            })
          : '';
      const message = row.error || warning;
      setHidden(view.error, !message);
      if (message) setText(view.error, message);
    }

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
    setHidden(installButton, install.status !== 'installable');
    setHidden(iosGuide, !isIos || install.status === 'installed');

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

    const sleep = state.sleep ?? { mode: 'off', remaining: null, fading: false };
    if (sleepSelect.value !== sleep.mode) sleepSelect.value = sleep.mode;
    const timedMode = ['15', '30', '45', '60'].includes(sleep.mode);
    const showRemaining = timedMode && Number.isFinite(sleep.remaining);
    setHidden(sleepRemaining, !showRemaining);
    if (showRemaining) {
      setText(
        sleepRemaining,
        t(
          sleep.fading ? 'settings.playback.sleepFading' : 'settings.playback.sleepRemaining',
          { time: formatTime(Math.ceil(sleep.remaining / 1000)) },
        ),
      );
    }
    for (const [key, button] of [
      ['leveling', levelingButton],
      ['gapless', gaplessButton],
    ]) {
      const on = Boolean(settings[key]);
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('is-on', on);
    }

    for (const { value, button } of cacheLimitButtons) {
      const active = settings.cacheLimitBytes === value;
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
