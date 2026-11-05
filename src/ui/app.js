/**
 * Full page UI for LocalTune. Renders once, then patches the persistent shell
 * on every store change (coalesced into one requestAnimationFrame). Only the
 * active view is rebuilt, and only when its inputs change, so a 4 Hz
 * timeupdate does not recreate a thousand-row library.
 */

import { formatTime } from '../core/selectors.js';
import { subdirsOf, tracksDirect, tracksUnder } from '../core/folders.js';
import { runSearch } from '../core/search.js';
import { activeLineIndex } from '../core/lyrics/lrc.js';
import {
  libraryVisible,
  sourceNeedsReconnect,
  visibleSources,
} from '../core/library.js';
import { LYRICS_ENABLED } from '../core/flags.js';
import { el, icon, coverUrl, syncCoverCache, setText, setHidden } from './dom.js';
import { createSettingsView } from './settings.js';
import { createVipView } from './vip.js';
import { createImportDialog, createPlaylistView } from './playlist.js';
import { openTagInfo } from './diagnostics.js';
import { applyDocumentLang, getLocale, resolveLanguage, setLocale, t } from '../i18n/index.js';

const TABS = [
  { id: 'folders', labelKey: 'tabs.folders' },
  { id: 'queue', labelKey: 'tabs.queue' },
];

const REPEAT_LABEL_KEY = {
  off: 'player.repeatOff',
  all: 'player.repeatAll',
  one: 'player.repeatOne',
};
const REPEAT_BADGE = { off: '', all: '∞', one: '1' };
const SEEK_STEP = 5;

/** Search groups in priority order; ids double as `search.group*` keys. */
const SEARCH_GROUPS = [
  { id: 'title', labelKey: 'search.groupTitle' },
  { id: 'artist', labelKey: 'search.groupArtist' },
  { id: 'album', labelKey: 'search.groupAlbum' },
  { id: 'fileName', labelKey: 'search.groupFileName' },
];

const SEARCH_DEBOUNCE_MS = 150;

// Installability is only observable through the event; the app never prompts.
let installPromptSeen = false;

// The rematch notice is cleared as soon as it is shown, so a re-render with the
// same count must stay quiet. 0 means no notice is pending.
let lastRematchAdded = 0;

function isInstalled() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  }
  return window.navigator?.standalone === true;
}

function installHint() {
  return installPromptSeen && !isInstalled() ? t('empty.installHint') : '';
}

function run(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

// Tracks stored before the empty-string defaults may still hold a sentinel.
// Legacy sentinels stored by pre-i18n builds; never rendered, escaped to keep
// the UI free of literal CJK copy outside the language names.
const UNKNOWN = new Set(['', '\u672a\u77e5\u6b4c\u624b', '\u672a\u77e5\u4e13\u8f91']);
const artistLabel = (value) => (UNKNOWN.has(value ?? '') ? t('common.unknownArtist') : value);
const albumLabel = (value) => (UNKNOWN.has(value ?? '') ? t('common.unknownAlbum') : value);

function subtitleOf(track) {
  const parts = [artistLabel(track.artist), albumLabel(track.album)];
  if (Number.isFinite(track.year) && track.year > 0) parts.push(String(track.year));
  return parts.filter(Boolean).join(' · ');
}

function artNode(cover, className = 'art') {
  const node = el('span', { class: className, 'aria-hidden': 'true' });
  const url = coverUrl(cover);
  if (url) node.style.backgroundImage = `url("${url}")`;
  return node;
}

function emptyState({
  title,
  text,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  secondaryTestId,
  note,
}) {
  const children = [el('h2', { text: title }), el('p', { text })];
  if (actionLabel) {
    children.push(
      el('button', { class: 'btn-pill', type: 'button', text: actionLabel, onclick: onAction }),
    );
  }
  if (secondaryLabel) {
    children.push(
      el('button', {
        class: 'btn-pill ghost',
        type: 'button',
        text: secondaryLabel,
        'data-testid': secondaryTestId,
        onclick: onSecondary,
      }),
    );
  }
  const notes = Array.isArray(note) ? note : note ? [note] : [];
  for (const line of notes) {
    if (line) children.push(el('p', { text: line }));
  }
  return el('section', { class: 'card empty' }, children);
}

const LONG_PRESS_MS = 500;

function bindRowMenu(row, track, anchor, onMore) {
  if (!onMore) return;
  let timer = 0;
  let fired = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };

  row.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest?.('.row-more, .row-x, .row-add')) return;
    cancel();
    fired = false;
    timer = setTimeout(() => {
      timer = 0;
      fired = true;
      onMore(track, anchor);
    }, LONG_PRESS_MS);
  });
  row.addEventListener('pointerup', cancel);
  row.addEventListener('pointerleave', cancel);
  row.addEventListener('pointercancel', cancel);
  row.addEventListener('pointermove', cancel);

  // The long press must not also count as a tap on the row.
  row.addEventListener(
    'click',
    (event) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    onMore(track, anchor);
  });
}

function moreButton(track, onMore) {
  const button = el(
    'button',
    {
      class: 'row-more',
      type: 'button',
      'data-testid': 'row-more',
      'aria-label': t('aria.more', { title: track.title }),
      onclick: (event) => {
        event.stopPropagation();
        onMore?.(track, button);
      },
    },
    [icon('more')],
  );
  return button;
}

function trackRow(track, { now, onActivate, onMore }) {
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': t('aria.playTrack', { title: track.title }),
      onclick: onActivate,
    },
    [
      artNode(track.cover),
      el('span', { class: 't' }, [
        el('b', { text: track.title }),
        el('span', { text: subtitleOf(track) }),
      ]),
      el('time', { text: formatTime(track.duration) }),
    ],
  );
  const more = moreButton(track, onMore);
  const row = el(
    'li',
    { class: now ? 'row now' : 'row', 'data-testid': 'track-row', 'data-track-id': track.id },
    [hit, more],
  );
  bindRowMenu(row, track, more, onMore);
  return row;
}

function queueRow(track, index, { now, onActivate, onRemove }) {
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': t('aria.playQueueItem', { index: index + 1, title: track.title }),
      onclick: onActivate,
    },
    [
      el('span', { class: 'n', text: String(index + 1).padStart(2, '0') }),
      artNode(track.cover),
      el('span', { class: 't' }, [
        el('b', { text: track.title }),
        el('span', { text: subtitleOf(track) }),
      ]),
      el('time', { text: formatTime(track.duration) }),
    ],
  );
  const remove = el('button', {
    class: 'row-x',
    type: 'button',
    text: '×',
    'aria-label': t('aria.removeFromQueue', { title: track.title }),
    onclick: onRemove,
  });
  const row = el('li', { class: now ? 'row queue now' : 'row queue' }, [hit, remove]);
  return row;
}

const PIN_PATH =
  'M16 9V4h1V2H7v2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z';

// The shared icon set lives in `dom.js`; the pin glyph is drawn here so the
// folder view owns the only icon it needs beyond the common set.
function pinIcon() {
  const svg = icon('pin');
  const path = svg.querySelector('path');
  if (path) path.setAttribute('d', PIN_PATH);
  return svg;
}

/**
 * Pin control for one directory. The status text sits next to the button so the
 * row reports progress and the pinned state without a second render pass.
 */
function pinRowParts({ pinned, pin = null, testId, onToggle }) {
  const status = el('span', { class: 'row-pin-status' });
  if (pin?.running) {
    setText(
      status,
      t('settings.storage.pinning', { done: pin.done ?? 0, total: pin.total ?? 0 }),
    );
  } else if (pin?.error) {
    setText(status, pin.error);
  } else if (pinned) {
    setText(status, t('settings.storage.pinned'));
  } else {
    setHidden(status, true);
  }

  const button = el(
    'button',
    {
      class: pinned ? 'row-pin is-on' : 'row-pin',
      type: 'button',
      'data-testid': testId,
      'aria-pressed': String(pinned),
      'aria-label': pinned ? t('settings.storage.unpin') : t('settings.storage.pin'),
      'title': pinned ? t('settings.storage.unpin') : t('settings.storage.pin'),
      disabled: Boolean(pin?.running),
      onclick: onToggle,
    },
    [pinIcon()],
  );

  return { status, button };
}

/**
 * Source root row: opens the first level of that source's folder tree. An
 * expired grant keeps the row (cached tracks are still playable) and adds the
 * reconnect action outside the hit button, so it never navigates.
 */
function sourceRow({ id, label, count, onOpen, needsReconnect = false, onReconnect = null }) {
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'data-testid': `folder-source-${id}`,
      onclick: onOpen,
    },
    [
      artNode(null),
      el('span', { class: 't' }, [
        el('b', { text: label }),
        el('span', { text: t('common.trackCount', { count }) }),
      ]),
    ],
  );
  if (!needsReconnect) return el('li', { class: 'row' }, [hit]);
  const note = el('div', { class: 'row-note' }, [
    el('span', {
      class: 'muted',
      'data-testid': `source-hint-${id}`,
      text: t('library.expiredHint'),
    }),
    el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': `source-reconnect-${id}`,
      text: t('library.reconnect'),
      onclick: onReconnect,
    }),
  ]);
  return el('li', { class: 'row has-note' }, [hit, note]);
}

function folderSection(headerLabel, countLabel, children) {
  return el('section', { class: 'list folder-view' }, [
    el('header', {}, [el('span', { text: headerLabel }), el('span', { text: countLabel })]),
    ...children,
  ]);
}

function createShell(store, sw) {
  const status = el('span', { class: 'status', id: 'status' });
  const deniedHint = el('p', {
    class: 'alert',
    role: 'status',
    text: t('common.deniedHint'),
  });
  const scanBar = el('i');
  const scan = el(
    'div',
    {
      class: 'scan',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'data-testid': 'scan-progress',
      hidden: true,
    },
    scanBar,
  );
  const errorBox = el('p', { class: 'alert', role: 'alert' });

  const searchButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'search-open',
      'aria-label': t('search.label'),
    },
    [icon('search')],
  );

  const vipButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'vip-open',
      'aria-label': t('vip.open'),
    },
    [icon('crown')],
  );

  const settingsButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'settings-open',
      'aria-label': t('settings.open'),
    },
    [icon('gear')],
  );

  const closeButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'settings-close',
      'aria-label': t('settings.back'),
      hidden: true,
    },
    [icon('close')],
  );

  const header = el('header', { class: 'top' }, [
    el('div', { class: 'brand' }, [el('h1', { text: 'LocalTune' }), status]),
    el('div', { class: 'top-right' }, [
      searchButton,
      vipButton,
      settingsButton,
      closeButton,
    ]),
    scan,
  ]);

  // ---- player card ----
  const label = el('div', { class: 'label' });
  const vinyl = el('div', { class: 'vinyl', 'aria-hidden': 'true' }, label);
  const tonearm = el('div', { class: 'tonearm', 'aria-hidden': 'true' }, [
    el('span', { class: 'head' }),
  ]);
  const deck = el('div', { class: 'deck' }, [vinyl, tonearm]);
  const stage = el('div', { class: 'stage' }, deck);

  const title = el('h2', { text: t('player.noTrack') });
  const subtitle = el('p', { text: t('player.noTrackHint') });
  const meta = el('div', { class: 'meta' }, [title, subtitle]);

  const elapsed = el('time', { text: '0:00' });
  const total = el('time', { text: '0:00' });
  const barFill = el('i');
  const bar = el('div', {
    class: 'bar',
    role: 'slider',
    tabindex: '0',
    'aria-label': t('aria.progress'),
    'aria-valuemin': '0',
    'aria-valuemax': '0',
    'aria-valuenow': '0',
    'aria-valuetext': '0:00',
    'aria-disabled': 'true',
  }, barFill);
  const progress = el('div', { class: 'progress' }, [elapsed, bar, total]);

  const playIcon = icon('play');
  const pauseIcon = icon('pause');
  setHidden(pauseIcon, true);
  const shuffleButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': t('aria.shuffle'), 'aria-pressed': 'false', onclick: () => store.toggleShuffle() },
    icon('shuffle'),
  );
  const prevButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': t('aria.prev'), onclick: () => run(store.prev()) },
    icon('prev'),
  );
  const playButton = el(
    'button',
    { class: 'btn main', type: 'button', 'aria-label': t('aria.play'), onclick: () => store.toggle() },
    [playIcon, pauseIcon],
  );
  const nextButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': t('aria.next'), onclick: () => run(store.next()) },
    icon('next'),
  );
  const repeatBadge = el('span', { class: 'badge', 'aria-hidden': 'true' });
  const repeatButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': t('player.repeatOff'), onclick: () => store.cycleRepeat() },
    [icon('repeat'), repeatBadge],
  );
  // Lyrics are a build-time opt-in; with the flag off (the default) this whole
  // node is folded away by esbuild and the controls keep five buttons.
  const lyricsButton = LYRICS_ENABLED
    ? el('button', {
        class: 'btn-pill ghost lyrics-btn',
        type: 'button',
        'data-testid': 'lyrics-open',
        text: t('lyrics.open'),
        onclick: () => {
          const trackId = store.state.current.track?.id ?? null;
          store.setView('lyrics');
          if (trackId) void store.loadLyrics(trackId);
        },
      })
    : null;
  const controls = el('div', { class: 'controls' }, [
    shuffleButton,
    prevButton,
    playButton,
    nextButton,
    repeatButton,
    lyricsButton,
  ]);

  const player = el('section', { class: 'card player', 'aria-label': t('aria.nowPlaying') }, [
    stage,
    meta,
    progress,
    controls,
  ]);

  // ---- library ----
  const tabButtons = TABS.map(({ id, labelKey }) =>
    el('button', {
      id: `tab-${id}`,
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      'aria-controls': 'view-panel',
      text: t(labelKey),
      onclick: () => store.setView(id),
    }),
  );
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': t('aria.libraryViews') },
    tabButtons,
  );
  const panel = el('div', { id: 'view-panel', role: 'tabpanel', tabindex: '-1' });
  const library = el('section', { class: 'library', 'aria-label': t('aria.library') }, [tabs, panel]);

  // ---- playlists ----
  // The import button lives in the playlists view now; the callback reads the
  // dialog lazily, so creating the dialog right after this is safe.
  const playlistView = createPlaylistView(store, { onImport: () => importDialog.open() });
  const importDialog = createImportDialog(store);
  const vipView = createVipView(playlistView);

  // ---- settings view ----
  const settingsView = createSettingsView(store, sw);
  const settingsHost = el('div', { class: 'settings-host' }, settingsView.node);
  const vipHost = el('div', { class: 'vip-host', hidden: true }, vipView.node);
  const lyricsHost = LYRICS_ENABLED ? el('div', { class: 'lyrics-host', hidden: true }) : null;
  const defaultView = el('div', { class: 'default-view' }, [
    el('div', { class: 'player-col' }, [player]),
    library,
  ]);

  const updateBanner = el('div', { class: 'update-banner', role: 'status', hidden: true }, [
    el('span', { text: t('update.available') }),
    el('button', {
      class: 'btn-pill',
      type: 'button',
      text: t('update.apply'),
      'data-testid': 'update-apply',
      onclick: () => sw?.applyUpdate?.(),
    }),
  ]);

  const toast = el('div', { class: 'toast', role: 'status', hidden: true });

  const app = el('div', { class: 'app' }, [
    header,
    errorBox,
    deniedHint,
    el('main', { class: 'layout' }, [defaultView, settingsHost, vipHost]),
    updateBanner,
    toast,
    importDialog.node,
  ]);

  return {
    app,
    status,
    deniedHint,
    scan,
    scanBar,
    errorBox,
    player,
    label,
    title,
    subtitle,
    elapsed,
    total,
    bar,
    barFill,
    playIcon,
    pauseIcon,
    playButton,
    shuffleButton,
    repeatButton,
    repeatBadge,
    lyricsButton,
    searchButton,
    vipButton,
    settingsButton,
    closeButton,
    settingsView,
    settingsHost,
    vipView,
    vipHost,
    lyricsHost,
    playlistView,
    importDialog,
    defaultView,
    tabButtons,
    panel,
    updateBanner,
    toast,
  };
}

export function mountUi(root, store, sw) {
  let menuNode = null;
  let menuCleanup = null;
  let toastTimer = null;
  let renderedView = null;
  let ui = createShell(store, sw);

  // Search and the folder position live only in this UI closure, so a language
  // switch (which rebuilds the shell) starts from a clean folders view.
  let searchQuery = '';
  let searchResult = null;
  let searchTimer = 0;
  let searchToken = 0;
  let searchView = null;
  let folder = { source: null, dir: '' };
  let lyricsView = null;

  const last = {
    view: null,
    tracks: null,
    stats: null,
    currentId: null,
    queueTracks: null,
    queueIndex: -1,
    cover: undefined,
    permissions: null,
    installable: false,
    pins: null,
    query: '',
    folderSource: null,
    folderDir: '',
    searchResult: null,
  };

  // A rebuilt shell has an empty panel, so the view cache must forget
  // everything or renderView would skip the rebuild.
  function resetCache() {
    last.view = null;
    last.tracks = null;
    last.stats = null;
    last.currentId = null;
    last.queueTracks = null;
    last.queueIndex = -1;
    last.cover = undefined;
    last.permissions = null;
    last.installable = false;
    last.pins = null;
    last.query = '';
    last.folderSource = null;
    last.folderDir = '';
    last.searchResult = null;
    clearTimeout(searchTimer);
    searchTimer = 0;
    searchToken += 1;
    searchQuery = '';
    searchResult = null;
    searchView = null;
    folder = { source: null, dir: '' };
    lyricsView = null;
  }

  function showToast(text) {
    setText(ui.toast, text);
    setHidden(ui.toast, false);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      setHidden(ui.toast, true);
    }, 3000);
  }

  function closeMenu() {
    if (menuCleanup) menuCleanup();
    menuCleanup = null;
    menuNode?.remove();
    menuNode = null;
  }

  function openTrackMenu(track, anchor) {
    closeMenu();
    const menu = el('div', { class: 'menu', role: 'menu' }, [
      el('button', {
        class: 'menu-item',
        type: 'button',
        role: 'menuitem',
        text: t('diagnostics.title'),
        onclick: () => {
          closeMenu();
          openTagInfo(track, { loadReport: () => store.describeTrackTags(track.id) });
        },
      }),
    ]);
    menuNode = menu;
    document.body.append(menu);

    const rect = anchor?.getBoundingClientRect?.() ?? { top: 0, bottom: 0, right: 0 };
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(rect.right - width, 8), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? rect.top - height - 6 : below;
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;

    const onPointerDown = (event) => {
      if (!menu.contains(event.target)) closeMenu();
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    menuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }

  function bindShellEvents() {
    ui.settingsButton.addEventListener('click', () => store.setView('settings'));
    ui.searchButton.addEventListener('click', () => store.setView('search'));
    ui.vipButton.addEventListener('click', () => store.setView('vip'));
    ui.closeButton.addEventListener('click', () => store.setView('folders'));
    ui.settingsView.node.addEventListener('toast', (event) => {
      showToast(event.detail?.text ?? '');
    });
    ui.playlistView.node.addEventListener('toast', (event) => {
      showToast(event.detail?.text ?? '');
    });
    ui.importDialog.node.addEventListener('toast', (event) => {
      showToast(event.detail?.text ?? '');
    });
  }

  function renderHeader(state) {
    const rows = state.sources ?? [];
    const local = rows.find((row) => row.id === 'local') ?? { permission: 'none', name: '' };
    const migration = state.migration;
    const scanningRow = rows.find((row) => row.scanning) ?? null;

    if (migration?.running) {
      setText(
        ui.status,
        t('migration.progress', { done: migration.done ?? 0, total: migration.total ?? 0 }),
      );
    } else if (scanningRow) {
      const { done, total, phase } = scanningRow.progress ?? { done: 0, total: 0 };
      const caching = phase === 'cache' && total > 0;
      setText(
        ui.status,
        caching
          ? t('settings.source.caching', { done, total })
          : total > 0
            ? t('common.scanProgress', { done, total })
            : t('common.scanCount', { done }),
      );
    } else {
      setText(ui.status, '');
    }

    setHidden(ui.deniedHint, local.permission !== 'denied');

    setHidden(ui.scan, !scanningRow);
    if (scanningRow) {
      const { done, total } = scanningRow.progress ?? { done: 0, total: 0 };
      const ratio = total > 0 ? Math.min(done / total, 1) : 0.12;
      const percent = Math.round(ratio * 100);
      ui.scanBar.style.width = `${percent}%`;
      ui.scan.setAttribute('aria-valuenow', String(percent));
    } else {
      ui.scan.setAttribute('aria-valuenow', '0');
    }

    const error = rows.find((row) => row.error)?.error ?? null;
    setHidden(ui.errorBox, !error);
    if (error) setText(ui.errorBox, typeof error === 'string' ? error : error.message ?? String(error));
  }

  /** One place decides which header action is visible for the current view. */
  function applyHeaderMode(state) {
    const mode =
      state.view === 'settings' ? 'settings' : state.view === 'vip' ? 'vip' : 'default';
    const isDefault = mode === 'default';
    setHidden(ui.searchButton, !isDefault);
    setHidden(ui.vipButton, !isDefault);
    setHidden(ui.settingsButton, !isDefault);
    setHidden(ui.closeButton, isDefault);
    setHidden(ui.status, !isDefault || !ui.status.textContent);
  }

  function renderPlayer(state) {
    const { current, queue } = state;
    const track = current.track;
    const duration = current.duration || track?.duration || 0;
    const position = Math.min(Math.max(current.position || 0, 0), duration || 0);
    const playing = Boolean(track) && current.playing;

    ui.player.classList.toggle('playing', playing);

    const cover = track?.cover ?? null;
    if (cover !== last.cover) {
      const url = coverUrl(cover);
      ui.label.style.backgroundImage = url ? `url("${url}")` : '';
      last.cover = cover;
    }

    setText(ui.title, track ? track.title : t('player.noTrack'));
    setText(ui.subtitle, track ? subtitleOf(track) : t('player.noTrackHint'));

    setText(ui.elapsed, formatTime(position));
    setText(ui.total, formatTime(duration));
    const ratio = duration > 0 ? Math.min(position / duration, 1) : 0;
    ui.barFill.style.width = `${(ratio * 100).toFixed(2)}%`;

    ui.bar.setAttribute('aria-valuemax', String(Math.round(duration)));
    ui.bar.setAttribute('aria-valuenow', String(Math.round(position)));
    ui.bar.setAttribute('aria-valuetext', `${formatTime(position)} / ${formatTime(duration)}`);
    ui.bar.setAttribute('aria-disabled', String(!track || duration <= 0));

    const label = playing ? t('aria.pause') : t('aria.play');
    if (ui.playButton.getAttribute('aria-label') !== label) {
      ui.playButton.setAttribute('aria-label', label);
    }
    setHidden(ui.playIcon, playing);
    setHidden(ui.pauseIcon, !playing);
    ui.playButton.disabled = !track;
    if (LYRICS_ENABLED) ui.lyricsButton.disabled = !track;

    ui.shuffleButton.classList.toggle('is-on', queue.shuffle);
    ui.shuffleButton.setAttribute('aria-pressed', String(queue.shuffle));

    ui.repeatButton.classList.toggle('is-on', queue.repeat !== 'off');
    ui.repeatButton.setAttribute(
      'aria-label',
      t(REPEAT_LABEL_KEY[queue.repeat] ?? REPEAT_LABEL_KEY.off),
    );
    setText(ui.repeatBadge, REPEAT_BADGE[queue.repeat] ?? '');
  }

  function renderTabs(state) {
    const selectedView = TABS.some((tab) => tab.id === state.view) ? state.view : null;
    ui.tabButtons.forEach((button, index) => {
      const selected = TABS[index].id === selectedView;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('is-active', selected);
    });
    if (selectedView) ui.panel.setAttribute('aria-labelledby', `tab-${selectedView}`);
    else ui.panel.removeAttribute('aria-labelledby');
  }

  function renderEmpty(state) {
    const local = state.sources.find((row) => row.id === 'local') ?? { permission: 'none', name: '' };
    const anyGranted = state.sources.some((row) => row.permission === 'granted');
    const name = local.name || t('common.musicFolder');

    if (!anyGranted) {
      if (local.permission === 'denied') {
        return emptyState({
          title: t('empty.deniedTitle'),
          text: t('empty.deniedText'),
          actionLabel: t('common.reauthorize'),
          onAction: () => run(store.connectSource()),
        });
      }
      if (local.permission === 'prompt') {
        return emptyState({
          title: t('empty.promptTitle'),
          text: t('empty.promptText'),
          actionLabel: t('common.continueWith', { name }),
          onAction: () => run(store.requestSourcePermission()),
          note: [t('empty.promptNote'), installHint()],
        });
      }
      return emptyState({
        title: t('empty.chooseTitle'),
        text: t('empty.chooseText'),
        actionLabel: t('empty.chooseAction'),
        onAction: () => store.setView('settings'),
      });
    }

    const kind = local.permission === 'granted' ? 'local' : 'onedrive';
    return emptyState({
      title: t('empty.noTracksTitle'),
      text: t('empty.noTracksText'),
      actionLabel: t('empty.noTracksAction'),
      onAction: () => run(store.rescan(kind)),
    });
  }

  // ---- search view ----
  function rerunQuery() {
    searchToken += 1;
    const token = searchToken;
    searchResult = null;
    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) {
      render(store.state);
      return;
    }
    run(
      runSearch(store.state.tracks ?? [], query).then((result) => {
        if (token !== searchToken) return;
        searchResult = { query, items: result.items, total: result.total };
        render(store.state);
      }),
    );
    render(store.state);
  }

  function setQuery(value) {
    searchQuery = value;
    rerunQuery();
  }

  function ensureSearchView() {
    if (searchView) return searchView;

    const input = el('input', {
      class: 'search-input',
      type: 'search',
      'data-testid': 'search-input',
      'aria-label': t('search.label'),
      placeholder: t('search.placeholder'),
    });
    const clearButton = el('button', {
      class: 'search-clear',
      type: 'button',
      'data-testid': 'search-clear',
      'aria-label': t('search.clear'),
      text: '×',
      hidden: true,
      onclick: () => {
        input.value = '';
        setQuery('');
      },
    });
    const countLine = el('p', { class: 'search-count', 'data-testid': 'search-count' });
    const listBox = el('div', { class: 'search-results' });
    const root = el('div', { class: 'search-view' }, [
      el('div', { class: 'search-bar' }, [input, clearButton]),
      countLine,
      listBox,
    ]);

    input.addEventListener('input', () => {
      const value = input.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = 0;
        setQuery(value);
      }, SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      input.value = '';
      clearTimeout(searchTimer);
      searchTimer = 0;
      setQuery('');
    });

    searchView = { root, input, clearButton, countLine, listBox };
    return searchView;
  }

  function renderSearch(state) {
    const view = ensureSearchView();
    if (ui.panel.firstElementChild !== view.root) ui.panel.replaceChildren(view.root);

    setHidden(view.clearButton, !searchQuery);

    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) {
      // A blank query shows nothing: the search bar is the whole view.
      setHidden(view.countLine, true);
      view.listBox.replaceChildren();
      return;
    }

    const result = searchResult;
    if (!result || result.query !== query) {
      // The debounced search has not resolved yet; keep the previous frame's
      // rows out of the DOM so a stale result never answers a new query.
      setHidden(view.countLine, true);
      view.listBox.replaceChildren();
      return;
    }

    setHidden(view.countLine, false);
    setText(view.countLine, t('search.results', { count: result.total }));
    if (result.total === 0) {
      view.listBox.replaceChildren(
        el('p', { class: 'muted', 'data-testid': 'search-empty', text: t('search.empty') }),
      );
      return;
    }

    const currentId = state.current.track?.id ?? null;
    const rowFor = (track) =>
      trackRow(track, {
        now: track.id === currentId,
        onActivate: () => run(store.playQueue(state.tracks, track.id)),
        onMore: openTrackMenu,
      });

    const sections = [];
    for (const group of SEARCH_GROUPS) {
      const hits = result.items.filter((item) => item.group === group.id);
      if (!hits.length) continue;
      sections.push(
        el('section', { class: 'list' }, [
          el('h3', { 'data-testid': `search-group-${group.id}`, text: t(group.labelKey) }),
          el('ul', { class: 'rows' }, hits.map((item) => rowFor(item.track))),
        ]),
      );
    }
    view.listBox.replaceChildren(...sections);
  }

  // ---- folders view ----
  function trackKind(track) {
    return track.source === 'onedrive' ? 'onedrive' : 'local';
  }

  /** Source rows name the source, never the folder the user happened to pick. */
  function sourceDisplayName(state, kind) {
    return kind === 'onedrive'
      ? t('settings.source.onedrive')
      : t('settings.library.localGroup');
  }

  function sourceLabel(state, kind) {
    return sourceDisplayName(state, kind);
  }

  function kindTracks(state, kind) {
    return (state.tracks ?? []).filter((track) => trackKind(track) === kind);
  }

  function shuffleOf(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /** Pin progress row state for one directory across every source it holds. */
  function pinInfo(state, sources, dir) {
    const pins = sources
      .map((source) => (state.pins ?? []).find((pin) => pin.id === `${source}:${dir}`))
      .filter(Boolean);
    if (pins.some((pin) => pin.running)) {
      return {
        running: true,
        done: pins.reduce((sum, item) => sum + (item.done ?? 0), 0),
        total: pins.reduce((sum, item) => sum + (item.total ?? 0), 0),
      };
    }
    return { error: pins.find((item) => item.error)?.error ?? null };
  }

  function pinToggle(list, dir) {
    const sources = [...new Set(list.map((track) => track.source))];
    const pinned =
      sources.length > 0 && sources.every((source) => store.isPinned(source, dir));
    return () => {
      for (const source of sources) {
        if (pinned) {
          run(store.unpinFolder(`${source}:${dir}`));
          continue;
        }
        run(
          store.pinFolder({
            source,
            dir,
            trackIds: list.filter((track) => track.source === source).map((track) => track.id),
          }),
        );
      }
    };
  }

  function pinFor(state, list, dir, testId) {
    const sources = [...new Set(list.map((track) => track.source))];
    const pinned =
      sources.length > 0 && sources.every((source) => store.isPinned(source, dir));
    const parts = pinRowParts({
      pinned,
      pin: pinInfo(state, sources, dir),
      testId,
      onToggle: pinToggle(list, dir),
    });
    return { pinned, parts };
  }

  function folderHeader(state, kind, dir, all) {
    const up = el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'data-testid': 'folder-up',
        'aria-label': t('common.back'),
        onclick: () => {
          if (dir === '') {
            folder = { source: null, dir: '' };
          } else {
            const cut = dir.lastIndexOf('/');
            folder = { source: kind, dir: cut < 0 ? '' : dir.slice(0, cut) };
          }
          render(store.state);
        },
      },
      [el('span', { class: 'back-arrow', 'aria-hidden': 'true', text: '←' })],
    );

    const { parts } = pinFor(state, all, dir, `pin-${dir || 'root'}`);

    return el('div', { class: 'folder-head' }, [
      up,
      el('span', { class: 'folder-name', text: dir || sourceLabel(state, kind) }),
      el('div', { class: 'folder-actions' }, [
        el('button', {
          class: 'btn-pill',
          type: 'button',
          'data-testid': 'folder-play-all',
          text: t('common.playAll'),
          disabled: !all.length,
          onclick: () => {
            if (all.length) run(store.playQueue(all, all[0].id));
          },
        }),
        el('button', {
          class: 'btn-pill ghost',
          type: 'button',
          'data-testid': 'folder-shuffle',
          text: t('common.shufflePlay'),
          disabled: !all.length,
          onclick: () => {
            if (!all.length) return;
            const shuffled = shuffleOf(all);
            run(store.playQueue(shuffled, shuffled[0].id));
          },
        }),
        parts.button,
      ]),
    ]);
  }

  /** Refresh the grant when only the token expired; sign in when signed out. */
  function reconnectAction(row) {
    return () =>
      run(row?.permission === 'prompt' ? store.reauthenticateOneDrive() : store.connectOneDrive());
  }

  function renderFolders(state) {
    if (folder.source === null) {
      const rows = [];
      for (const row of visibleSources(state.sources)) {
        const list = kindTracks(state, row.id);
        const needsReconnect = sourceNeedsReconnect(row);
        rows.push(
          sourceRow({
            id: row.id,
            label: sourceDisplayName(state, row.id),
            count: list.length,
            needsReconnect,
            onReconnect: needsReconnect ? reconnectAction(row) : null,
            onOpen: () => {
              folder = { source: row.id, dir: '' };
              render(store.state);
            },
          }),
        );
      }

      ui.panel.replaceChildren(
        folderSection(
          t('tabs.folders'),
          t('common.trackCount', { count: state.tracks.length }),
          rows.length
            ? [el('ul', { class: 'rows' }, rows)]
            : [el('p', { class: 'muted', 'data-testid': 'folder-empty', text: t('autoList.empty') })],
        ),
      );
      return;
    }

    const kind = folder.source;
    const dir = folder.dir;
    const list = kindTracks(state, kind);
    const all = tracksUnder(list, dir);
    const direct = tracksDirect(list, dir);
    const subs = subdirsOf(list, dir);

    const dirRows = subs.map((entry) => {
      const subTracks = tracksUnder(list, entry.dir);
      const { pinned, parts } = pinFor(state, subTracks, entry.dir, `pin-${entry.dir}`);
      const hit = el(
        'button',
        {
          class: 'row-hit',
          type: 'button',
          'data-testid': `folder-dir-${entry.dir}`,
          onclick: () => {
            folder = { source: kind, dir: entry.dir };
            render(store.state);
          },
        },
        [
          artNode(null),
          el('span', { class: 't' }, [
            el('b', { text: entry.name }),
            el('span', { text: t('common.trackCount', { count: entry.count }) }),
          ]),
        ],
      );
      return el('li', { class: pinned ? 'row is-pinned' : 'row' }, [hit, parts.status, parts.button]);
    });

    const currentId = state.current.track?.id ?? null;
    const trackRows = direct.map((track) =>
      trackRow(track, {
        now: track.id === currentId,
        onActivate: () => run(store.playQueue(all, track.id)),
        onMore: openTrackMenu,
      }),
    );

    const children = [folderHeader(state, kind, dir, all)];
    const sourceState = (state.sources ?? []).find((row) => row.id === kind) ?? null;
    if (sourceNeedsReconnect(sourceState)) {
      children.push(
        el('p', { class: 'alert', 'data-testid': `folder-reconnect-${kind}` }, [
          el('span', { text: t('library.expiredHint') }),
          el('button', {
            class: 'btn-pill ghost',
            type: 'button',
            'data-testid': `folder-reconnect-button-${kind}`,
            text: t('library.reconnect'),
            onclick: reconnectAction(sourceState),
          }),
        ]),
      );
    }
    if (subs.length) {
      children.push(el('h3', { class: 'folder-subhead', text: t('folders.subfolders') }));
      children.push(el('ul', { class: 'rows' }, dirRows));
    }
    if (direct.length) {
      children.push(el('h3', { class: 'folder-subhead', text: t('folders.tracks') }));
      children.push(el('ul', { class: 'rows' }, trackRows));
    }
    if (!subs.length && !direct.length) {
      children.push(el('p', { class: 'muted', 'data-testid': 'folder-empty', text: t('autoList.empty') }));
    }

    ui.panel.replaceChildren(
      folderSection(t('tabs.folders'), t('common.trackCount', { count: all.length }), children),
    );
  }

  // ---- lyrics view (build-time opt-in; the default build drops this block) ----
  let buildLyricsView = null;
  let ensureLyricsView = null;
  let renderLyrics = null;

  if (LYRICS_ENABLED) {
    buildLyricsView = () => {
      const backButton = el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'data-testid': 'lyrics-back',
          'aria-label': t('lyrics.back'),
          onclick: () => store.setView('folders'),
        },
        [el('span', { class: 'back-arrow', 'aria-hidden': 'true', text: '←' })],
      );
      const headText = el('div', { class: 'lyrics-head-text' }, [
        el('h2', { text: t('lyrics.title') }),
        el('p', { class: 'lyrics-track' }),
      ]);
      const linesBox = el('div', { class: 'lyrics', 'data-testid': 'lyrics-lines' });
      const root = el(
        'section',
        { class: 'settings-view lyrics-view', 'data-testid': 'lyrics-view' },
        [el('div', { class: 'settings-head lyrics-head' }, [backButton, headText]), linesBox],
      );
      return {
        root,
        trackLine: headText.lastElementChild,
        linesBox,
        rows: [],
        active: -1,
        key: null,
        linesRef: null,
        plain: null,
      };
    };

    ensureLyricsView = () => {
      if (!lyricsView) lyricsView = buildLyricsView();
      if (ui.lyricsHost.firstElementChild !== lyricsView.root) {
        ui.lyricsHost.replaceChildren(lyricsView.root);
      }
      return lyricsView;
    };

    renderLyrics = (state) => {
      if (state.view !== 'lyrics') return;
      const view = ensureLyricsView();
      const track = state.current.track;
      setText(view.trackLine, track ? `${track.title} · ${subtitleOf(track)}` : t('player.noTrack'));

      const lyrics = state.lyrics ?? {};
      const lines = Array.isArray(lyrics.lines) ? lyrics.lines : [];
      const key = `${lyrics.trackId ?? ''}|${lyrics.source ?? 'none'}|${lyrics.loading ? 1 : 0}`;
      if (view.key !== key || view.linesRef !== lines || view.plain !== lyrics.plain) {
        view.key = key;
        view.linesRef = lines;
        view.plain = lyrics.plain;
        view.active = -1;
        view.rows = [];
        view.linesBox.replaceChildren();
        if (lyrics.loading) {
          view.linesBox.append(el('p', { class: 'muted', text: t('lyrics.loading') }));
        } else if (lines.length) {
          for (const line of lines) {
            const node = el('p', {
              class: 'lyric-line',
              'data-testid': 'lyric-line',
              'data-time': String(line.time),
              text: line.text,
            });
            view.rows.push(node);
            view.linesBox.append(node);
          }
        } else if (lyrics.plain) {
          view.linesBox.append(el('pre', { 'data-testid': 'lyrics-plain', text: lyrics.plain }));
        } else {
          view.linesBox.append(
            el('p', { class: 'muted', 'data-testid': 'lyrics-empty', text: t('lyrics.empty') }),
          );
        }
      }

      const index = lines.length ? activeLineIndex(lines, state.current.position) : -1;
      if (index === view.active) return;
      const previous = view.rows[view.active];
      if (previous) {
        previous.classList.remove('is-active');
        previous.removeAttribute('aria-current');
      }
      const next = view.rows[index];
      if (next) {
        next.classList.add('is-active');
        next.setAttribute('aria-current', 'true');
        if (next.isConnected) next.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      view.active = index;
    };
  }

  function renderView(state) {
    if (state.view === 'settings' || state.view === 'vip') return;
    if (LYRICS_ENABLED && state.view === 'lyrics') {
      ensureLyricsView();
      return;
    }
    const currentId = state.current.track?.id ?? null;
    const queueView = state.view === 'queue';
    const permissions = (state.sources ?? [])
      .map((row) => `${row.permission}:${row.trackCount ?? 0}`)
      .join(',');
    const rebuild =
      state.view !== last.view ||
      state.tracks !== last.tracks ||
      state.stats !== last.stats ||
      permissions !== last.permissions ||
      installPromptSeen !== last.installable ||
      currentId !== last.currentId ||
      state.pins !== last.pins ||
      searchQuery !== last.query ||
      searchResult !== last.searchResult ||
      folder.source !== last.folderSource ||
      folder.dir !== last.folderDir ||
      (queueView &&
        (state.queue.tracks !== last.queueTracks || state.queue.index !== last.queueIndex));

    if (!rebuild) return;

    last.view = state.view;
    last.tracks = state.tracks;
    last.stats = state.stats;
    last.permissions = permissions;
    last.installable = installPromptSeen;
    last.currentId = currentId;
    last.pins = state.pins;
    last.query = searchQuery;
    last.searchResult = searchResult;
    last.folderSource = folder.source;
    last.folderDir = folder.dir;
    last.queueTracks = state.queue.tracks;
    last.queueIndex = state.queue.index;

    syncCoverCache(state.tracks.map((track) => track.cover).filter(Boolean));

    if (!libraryVisible(state)) {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    // Granted sources own their rows even when the library holds no track.
    if (state.view === 'folders') {
      renderFolders(state);
      return;
    }

    if (!state.tracks.length) {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    if (queueView) {
      const tracks = state.queue.tracks;
      if (!tracks.length) {
        ui.panel.replaceChildren(
          emptyState({
            title: t('empty.queueTitle'),
            text: t('empty.queueText'),
            actionLabel: t('empty.queueAction'),
            onAction: () => store.setView('folders'),
          }),
        );
        return;
      }
      const rows = tracks.map((track, index) =>
        queueRow(track, index, {
          now: index === state.queue.index,
          onActivate: () => run(store.jumpTo(index)),
          onRemove: () => store.removeQueueAt(index),
        }),
      );
      const head = el('header', {}, [
        el('span', { text: t('common.playQueue') }),
        el('div', { class: 'queue-head' }, [
          el('span', { text: t('common.trackCount', { count: tracks.length }) }),
          el('button', {
            class: 'btn-pill ghost queue-clear',
            type: 'button',
            'data-testid': 'queue-clear',
            text: t('queue.clear'),
            onclick: () => {
              if (typeof window !== 'undefined' && !window.confirm(t('queue.clearConfirm'))) return;
              store.clearQueue();
            },
          }),
        ]),
      ]);
      ui.panel.replaceChildren(
        el('section', { class: 'list' }, [head, el('ul', { class: 'rows' }, rows)]),
      );
      return;
    }

    renderSearch(state);
  }

  function render(state) {
    const next = resolveLanguage(state.settings.language, navigator.languages);
    if (next !== getLocale()) {
      setLocale(next);
      applyDocumentLang();
      remount();
      return;
    }
    if (renderedView !== state.view) {
      renderedView = state.view;
      closeMenu();
    }
    renderHeader(state);
    applyHeaderMode(state);
    renderPlayer(state);
    renderTabs(state);
    renderView(state);
    ui.settingsView.render(state);
    if (state.pendingView) {
      const pending = state.pendingView;
      if (pending.view === 'settings') {
        const section = ui.settingsView.node.querySelector(
          '[data-testid="settings-section-library"]',
        );
        section?.scrollIntoView({ block: 'start' });
        if (pending.picker === 'onedrive') {
          const picker = ui.settingsView.node.querySelector('[data-testid="onedrive-picker"]');
          if (picker) picker.focus({ preventScroll: true });
        }
      }
      store.clearPendingView();
    }
    if (LYRICS_ENABLED && state.view === 'lyrics') {
      // A track change inside the lyrics view resolves once; the store sets
      // `lyrics.trackId` synchronously, so the 4 Hz position updates do not
      // issue another request.
      const trackId = state.current.track?.id ?? null;
      if (trackId && state.lyrics?.trackId !== trackId) void store.loadLyrics(trackId);
      renderLyrics(state);
    }
    const settings = state.view === 'settings';
    const vip = state.view === 'vip';
    const lyrics = state.view === 'lyrics';
    setHidden(ui.defaultView, settings || vip || lyrics);
    setHidden(ui.settingsHost, !settings);
    setHidden(ui.vipHost, !vip);
    if (vip) ui.vipView.render(state);
    if (LYRICS_ENABLED) setHidden(ui.lyricsHost, !lyrics);
    setHidden(ui.updateBanner, !state.updateReady);

    // rescan() re-matched missing playlist rows: announce the count once and
    // clear the notice so the next render does not repeat it.
    const rematchAdded = Number(state.rematch?.added) || 0;
    if (rematchAdded > 0) {
      if (rematchAdded !== lastRematchAdded) {
        lastRematchAdded = rematchAdded;
        showToast(t('playlists.rematchAdded', { count: rematchAdded }));
      }
      store.clearRematchNotice();
    } else {
      lastRematchAdded = 0;
    }
  }

  function remount() {
    closeMenu();
    clearTimeout(toastTimer);
    toastTimer = null;
    ui = createShell(store, sw);
    resetCache();
    bindShellEvents();
    bindSeek();
    root.replaceChildren(ui.app);
    render(store.state);
  }

  // Seeking: pointer position → seconds; keyboard for the slider role.
  function seekFromPointer(event) {
    const duration = store.state.current.duration || store.state.current.track?.duration || 0;
    if (duration <= 0) return;
    const rect = ui.bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    run(store.seek(ratio * duration));
  }

  function seekFromKeyboard(event) {
    const duration = store.state.current.duration || store.state.current.track?.duration || 0;
    if (duration <= 0) return;
    const position = store.state.current.position || 0;
    let target = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = position + SEEK_STEP;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = position - SEEK_STEP;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = duration;
    if (target == null) return;
    event.preventDefault();
    run(store.seek(Math.min(Math.max(target, 0), duration)));
  }

  // Re-bound on every remount: the slider node is replaced with the shell.
  function bindSeek() {
    ui.bar.addEventListener('click', seekFromPointer);
    ui.bar.addEventListener('keydown', seekFromKeyboard);
  }

  bindShellEvents();
  bindSeek();
  root.replaceChildren(ui.app);
  render(store.state);

  // Fires after the first render in practice, so re-render with the hint.
  window.addEventListener('beforeinstallprompt', () => {
    installPromptSeen = true;
    render(store.state);
  });

  let frame = 0;
  store.addEventListener('change', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render(store.state);
    });
  });
}
