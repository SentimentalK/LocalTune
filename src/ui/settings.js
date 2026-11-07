/**
 * Full-screen settings view: library source, appearance, storage, playback,
 * language and about. The node is built once per shell; `render(state)` only
 * patches text, values and disabled states so a 4 Hz playback update never
 * rebuilds the cards.
 */

import { BUILD_VERSION } from '../core/version.js';
import { formatBytes } from '../core/storage.js';
import { resetAllData } from '../core/reset.js';
import { formatTime } from '../core/selectors.js';
import { CACHE_LIMIT_VALUES } from '../core/persist.js';
import { createBatteryGuide } from './batteryGuide.js';
import {
  LOCALES,
  LOCALE_LABELS,
  browserLanguages,
  ensureLocale,
  resolveLocale,
  systemLocale,
  t,
} from '../i18n/index.js';
import { el, icon, setHidden, setText } from './dom.js';
import { THEMES, THEME_NAMES, currentTheme } from './uiPrefs.js';

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

  const toast = (text) => {
    node.dispatchEvent(new CustomEvent('toast', { bubbles: true, detail: { text } }));
  };

  // ---- library ----
  const sourceViews = new Map();

  const REPO_URL = 'https://github.com/SentimentalK/LocalTune';
  const OAUTH_SETUP_URL = `${REPO_URL}/blob/main/docs/oauth-setup.md`;

  const CONNECT_LABELS = {
    local: 'settings.source.connectLocal',
    onedrive: 'settings.source.connectOneDrive',
    gdrive: 'settings.source.connectGdrive',
    dropbox: 'settings.source.connectDropbox',
  };
  const CHANGE_TESTIDS = {
    local: 'settings-source-change',
    onedrive: 'settings-source-onedrive',
    gdrive: 'settings-source-gdrive',
    dropbox: 'settings-source-dropbox',
  };
  const REMOVE_TESTIDS = {
    local: 'settings-source-remove',
    onedrive: 'settings-onedrive-remove',
    gdrive: 'settings-gdrive-remove',
    dropbox: 'settings-dropbox-remove',
  };
  const SOURCE_ICONS = {
    local: 'folder',
    onedrive: 'onedrive',
    gdrive: 'gdrive',
    dropbox: 'dropbox',
  };
  const SOURCE_TITLES = {
    local: 'settings.source.titleLocal',
    onedrive: 'settings.source.onedrive',
    gdrive: 'settings.source.gdrive',
    dropbox: 'settings.source.dropbox',
  };
  const SOURCE_HINTS = {
    local: 'settings.source.hintLocal',
    onedrive: 'settings.source.hintOneDrive',
    dropbox: 'settings.source.hintDropbox',
  };
  /** Providers whose brief token loss keeps the root and asks for a reconnect. */
  const RECONNECT_KINDS = new Set(['gdrive', 'dropbox']);

  function createSourceRow(kind) {
    const name = el('b', { class: 'source-title', text: t(SOURCE_TITLES[kind]) });
    const beta =
      kind === 'gdrive'
        ? el('span', { class: 'source-badge', 'data-testid': 'gdrive-beta', text: 'Beta' })
        : null;
    const count = el('span', { class: 'source-count' });
    setHidden(count, true);
    const subtitle = el('span', {
      class: 'source-subtitle',
      text: t(kind === 'gdrive' ? 'settings.gdrive.betaNote' : SOURCE_HINTS[kind]),
    });
    const rowError = el('p', { class: 'settings-error muted', role: 'alert' });
    setHidden(rowError, true);
    // Distinct from `.settings-error`: existing specs target that class to
    // probe the sync failure, and a second match would break them.
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
      subtitle,
      error: rowError,
      progress,
      progressLabel,
      progressBar,
      syncing: false,
      connected: null,
      hint: null,
      needsReconnect: false,
    };

    // Disconnected rows show one text button; connected rows show three icon
    // buttons. The actions node is swapped rather than hidden so the row never
    // carries buttons the user cannot see.
    view.connectButton = el('button', {
      class: 'btn-pill source-connect',
      type: 'button',
      'data-testid': `source-connect-${kind}`,
      text: t(kind === 'local' ? 'settings.source.shortSelect' : 'settings.source.shortConnect'),
      'aria-label': t(CONNECT_LABELS[kind]),
      title: t(CONNECT_LABELS[kind]),
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
        'data-testid': CHANGE_TESTIDS[kind],
        'aria-label': t('settings.source.changeFolder'),
        title: t('settings.source.changeFolder'),
        onclick: () => {
          const row = (store.state.sources ?? []).find((item) => item.id === kind);
          if (RECONNECT_KINDS.has(kind) && row?.needsReconnect) {
            run(kind === 'gdrive' ? store.reconnectGdrive() : store.reconnectDropbox());
            return;
          }
          changeSource(kind);
        },
      },
      [icon('pencil')],
    );

    view.removeButton = el(
      'button',
      {
        class: 'icon-action',
        type: 'button',
        'data-testid': REMOVE_TESTIDS[kind],
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

    if (kind === 'gdrive' || kind === 'dropbox') {
      // No app credential in this build: say so and link the setup guide
      // instead of offering a button that would go nowhere.
      view.hint = el(
        'p',
        { class: 'settings-hint muted', 'data-testid': `${kind}-unconfigured` },
        [
          t(`settings.${kind}.unconfigured`),
          ' ',
          el('a', {
            href: OAUTH_SETUP_URL,
            target: '_blank',
            rel: 'noopener',
            text: t(`settings.${kind}.setupLink`),
          }),
        ],
      );
      setHidden(view.hint, true);
    }

    view.node = el('div', { class: 'source-card-body', 'data-testid': `source-row-${kind}` }, [
      el('div', { class: 'source-summary' }, [
        el('span', {
          class: `source-icon source-icon-${kind}`,
          'aria-hidden': 'true',
        }, [icon(SOURCE_ICONS[kind])]),
        el('span', { class: 'source-body' }, [
          el('span', { class: 'source-heading' }, [name, beta]),
          el('span', { class: 'source-meta' }, [subtitle, count]),
        ]),
        view.actions,
      ]),
      progress,
      ...(view.hint ? [view.hint] : []),
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
    if (kind === 'gdrive') {
      // `prompt` means the short-lived token is gone: reconnect keeps the root,
      // the index and the cache instead of asking for a folder again.
      if (row.permission === 'prompt') run(store.reconnectGdrive());
      else if (row.permission === 'none') run(store.connectGdrive());
      else run(store.browseSource('gdrive', ''));
      return;
    }
    if (kind === 'dropbox') {
      if (row.permission === 'prompt') run(store.reconnectDropbox());
      else if (row.permission === 'none') run(store.connectDropbox());
      else run(store.browseSource('dropbox', ''));
      return;
    }
    if (row.permission === 'prompt') run(store.reconnectOneDrive());
    else if (row.permission === 'none') run(store.connectOneDrive());
    else run(store.browseSource('onedrive', ''));
  }

  const migrationError = el('p', { class: 'settings-error muted', role: 'alert' });
  setHidden(migrationError, true);

  function sourceCard(kind) {
    const group =
      kind === 'local' ? 'local' : kind === 'onedrive' ? 'cloud' : kind;
    return el('div', { 'data-testid': `settings-library-${group}` }, [
      el('section', { class: 'settings-card source-card' }, [createSourceRow(kind)]),
    ]);
  }

  const libraryCard = el(
    'div',
    { class: 'settings-block', 'data-testid': 'settings-section-library' },
    [
      el('h3', { class: 'settings-block-title', text: t('settings.library.title') }),
      el('div', { class: 'settings-sources' }, [
        sourceCard('local'),
        sourceCard('onedrive'),
        sourceCard('gdrive'),
        sourceCard('dropbox'),
      ]),
      migrationError,
    ],
  );

  // ---- background playback ----
  const ua = globalThis.navigator?.userAgent ?? '';
  const platform = /Android/i.test(ua)
    ? 'android'
    : /iPad|iPhone|iPod/.test(ua) ||
        (ua.includes('Macintosh') && (globalThis.navigator?.maxTouchPoints ?? 0) > 1)
      ? 'ios'
      : 'desktop';
  const desktopOnly = platform === 'desktop';

  // No web API exposes "battery optimisation / unrestricted" on Android or iOS
  // (docs/research/pwa-background-battery.md), so the state stays 'unknown' and
  // the button is always actionable. A future detector only has to return 'ok'.
  function batteryButtonState(status) {
    return status === 'ok'
      ? { labelKey: 'settings.background.batteryOk', disabled: true }
      : { labelKey: 'settings.background.checkSettings', disabled: false };
  }
  const batteryState = batteryButtonState('unknown');

  const guide = createBatteryGuide();

  const installStatus = el('p', {
    class: 'muted background-status',
    'data-testid': 'install-status',
  });

  const installButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'install-button',
    text: t('settings.background.install'),
    onclick: () => {
      if ((store.state.install?.status ?? 'browser') === 'installable') {
        run(store.install?.prompt());
        return;
      }
      if ((store.state.install?.status ?? 'browser') === 'installed') return;
      guide.open(platform, installButton);
    },
  });

  const batteryButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'battery-button',
    text: t(batteryState.labelKey),
    onclick: () => guide.open(platform, batteryButton),
  });
  if (batteryState.disabled) batteryButton.disabled = true;

  const backgroundActions = el(
    'div',
    { class: 'background-actions', 'data-testid': 'background-actions' },
    [installButton, batteryButton],
  );
  const backgroundDesktop = el('p', {
    class: 'muted background-desktop',
    'data-testid': 'background-desktop',
    text: t('settings.background.desktop'),
  });
  const backgroundBody = el('p', {
    class: 'muted',
    'data-testid': 'background-body',
    text: t('settings.background.cardBody'),
  });
  const backgroundCopy = el('div', { class: 'background-copy' }, [backgroundBody]);
  const backgroundCard = el(
    'section',
    { class: 'settings-card', 'data-testid': 'settings-section-background' },
    [backgroundCopy, backgroundActions, installStatus, backgroundDesktop],
  );
  // Desktop has no install or battery switch to act on: one sentence instead of
  // an empty action row.
  setHidden(backgroundActions, desktopOnly);
  setHidden(installStatus, desktopOnly);
  setHidden(backgroundBody, desktopOnly);
  setHidden(backgroundDesktop, !desktopOnly);

  // ---- remote folder picker (OneDrive / Google Drive) ----
  // A single flat panel, mounted inside the source row that opened it and
  // detached again on close so it never leaves a gap or a stale copy behind.
  const pickerCard = el('section', {
    class: 'settings-card remote-picker',
    tabindex: '-1',
  });
  let pickerSignature = null;

  function parentPath(path) {
    const segments = String(path ?? '').split('/').filter(Boolean);
    segments.pop();
    return segments.join('/');
  }

  /** Move the picker into `kind`'s row, directly below its summary line. */
  function mountPicker(kind) {
    const view = sourceViews.get(kind);
    if (!view) return false;
    if (pickerCard.parentNode !== view.node) {
      const summary = view.node.querySelector(':scope > .source-summary');
      view.node.insertBefore(pickerCard, summary ? summary.nextSibling : view.node.firstChild);
    }
    return true;
  }

  function renderPicker(state) {
    const picker = state.picker ?? { open: false };
    const kind = picker.kind ?? null;
    if (!picker.open || !kind) {
      pickerCard.remove();
      pickerSignature = null;
      return;
    }
    if (!mountPicker(kind)) {
      pickerSignature = null;
      return;
    }

    const path = picker.path ?? '';
    const items = picker.items ?? [];
    const signature = JSON.stringify({
      kind,
      path,
      loading: Boolean(picker.loading),
      ids: items.map((item) => item.id),
    });
    if (signature === pickerSignature) return;
    pickerSignature = signature;

    pickerCard.setAttribute('data-testid', `${kind}-picker`);
    const crumbs = [el('span', { class: 'picker-crumb', text: t(`settings.${kind}.root`) })];
    for (const segment of path.split('/').filter(Boolean)) {
      crumbs.push(el('span', { class: 'picker-crumb', text: segment }));
    }

    const children = [
      el('h3', { text: t(`settings.${kind}.title`) }),
      el('div', { class: 'picker-crumbs' }, crumbs),
    ];

    if (picker.loading) {
      children.push(el('p', { class: 'muted', text: t('settings.picker.loading') }));
    } else if (!items.length) {
      children.push(el('p', { class: 'muted', text: t('settings.picker.empty') }));
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
                'data-testid': `${kind}-folder`,
                text: item.name,
                onclick: () => run(store.browseSource(kind, item.path)),
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
      'data-testid': `${kind}-picker-up`,
      text: t('settings.picker.up'),
      disabled: !path,
      onclick: () => run(store.browseSource(kind, parentPath(path))),
    });
    const chooseButton = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': `${kind}-picker-choose`,
      text: t('settings.picker.choose'),
      disabled: !path || !current,
      onclick: () => {
        if (!current) return;
        run(store.chooseSourceRoot(kind, { id: current.id, path: current.path, name: current.name }));
      },
    });
    const cancelButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': `${kind}-picker-cancel`,
      text: t('settings.picker.cancel'),
      onclick: () => store.closePicker(),
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
    // The last option is an infinity glyph so the five segments fit a 360px
    // phone; its full name stays on the accessible label and the tooltip.
    const label = t(CACHE_LIMIT_LABELS[index] ?? 'settings.storage.limit');
    const shortLabel =
      index === CACHE_LIMIT_LABELS.length - 1
        ? t('settings.storage.limitUnlimitedShort')
        : label;
    const button = el('button', {
      type: 'button',
      class: index === CACHE_LIMIT_LABELS.length - 1 ? 'segment segment-glyph' : 'segment',
      'data-testid': `cache-limit-${index}`,
      'aria-pressed': 'false',
      'aria-label': label,
      title: label,
      text: shortLabel,
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
    { class: 'settings-card', 'data-testid': 'settings-section-storage' },
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

  const levelingModeHint = el('p', {
    class: 'hint',
    'data-testid': 'leveling-mode',
    hidden: true,
  });

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
    { class: 'settings-card', 'data-testid': 'settings-section-playback' },
    [
      el('div', { class: 'playback-line', 'data-testid': 'playback-line' }, [
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.sleepShort') }),
          sleepSelect,
        ]),
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.levelingShort') }),
          levelingButton,
        ]),
        el('div', { class: 'inline-setting' }, [
          el('span', { class: 'inline-label', text: t('settings.playback.gaplessShort') }),
          gaplessButton,
        ]),
      ]),
      levelingModeHint,
      sleepRemaining,
    ],
  );

  // ---- language ----
  const languageRows = ['auto', ...LOCALES].map((value) => {
    const auto = value === 'auto';
    const name = el('span', {
      class: 'language-name',
      text: auto
        ? `${t('settings.language.auto')} · ${systemLocale().label}`
        : LOCALE_LABELS[value],
    });
    if (!auto) name.setAttribute('lang', value);
    const check = icon('check');
    check.classList.add('language-check');
    const button = el(
      'button',
      {
        type: 'button',
        class: 'language-row',
        role: 'radio',
        'data-testid': `language-${value}`,
        'aria-checked': 'false',
        tabindex: '-1',
        onclick: () => run(selectLanguage(value)),
      },
      [name, check],
    );
    return { value, button };
  });

  async function selectLanguage(value) {
    const target = value === 'auto' ? resolveLocale(browserLanguages()) : value;
    // Load first: a failed chunk leaves the setting untouched (the UI keeps
    // showing English) instead of storing an unusable locale.
    await ensureLocale(target);
    store.setSetting('language', value);
  }

  // Which browser languages the resolver reads, in order. Tiny and muted: it
  // explains why "Follow system" landed on the language it did.
  const browserHint = el('p', {
    class: 'language-browser',
    'data-testid': 'browser-language-hint',
    text: t('settings.language.browser', { list: browserLanguages().join(' · ') || '—' }),
  });

  // "Follow system" and the browser hint share one full-width first line: the
  // hint sits at that line's right edge instead of claiming a row of its own.
  const languageFirst = el('div', { class: 'language-first' }, [
    languageRows[0].button,
    browserHint,
  ]);

  const languageList = el(
    'div',
    {
      class: 'language-list',
      role: 'radiogroup',
      'aria-label': t('settings.language.title'),
    },
    [languageFirst, ...languageRows.slice(1).map(({ button }) => button)],
  );

  // Roving tabindex: one tab stop, arrows move focus and select in one step.
  languageList.addEventListener('keydown', (event) => {
    const buttons = languageRows.map(({ button }) => button);
    let index = buttons.indexOf(event.target.closest?.('.language-row'));
    if (index < 0) index = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true');
    if (index < 0) index = 0;
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    // No wrap-around: the ends of the list hold focus.
    next = Math.min(Math.max(next, 0), buttons.length - 1);
    buttons.forEach((button, i) => {
      button.tabIndex = i === next ? 0 : -1;
    });
    const row = languageRows[next];
    row.button.focus();
    run(selectLanguage(row.value));
  });

  const languageCard = el(
    'section',
    { class: 'settings-card', 'data-testid': 'settings-section-language' },
    [languageList],
  );

  // ---- appearance ----
  // Each swatch previews its theme as a tiny record: the disc is the theme
  // background, the label its accent. Colours come from the stylesheet, so a
  // palette edit never leaves a stale preview behind.
  function readThemePreviews() {
    const values = new Map();
    const root = document.documentElement;
    const previous = root.dataset.theme ?? '';
    try {
      for (const theme of THEMES) {
        root.dataset.theme = theme;
        const style = getComputedStyle(root);
        values.set(theme, {
          bg: style.getPropertyValue('--bg').trim(),
          accent: style.getPropertyValue('--accent').trim(),
        });
      }
    } catch {
      // No document: the swatches still render, just without a preview.
    }
    if (previous) root.dataset.theme = previous;
    else delete root.dataset.theme;
    return values;
  }

  const themePreviews = readThemePreviews();

  function syncActiveTheme(theme) {
    for (const row of themeRows) {
      const active = row.value === theme;
      row.button.setAttribute('aria-checked', String(active));
      row.button.classList.toggle('is-active', active);
      row.button.tabIndex = active ? 0 : -1;
    }
  }

  function chooseTheme(value) {
    // The shell applies and persists the theme, then calls syncTheme back so
    // the swatch, the header button and the browser chrome agree.
    node.dispatchEvent(
      new CustomEvent('theme', { bubbles: true, detail: { theme: value } }),
    );
    syncActiveTheme(value);
  }

  const themeRows = THEMES.map((value) => {
    const name = THEME_NAMES[value] ?? value;
    const preview = themePreviews.get(value);
    const disc = el('span', { class: 'theme-swatch-disc' });
    if (preview) {
      disc.style.setProperty('--swatch-bg', preview.bg);
      disc.style.setProperty('--swatch-accent', preview.accent);
    }
    const button = el(
      'button',
      {
        type: 'button',
        class: 'theme-swatch',
        role: 'radio',
        'aria-checked': 'false',
        'data-testid': `theme-${value}`,
        title: name,
        tabindex: '-1',
        onclick: () => chooseTheme(value),
      },
      [disc, el('span', { class: 'theme-swatch-name', text: name })],
    );
    return { value, button };
  });

  const themeGrid = el(
    'div',
    {
      class: 'theme-grid',
      role: 'radiogroup',
      'aria-label': t('settings.appearance.title'),
    },
    themeRows.map(({ button }) => button),
  );

  // One tab stop, arrows select in one step, ends hold focus.
  themeGrid.addEventListener('keydown', (event) => {
    const buttons = themeRows.map(({ button }) => button);
    let index = buttons.indexOf(event.target.closest?.('.theme-swatch'));
    if (index < 0) index = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true');
    if (index < 0) index = 0;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    next = Math.min(Math.max(next, 0), buttons.length - 1);
    const row = themeRows[next];
    row.button.focus();
    chooseTheme(row.value);
  });

  const themeCard = el(
    'section',
    { class: 'settings-card', 'data-testid': 'settings-section-theme' },
    [themeGrid],
  );

  syncActiveTheme(currentTheme());

  // ---- about ----
  const version = el('b', { 'data-testid': 'about-version', text: BUILD_VERSION });
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

  const clearDataButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'settings-clear-data',
    text: t('settings.about.clearData'),
    onclick: async () => {
      if (clearDataButton.disabled) return;
      clearDataButton.disabled = true;
      await resetAllData({
        store,
        indexedDB: globalThis.indexedDB,
        caches: globalThis.caches,
        serviceWorker: globalThis.navigator?.serviceWorker,
        storage: globalThis.localStorage,
        sessionStorage: globalThis.sessionStorage,
        opfs: globalThis.navigator?.storage,
        replace: (url) => location.replace(url),
      });
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

  const githubLink = el(
    'a',
    {
      class: 'settings-github',
      href: REPO_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-testid': 'settings-github',
    },
    [icon('github'), el('span', { text: 'GitHub' })],
  );

  const aboutCard = el(
    'section',
    { class: 'settings-card', 'data-testid': 'settings-section-about' },
    [
      el('div', { class: 'about-row' }, [
        el('span', { text: t('settings.about.version') }),
        version,
      ]),
      el('div', { class: 'settings-actions' }, [
        githubLink,
        checkButton,
        applyButton,
        clearDataButton,
        playLogButton,
      ]),
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
    settingsBlock(t('settings.appearance.title'), themeCard),
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

    for (const [kind, view] of sourceViews) {
      const row = rows.find((item) => item.id === kind) ?? {
        permission: 'none',
        name: '',
        trackCount: 0,
        scanning: false,
        progress: { done: 0, total: 0 },
        error: null,
        configured: true,
        needsReconnect: false,
      };
      const permission = row.permission;
      const scanning = Boolean(row.scanning);
      const trackCount = row.trackCount ?? 0;
      const connected = permission === 'granted' || trackCount > 0;
      const hint =
        kind === 'gdrive' ? t('settings.gdrive.betaNote') : t(SOURCE_HINTS[kind]);
      setText(view.subtitle, connected && row.name ? row.name : hint);
      setText(
        view.count,
        trackCount > 0 ? `· ${t('settings.source.trackCount', { count: trackCount })}` : '',
      );
      setHidden(view.count, trackCount === 0);
      syncActions(view, connected);

      const configured = row.configured !== false;
      const needsReconnect = Boolean(row.needsReconnect);
      const reconnect = RECONNECT_KINDS.has(kind) && needsReconnect;
      const fullLabel = reconnect
        ? t('settings.source.reconnect')
        : t(CONNECT_LABELS[kind]);
      const visibleLabel = reconnect
        ? fullLabel
        : t(
            kind === 'local'
              ? 'settings.source.shortSelect'
              : 'settings.source.shortConnect',
          );
      setText(view.connectButton, visibleLabel);
      view.connectButton.setAttribute('aria-label', fullLabel);
      view.connectButton.setAttribute('title', fullLabel);
      // An unconfigured OAuth build cannot start a flow at all: no network, no
      // enabled connect button.
      view.connectButton.disabled = RECONNECT_KINDS.has(kind) && !configured;
      if (view.hint) setHidden(view.hint, configured);

      view.syncButton.disabled =
        view.syncing ||
        scanning ||
        permission === 'none' ||
        (RECONNECT_KINDS.has(kind) && !configured);
      view.changeButton.disabled = scanning;
      const changeLabel = reconnect
        ? t('settings.source.reconnect')
        : t('settings.source.changeFolder');
      view.changeButton.setAttribute('aria-label', changeLabel);
      view.changeButton.setAttribute('title', changeLabel);
      view.removeButton.disabled = scanning || (permission === 'none' && trackCount === 0);
      // Import progress is owned by the header; the card must not show a
      // second percentage for the same copy pass.
      const showProgress = scanning && row.progress?.phase !== 'import';
      setHidden(view.progress, !showProgress);
      if (showProgress) {
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
      // A dead token is the actionable fact; the provider's raw 401 text adds
      // nothing on top of it.
      const reconnectMessage = needsReconnect ? t(`settings.${kind}.authFailed`) : '';
      const message = reconnectMessage || row.error || warning;
      setHidden(view.error, !message);
      if (message) setText(view.error, message);
    }

    if (!desktopOnly) {
      const installState = state.install?.status ?? 'browser';
      setText(
        installButton,
        t(
          installState === 'installed'
            ? 'settings.background.installed'
            : installState === 'installable'
              ? 'settings.background.install'
              : 'settings.background.howToInstall',
        ),
      );
      installButton.disabled = installState === 'installed';
      installButton.setAttribute('aria-disabled', String(installState === 'installed'));
      setText(
        installStatus,
        t(
          installState === 'installed'
            ? 'settings.background.installedHint'
            : installState === 'installable'
              ? 'settings.background.installable'
              : 'settings.background.browserMode',
        ),
      );
    }

    const migrationMessage = migration?.error;
    setHidden(migrationError, !migrationMessage);
    if (migrationMessage) {
      setText(
        migrationError,
        t('settings.library.migrationFailed', { message: migrationMessage }),
      );
    }

    for (const { value, button } of languageRows) {
      const active = settings.language === value;
      button.setAttribute('aria-checked', String(active));
      button.classList.toggle('is-active', active);
      button.tabIndex = active ? 0 : -1;
    }

    const browserHintText = t('settings.language.browser', {
      list: browserLanguages().join(' · ') || '—',
    });
    if (browserHint.textContent !== browserHintText) browserHint.textContent = browserHintText;

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

    const levelingOn = state.settings.leveling === true;
    const mode = state.levelingMode ?? 'off';
    const note = state.levelingNote ?? null;
    let levelingKey = null;
    if (levelingOn) {
      if (note === 'streaming') levelingKey = 'settings.playback.levelingUnsupported';
      else if (mode === 'full') levelingKey = 'settings.playback.levelingFull';
      else if (mode === 'gain-only') levelingKey = 'settings.playback.levelingGainOnly';
      else levelingKey = 'settings.playback.levelingPending';
    }
    setHidden(levelingModeHint, !levelingKey);
    if (levelingKey) setText(levelingModeHint, t(levelingKey));

    for (const { value, button } of cacheLimitButtons) {
      const active = settings.cacheLimitBytes === value;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }

    setHidden(applyButton, !state.updateReady);

    renderPicker(state);

    if (state.view === 'settings') scheduleStorage();
  }

  return { node, render, syncTheme: syncActiveTheme };
}
