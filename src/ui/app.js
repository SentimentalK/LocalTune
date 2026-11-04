/**
 * Full page UI for LocalTune. Renders once, then patches the persistent shell
 * on every store change (coalesced into one requestAnimationFrame). Only the
 * active view is rebuilt, and only when its inputs change, so a 4 Hz
 * timeupdate does not recreate a thousand-row library.
 */

import { groupByAlbum, groupByArtist, formatTime } from '../core/selectors.js';
import { groupByFolder } from '../core/folders.js';
import { runSearch } from '../core/search.js';
import { recentlyAdded, mostPlayed, neverPlayed } from '../core/stats.js';
import { activeLineIndex } from '../core/lyrics/lrc.js';
import { el, icon, coverUrl, syncCoverCache, setText, setHidden } from './dom.js';
import { createSettingsView } from './settings.js';
import { createImportDialog, createPlaylistView } from './playlist.js';
import { openTagInfo } from './diagnostics.js';
import { applyDocumentLang, getLocale, resolveLanguage, setLocale, t } from '../i18n/index.js';

const TABS = [
  { id: 'tracks', labelKey: 'tabs.tracks' },
  { id: 'albums', labelKey: 'tabs.albums' },
  { id: 'artists', labelKey: 'tabs.artists' },
  { id: 'folders', labelKey: 'tabs.folders' },
  { id: 'playlists', labelKey: 'tabs.playlists' },
  { id: 'queue', labelKey: 'tabs.queue' },
];

const REPEAT_LABEL_KEY = {
  off: 'player.repeatOff',
  all: 'player.repeatAll',
  one: 'player.repeatOne',
};
const REPEAT_BADGE = { off: '', all: '∞', one: '1' };
const SEEK_STEP = 5;

/** Auto lists in display order; ids double as `autoList.<id>` keys. */
const AUTO_LISTS = ['all', 'recent', 'most', 'never'];

const AUTO_LIST_TESTID = {
  all: 'auto-list-all',
  recent: 'auto-list-recent',
  most: 'auto-list-most',
  never: 'auto-list-never',
};

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
  const row = el('li', { class: now ? 'row now' : 'row' }, [hit, more]);
  bindRowMenu(row, track, more, onMore);
  return row;
}

function queueRow(track, index, { now, onActivate, onRemove, onMore }) {
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
  const more = moreButton(track, onMore);
  const row = el('li', { class: now ? 'row queue now' : 'row queue' }, [hit, remove, more]);
  bindRowMenu(row, track, more, onMore);
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

function folderRow(group, { onPlay, onEnqueue, onPin, pinned = false, pin = null }) {
  const label = group.dir || t('common.rootFolder');
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': t('aria.playFolder', { name: label }),
      onclick: onPlay,
    },
    [
      artNode(null),
      el('span', { class: 't' }, [
        el('b', { text: label }),
        el('span', { text: t('common.trackCount', { count: group.count }) }),
      ]),
    ],
  );
  const add = el('button', {
    class: 'row-add',
    type: 'button',
    text: t('common.addToQueue'),
    'aria-label': t('aria.enqueueFolder', { name: label }),
    onclick: onEnqueue,
  });

  const pinState = pin ?? {};
  const pinStatus = el('span', { class: 'row-pin-status' });
  if (pinState.running) {
    setText(
      pinStatus,
      t('settings.storage.pinning', {
        done: pinState.done ?? 0,
        total: pinState.total ?? 0,
      }),
    );
  } else if (pinState.error) {
    setText(pinStatus, pinState.error);
  } else if (pinned) {
    setText(pinStatus, t('settings.storage.pinned'));
  } else {
    setHidden(pinStatus, true);
  }

  const pinButton = el(
    'button',
    {
      class: pinned ? 'row-pin is-on' : 'row-pin',
      type: 'button',
      'data-testid': `pin-${group.dir || 'root'}`,
      'aria-pressed': String(pinned),
      'aria-label': pinned ? t('settings.storage.unpin') : t('settings.storage.pin'),
      'title': pinned ? t('settings.storage.unpin') : t('settings.storage.pin'),
      disabled: Boolean(pinState.running),
      onclick: onPin,
    },
    [pinIcon()],
  );

  return el('li', { class: pinned ? 'row is-pinned' : 'row' }, [
    hit,
    pinStatus,
    add,
    pinButton,
  ]);
}

function listSection(headerLabel, countLabel, rows) {
  return el('section', { class: 'list' }, [
    el('header', {}, [
      el('span', { text: headerLabel }),
      el('span', { text: countLabel }),
    ]),
    el('ul', { class: 'rows' }, rows),
  ]);
}

function cardItem({ title, meta, cover, label, onPlay }) {
  return el('li', {}, [
    el(
      'button',
      { class: 'card-item', type: 'button', 'aria-label': label, onclick: onPlay },
      [
        artNode(cover, 'art'),
        el('b', { text: title }),
        el('span', { class: 'card-meta', text: meta }),
      ],
    ),
  ]);
}

function createShell(store, sw) {
  const status = el('span', { class: 'status', id: 'status', text: t('common.ready') });
  const count = el('span', { class: 'count', text: t('common.trackCount', { count: 0 }) });
  const sourceName = el('span', { class: 'source-name', text: t('common.disconnected') });
  const authButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    text: t('common.chooseFolder'),
    onclick: () => {
      const local = store.state.sources.find((row) => row.id === 'local');
      const permission = local?.permission ?? 'none';
      run(permission === 'prompt' ? store.requestSourcePermission() : store.connectSource());
    },
  });
  const deniedHint = el('p', {
    class: 'alert',
    role: 'status',
    text: t('common.deniedHint'),
  });
  const scanBar = el('i');
  const scan = el('div', { class: 'scan', role: 'status' }, [
    el('span', { class: 'scan-label', text: t('common.scanning') }),
    el('div', { class: 'bar' }, scanBar),
  ]);
  const errorBox = el('p', { class: 'alert', role: 'alert' });

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

  const header = el('header', { class: 'top' }, [
    el('div', { class: 'brand' }, [el('h1', { text: 'LocalTune' }), status]),
    el('div', { class: 'top-right' }, [count, sourceName, authButton, settingsButton]),
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
  const lyricsButton = el('button', {
    class: 'btn-pill ghost lyrics-btn',
    type: 'button',
    'data-testid': 'lyrics-open',
    text: t('lyrics.open'),
    onclick: () => {
      const trackId = store.state.current.track?.id ?? null;
      store.setView('lyrics');
      if (trackId) void store.loadLyrics(trackId);
    },
  });
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
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': t('aria.libraryViews') }, [
    ...tabButtons,
    el('button', {
      class: 'btn-pill tabs-import',
      type: 'button',
      'data-testid': 'import-open',
      text: t('playlists.import'),
      onclick: () => importDialog.open(),
    }),
  ]);
  const panel = el('div', { id: 'view-panel', role: 'tabpanel', tabindex: '-1' });
  const library = el('section', { class: 'library', 'aria-label': t('aria.library') }, [tabs, panel]);

  // ---- playlists ----
  const playlistView = createPlaylistView(store);
  const importDialog = createImportDialog(store);

  // ---- settings view ----
  const settingsView = createSettingsView(store, sw);
  const settingsHost = el('div', { class: 'settings-host' }, settingsView.node);
  const lyricsHost = el('div', { class: 'lyrics-host', hidden: true });
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
    scan,
    deniedHint,
    el('main', { class: 'layout' }, [defaultView, settingsHost, lyricsHost]),
    updateBanner,
    toast,
    importDialog.node,
  ]);

  return {
    app,
    status,
    count,
    sourceName,
    authButton,
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
    settingsButton,
    settingsView,
    settingsHost,
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
  let prevView = 'tracks';
  let menuNode = null;
  let menuCleanup = null;
  let toastTimer = null;
  let renderedView = null;
  let ui = createShell(store, sw);

  // Search and auto lists live only in this UI closure, so a language switch
  // (which rebuilds the shell) starts from a clean tracks view.
  let searchQuery = '';
  let activeList = 'all';
  let searchResult = null;
  let searchTimer = 0;
  let searchToken = 0;
  let tracksView = null;
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
    playlists: null,
    query: '',
    list: 'all',
    searchResult: null,
    lyricsSource: null,
    lyricsLines: null,
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
    last.playlists = null;
    last.query = '';
    last.list = 'all';
    last.searchResult = null;
    last.lyricsSource = null;
    last.lyricsLines = null;
    clearTimeout(searchTimer);
    searchTimer = 0;
    searchToken += 1;
    searchQuery = '';
    activeList = 'all';
    searchResult = null;
    tracksView = null;
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
    ui.settingsButton.addEventListener('click', () => {
      if (store.state.view !== 'settings') prevView = store.state.view;
      store.setView('settings');
    });
    ui.settingsView.node.addEventListener('settings-back', () => {
      store.setView(prevView || 'tracks');
    });
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
    const onedrive = rows.find((row) => row.id === 'onedrive') ?? { permission: 'none', name: '' };
    const migration = state.migration;
    const scanningRow = rows.find((row) => row.scanning) ?? null;

    if (migration?.running) {
      setText(
        ui.status,
        t('migration.progress', { done: migration.done ?? 0, total: migration.total ?? 0 }),
      );
    } else if (scanningRow) {
      const { done, total } = scanningRow.progress ?? { done: 0, total: 0 };
      setText(
        ui.status,
        total > 0
          ? t('common.scanProgress', { done, total })
          : t('common.scanCount', { done }),
      );
    } else {
      setText(ui.status, state.ready ? t('common.ready') : t('common.loading'));
    }

    setText(ui.count, t('common.trackCount', { count: state.tracks.length }));

    const granted = [local, onedrive].find((row) => row.permission === 'granted');
    let nameText;
    if (granted) nameText = granted.name || t('common.connected');
    else if (local.permission === 'denied') nameText = t('common.permissionDenied');
    else if (local.permission === 'prompt' || onedrive.permission === 'prompt') {
      nameText = t('common.awaitingPermission');
    } else nameText = t('common.disconnected');
    setText(ui.sourceName, nameText);

    setHidden(ui.authButton, local.permission === 'granted');
    setText(
      ui.authButton,
      local.permission === 'none'
        ? t('common.chooseFolder')
        : local.permission === 'prompt'
          ? t('common.continueWith', { name: local.name || t('common.musicFolder') })
          : t('common.reauthorize'),
    );
    setHidden(ui.deniedHint, local.permission !== 'denied');

    setHidden(ui.scan, !scanningRow);
    if (scanningRow) {
      const { done, total } = scanningRow.progress ?? { done: 0, total: 0 };
      const ratio = total > 0 ? Math.min(done / total, 1) : 0.12;
      ui.scanBar.style.width = `${Math.round(ratio * 100)}%`;
    }

    const error = rows.find((row) => row.error)?.error ?? null;
    setHidden(ui.errorBox, !error);
    if (error) setText(ui.errorBox, typeof error === 'string' ? error : error.message ?? String(error));
  }

  function sourcePermission(state, track) {
    const kind = track?.source === 'onedrive' ? 'onedrive' : 'local';
    const row = (state.sources ?? []).find((item) => item.id === kind);
    return row?.permission ?? 'none';
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
    ui.playButton.disabled = !track || sourcePermission(state, track) !== 'granted';
    ui.lyricsButton.disabled = !track;

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
        actionLabel: t('common.chooseFolder'),
        onAction: () => run(store.connectSource()),
        secondaryLabel: t('empty.onedriveAction'),
        onSecondary: () => run(store.connectOneDrive()),
        secondaryTestId: 'empty-onedrive',
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

  // ---- tracks view: search + auto lists ----
  function listTracks(state) {
    const tracks = state.tracks ?? [];
    if (activeList === 'recent') return recentlyAdded(tracks, state.stats, 50);
    if (activeList === 'most') return mostPlayed(tracks, state.stats, 50);
    if (activeList === 'never') return neverPlayed(tracks, state.stats);
    return tracks;
  }

  function rerunQuery() {
    searchToken += 1;
    const token = searchToken;
    searchResult = null;
    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) {
      render(store.state);
      return;
    }
    const listId = activeList;
    run(
      runSearch(listTracks(store.state), query).then((result) => {
        if (token !== searchToken) return;
        searchResult = { query, listId, items: result.items, total: result.total };
        render(store.state);
      }),
    );
    render(store.state);
  }

  function setQuery(value) {
    searchQuery = value;
    rerunQuery();
  }

  function selectList(id) {
    if (activeList === id) return;
    activeList = id;
    rerunQuery();
  }

  function ensureTracksView() {
    if (tracksView) return tracksView;

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
    const chipButtons = AUTO_LISTS.map((id) => ({
      id,
      button: el('button', {
        class: 'segment',
        type: 'button',
        'data-testid': AUTO_LIST_TESTID[id],
        'aria-pressed': 'false',
        text: t(`autoList.${id}`),
        onclick: () => selectList(id),
      }),
    }));
    const countLine = el('p', { class: 'search-count', 'data-testid': 'search-count' });
    const listBox = el('div', { class: 'search-results' });
    const root = el('div', { class: 'tracks-view' }, [
      el('div', { class: 'search-bar' }, [input, clearButton]),
      el(
        'div',
        { class: 'chips', 'data-testid': 'auto-lists', role: 'group', 'aria-label': t('search.label') },
        chipButtons.map(({ button }) => button),
      ),
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

    tracksView = { root, input, clearButton, chipButtons, countLine, listBox };
    return tracksView;
  }

  function renderTracksView(state) {
    const view = ensureTracksView();
    if (ui.panel.firstElementChild !== view.root) ui.panel.replaceChildren(view.root);

    setHidden(view.clearButton, !searchQuery);
    for (const { id, button } of view.chipButtons) {
      const active = id === activeList;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }

    const currentId = state.current.track?.id ?? null;
    const rowFor = (track) =>
      trackRow(track, {
        now: track.id === currentId,
        onActivate: () => run(store.playTrack(track.id)),
        onMore: openTrackMenu,
      });

    const base = listTracks(state);
    if (!base.length) {
      setHidden(view.countLine, true);
      view.listBox.replaceChildren(
        el('p', { class: 'muted', 'data-testid': 'auto-list-empty', text: t('autoList.empty') }),
      );
      return;
    }

    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) {
      setHidden(view.countLine, true);
      view.listBox.replaceChildren(
        listSection(
          t(`autoList.${activeList}`),
          t('common.trackCount', { count: base.length }),
          base.map(rowFor),
        ),
      );
      return;
    }

    const result = searchResult;
    const valid = result && result.query === query && result.listId === activeList;
    if (!valid) {
      // The debounced search has not resolved yet; keep the previous frame's
      // rows out of the DOM so a stale list never answers a new query.
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

  // ---- lyrics view ----
  function buildLyricsView() {
    const backButton = el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'data-testid': 'lyrics-back',
        'aria-label': t('lyrics.back'),
        onclick: () => store.setView('tracks'),
      },
      [el('span', { class: 'back-arrow', 'aria-hidden': 'true', text: '←' })],
    );
    const headText = el('div', { class: 'lyrics-head-text' }, [
      el('h2', { text: t('lyrics.title') }),
      el('p', { class: 'lyrics-track' }),
    ]);
    const linesBox = el('div', { class: 'lyrics', 'data-testid': 'lyrics-lines' });
    const root = el('section', { class: 'settings-view lyrics-view', 'data-testid': 'lyrics-view' }, [
      el('div', { class: 'settings-head lyrics-head' }, [backButton, headText]),
      linesBox,
    ]);
    return { root, trackLine: headText.lastElementChild, linesBox, rows: [], active: -1, key: null, linesRef: null, plain: null };
  }

  function ensureLyricsView() {
    if (!lyricsView) lyricsView = buildLyricsView();
    if (ui.lyricsHost.firstElementChild !== lyricsView.root) {
      ui.lyricsHost.replaceChildren(lyricsView.root);
    }
    return lyricsView;
  }

  function renderLyrics(state) {
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
  }

  function renderView(state) {
    if (state.view === 'settings') return;
    if (state.view === 'lyrics') {
      ensureLyricsView();
      return;
    }
    const currentId = state.current.track?.id ?? null;
    const queueView = state.view === 'queue';
    const permissions = (state.sources ?? []).map((row) => row.permission).join(',');
    const rebuild =
      state.view !== last.view ||
      state.tracks !== last.tracks ||
      state.stats !== last.stats ||
      permissions !== last.permissions ||
      installPromptSeen !== last.installable ||
      currentId !== last.currentId ||
      state.pins !== last.pins ||
      state.playlists !== last.playlists ||
      searchQuery !== last.query ||
      activeList !== last.list ||
      searchResult !== last.searchResult ||
      state.lyrics.source !== last.lyricsSource ||
      state.lyrics.lines !== last.lyricsLines ||
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
    last.playlists = state.playlists;
    last.query = searchQuery;
    last.list = activeList;
    last.searchResult = searchResult;
    last.lyricsSource = state.lyrics.source;
    last.lyricsLines = state.lyrics.lines;
    last.queueTracks = state.queue.tracks;
    last.queueIndex = state.queue.index;

    syncCoverCache(state.tracks.map((track) => track.cover).filter(Boolean));

    if (state.view === 'playlists') {
      ui.playlistView.render(state);
      ui.panel.replaceChildren(ui.playlistView.node);
      return;
    }

    if (!(state.sources ?? []).some((row) => row.permission === 'granted')) {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    if (!state.tracks.length) {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    if (state.view === 'albums') {
      const groups = groupByAlbum(state.tracks);
      const cards = groups.map((group) => {
        const name = albumLabel(group.name);
        return cardItem({
          title: name,
          meta: `${artistLabel(group.artist)} · ${t('common.trackCount', { count: group.tracks.length })}`,
          cover: group.cover,
          label: t('aria.playAlbum', { name }),
          onPlay: () => run(store.playQueue(group.tracks, group.tracks[0]?.id)),
        });
      });
      ui.panel.replaceChildren(
        el('section', { class: 'list' }, [
          el('header', {}, [
            el('span', { text: t('tabs.albums') }),
            el('span', { text: t('common.albumCount', { count: groups.length }) }),
          ]),
          el('ul', { class: 'grid' }, cards),
        ]),
      );
      return;
    }

    if (state.view === 'artists') {
      const groups = groupByArtist(state.tracks);
      const cards = groups.map((group) => {
        const name = artistLabel(group.name);
        return cardItem({
          title: name,
          meta: t('common.trackCount', { count: group.tracks.length }),
          cover: group.cover,
          label: t('aria.playArtist', { name }),
          onPlay: () => run(store.playQueue(group.tracks, group.tracks[0]?.id)),
        });
      });
      ui.panel.replaceChildren(
        el('section', { class: 'list' }, [
          el('header', {}, [
            el('span', { text: t('tabs.artists') }),
            el('span', { text: t('common.artistCount', { count: groups.length }) }),
          ]),
          el('ul', { class: 'grid' }, cards),
        ]),
      );
      return;
    }

    if (state.view === 'folders') {
      const groups = groupByFolder(state.tracks);
      const byId = new Map(state.tracks.map((track) => [track.id, track]));
      const rows = groups.map((group) => {
        const list = group.trackIds.map((id) => byId.get(id)).filter(Boolean);
        const sources = [...new Set(list.map((track) => track.source))];
        const pinned =
          sources.length > 0 && sources.every((source) => store.isPinned(source, group.dir));
        const pins = sources
          .map((source) => (state.pins ?? []).find((pin) => pin.id === `${source}:${group.dir}`))
          .filter(Boolean);
        const running = pins.some((pin) => pin.running);
        const pin = running
          ? {
              running: true,
              done: pins.reduce((sum, item) => sum + (item.done ?? 0), 0),
              total: pins.reduce((sum, item) => sum + (item.total ?? 0), 0),
            }
          : { error: pins.find((item) => item.error)?.error ?? null };
        return folderRow(group, {
          onPlay: () => run(store.playQueue(list, list[0]?.id)),
          onEnqueue: () => store.appendQueue(list),
          pinned,
          pin,
          onPin: () => {
            for (const source of sources) {
              if (pinned) {
                run(store.unpinFolder(`${source}:${group.dir}`));
              } else {
                run(
                  store.pinFolder({
                    source,
                    dir: group.dir,
                    trackIds: list
                      .filter((track) => track.source === source)
                      .map((track) => track.id),
                  }),
                );
              }
            }
          },
        });
      });
      ui.panel.replaceChildren(
        listSection(
          t('tabs.folders'),
          t('common.folderCount', { count: groups.length }),
          rows,
        ),
      );
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
            onAction: () => store.setView('tracks'),
          }),
        );
        return;
      }
      const rows = tracks.map((track, index) =>
        queueRow(track, index, {
          now: index === state.queue.index,
          onActivate: () => run(store.jumpTo(index)),
          onRemove: () => store.removeQueueAt(index),
          onMore: openTrackMenu,
        }),
      );
      ui.panel.replaceChildren(
        listSection(
          t('common.playQueue'),
          t('common.trackCount', { count: tracks.length }),
          rows,
        ),
      );
      return;
    }

    renderTracksView(state);
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
    if (state.view === 'lyrics') {
      // A track change inside the lyrics view resolves once; the store sets
      // `lyrics.trackId` synchronously, so the 4 Hz position updates do not
      // issue another request.
      const trackId = state.current.track?.id ?? null;
      if (trackId && state.lyrics?.trackId !== trackId) void store.loadLyrics(trackId);
      renderLyrics(state);
    }
    const settings = state.view === 'settings';
    const lyrics = state.view === 'lyrics';
    setHidden(ui.defaultView, settings || lyrics);
    setHidden(ui.settingsHost, !settings);
    setHidden(ui.lyricsHost, !lyrics);
    setHidden(ui.settingsButton, settings);
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
