/**
 * Full page UI for LocalTune. The shell is built once; store changes patch the
 * persistent tree on the next animation frame. The vinyl stage is the primary
 * transport: the tonearm toggles playback and doubles as the seek rail, so no
 * separate play/prev/next buttons or progress bar are rendered.
 */

import { formatDuration, formatTime } from '../core/selectors.js';
import { subdirsOf, tracksDirect, tracksUnder } from '../core/folders.js';
import { runSearch } from '../core/search.js';
import { libraryVisible, visibleSources } from '../core/library.js';
import { el, icon, symbolIcon, setIcon, setText, setHidden } from './dom.js';
import { createSettingsView } from './settings.js';
import { createVipView } from './vip.js';
import { createVirtualizer } from './virtualList.js';
import { openTagInfo } from './diagnostics.js';
import { bindStageSwipe, bindTonearm, ARM_PARK, angleForProgress } from './tonearm.js';
import { createLowPowerGate, LOW_POWER_WINDOW_MS } from './lowPower.js';
import { mountChalkLayer, shouldShowChalk } from './chalkLayer.js';
import { isDemoTrack } from '../core/demo.js';
import {
  THEMES,
  THEME_NAMES,
  currentTheme,
  loadLibraryTab,
  loadPanelOpen,
  saveLibraryTab,
  savePanel,
  savePanelOpen,
  saveTheme,
} from './uiPrefs.js';
import {
  applyDocumentLang,
  browserLanguages,
  ensureLocale,
  getLocale,
  hasLocale,
  resolveLanguage,
  resolveLocale,
  setLocale,
  t,
} from '../i18n/index.js';

const TABS = [
  { id: 'queue', labelKey: 'tabs.queue', icon: 'i-list' },
  { id: 'folders', labelKey: 'tabs.folders', icon: 'i-folder' },
];

const REPEAT_LABEL_KEY = {
  off: 'player.repeatOff',
  all: 'player.repeatAll',
  one: 'player.repeatOne',
};

const PERMISSION_TITLE_KEYS = {
  local: 'permission.title.local',
  onedrive: 'permission.title.onedrive',
  gdrive: 'permission.title.gdrive',
  dropbox: 'permission.title.dropbox',
};

const SEARCH_GROUPS = [
  { id: 'title', labelKey: 'search.groupTitle' },
  { id: 'artist', labelKey: 'search.groupArtist' },
  { id: 'album', labelKey: 'search.groupAlbum' },
  { id: 'fileName', labelKey: 'search.groupFileName' },
];

const SEARCH_DEBOUNCE_MS = 150;
const PANEL_BREAKPOINT = '(max-width: 900px)';

let installPromptSeen = false;
let activeArm = null;
let activeSwipe = null;

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

const UNKNOWN = new Set(['', '\u672a\u77e5\u6b4c\u624b', '\u672a\u77e5\u4e13\u8f91']);
const artistLabel = (value) => (UNKNOWN.has(value ?? '') ? t('common.unknownArtist') : value);
const albumLabel = (value) => (UNKNOWN.has(value ?? '') ? t('common.unknownAlbum') : value);

function subtitleOf(track) {
  const parts = [artistLabel(track.artist), albumLabel(track.album)];
  if (Number.isFinite(track.year) && track.year > 0) parts.push(String(track.year));
  return parts.filter(Boolean).join(' · ');
}

// The store that owns cover URLs, plus the ids each rendered list holds. Lists
// that render whole build into `buildingCoverIds`, then swap with
// `renderedCoverIds` once the new nodes are attached, so old URLs are released
// only after the new ones exist. Virtualized lists pass their own array so each
// window owns exactly the covers it rendered.
let coverStore = null;
let renderedCoverIds = [];
let buildingCoverIds = [];

function coverNode(track, className = 'track-cover', coverIds = buildingCoverIds) {
  const img = el('img', {
    class: className,
    alt: '',
    draggable: 'false',
    loading: 'lazy',
    decoding: 'async',
  });
  if (track?.coverSrc) {
    img.src = track.coverSrc;
    return img;
  }
  if (track?.hasCover && track.id) {
    const id = track.id;
    coverIds.push(id);
    void coverStore?.coverUrl(track).then((url) => {
      if (url && img.isConnected) img.src = url;
    });
  }
  return img;
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
  return el('div', { class: 'empty' }, children);
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
  return el(
    'button',
    {
      class: 'row-more',
      type: 'button',
      'data-testid': 'row-more',
      'aria-label': t('aria.more', { title: track.title }),
      onclick: (event) => {
        event.stopPropagation();
        onMore?.(track, event.currentTarget);
      },
    },
    [icon('more')],
  );
}

function trackRow(track, { now, onActivate, onMore, coverIds }) {
  const hit = el(
    'button',
    {
      class: 'track',
      type: 'button',
      'aria-current': now ? 'true' : 'false',
      'aria-label': t('aria.playTrack', { title: track.title }),
      onclick: onActivate,
    },
    [
      coverNode(track, 'track-cover', coverIds),
      el('span', { class: 'track-text' }, [
        el('strong', { text: track.title }),
        el('small', { text: subtitleOf(track) }),
      ]),
      el('span', { class: 'track-dur', text: formatDuration(track.duration) }),
    ],
  );
  const row = el(
    'li',
    { class: now ? 'track-item now' : 'track-item', 'data-testid': 'track-row', 'data-track-id': track.id },
    [hit],
  );
  const more = moreButton(track, onMore);
  row.append(more);
  bindRowMenu(row, track, more, onMore);
  return row;
}

function queueRow(track, index, { now, onActivate, onRemove, coverIds }) {
  const hit = el(
    'button',
    {
      class: 'track',
      type: 'button',
      'aria-current': now ? 'true' : 'false',
      'aria-label': t('aria.playQueueItem', { index: index + 1, title: track.title }),
      onclick: onActivate,
    },
    [
      el('span', { class: 'track-index', text: String(index + 1).padStart(2, '0') }),
      coverNode(track, 'track-cover', coverIds),
      el('span', { class: 'track-text' }, [
        el('strong', { text: track.title }),
        el('small', { text: subtitleOf(track) }),
      ]),
      el('span', { class: 'track-dur', text: formatDuration(track.duration) }),
    ],
  );
  const remove = el(
    'button',
    {
      class: 'row-x',
      type: 'button',
      text: '×',
      'aria-label': t('aria.removeFromQueue', { title: track.title }),
      onclick: (event) => {
        event.stopPropagation();
        onRemove();
      },
    },
  );
  return el('li', { class: now ? 'track-item queue now' : 'track-item queue' }, [hit, remove]);
}

function sourceRow({ id, label, count, onOpen, iconId }) {
  const hit = el(
    'button',
    {
      class: 'track',
      type: 'button',
      'data-testid': `folder-source-${id}`,
      onclick: onOpen,
    },
    [
      el('span', { class: 'track-icon' }, [symbolIcon(iconId, 'icon')]),
      el('span', { class: 'track-text' }, [
        el('strong', { text: label }),
        el('small', { text: t('common.trackCount', { count }) }),
      ]),
    ],
  );
  return el('li', { class: 'track-item' }, [hit]);
}

function dirRow(entry, onOpen) {
  const hit = el(
    'button',
    {
      class: 'track',
      type: 'button',
      'data-testid': `folder-dir-${entry.dir}`,
      onclick: onOpen,
    },
    [
      el('span', { class: 'track-icon' }, [symbolIcon('i-folder', 'icon')]),
      el('span', { class: 'track-text' }, [
        el('strong', { text: entry.name }),
        el('small', { text: t('common.trackCount', { count: entry.count }) }),
      ]),
    ],
  );
  return el('li', { class: 'track-item' }, [hit]);
}

const SPRITE = `
<svg class="sr-only" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 12h16M4 6h16M4 18h16"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
  <symbol id="i-crown" viewBox="0 0 24 24"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 6.87a1 1 0 0 0 1.417.294l3.176-2.383a.5.5 0 0 1 .794.52l-1.7 9.36a1 1 0 0 1-.984.815H5.906a1 1 0 0 1-.984-.816l-1.7-9.36a.5.5 0 0 1 .794-.518L7.193 7.16A1 1 0 0 0 8.61 6.867z"/><path d="M5 21h14"/></symbol>
  <symbol id="i-arrow-up-right" viewBox="0 0 24 24"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="i-palette" viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></symbol>
  <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/></symbol>
  <symbol id="i-repeat" viewBox="0 0 24 24"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></symbol>
  <symbol id="i-repeat-1" viewBox="0 0 24 24"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></symbol>
  <symbol id="i-cloud" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></symbol>
  <symbol id="i-hard-drive" viewBox="0 0 24 24"><path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01"/></symbol>
  <symbol id="i-dropbox" viewBox="0 0 24 24"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></symbol>
</svg>`;

const TONEARM = `
<svg class="tonearm-svg" id="armSvg" viewBox="0 0 640 550">
  <defs>
    <linearGradient id="armSilver" x1="0" y1="0" x2="1" y2="1">
      <stop class="tone-0" offset="0"/>
      <stop class="tone-1" offset=".18"/>
      <stop class="tone-2" offset=".47"/>
      <stop class="tone-3" offset=".65"/>
      <stop class="tone-4" offset="1"/>
    </linearGradient>
    <radialGradient id="pivotMetal" cx=".35" cy=".23" r=".8">
      <stop class="pivot-0" offset="0"/>
      <stop class="pivot-1" offset=".42"/>
      <stop class="pivot-2" offset=".7"/>
      <stop class="pivot-3" offset="1"/>
    </radialGradient>
    <linearGradient id="headMetal">
      <stop class="head-0" offset="0"/>
      <stop class="head-1" offset=".5"/>
      <stop class="head-2" offset="1"/>
    </linearGradient>
  </defs>
  <circle class="pivot-base-ring" cx="560" cy="75" r="29" stroke-width="2.5"/>
  <circle class="pivot-rim" cx="560" cy="75" r="23" fill="url(#pivotMetal)" stroke-width="1"/>
  <circle class="pivot-core" cx="560" cy="75" r="14" stroke-width="1.5"/>
  <circle class="pivot-cap" cx="560" cy="75" r="6" stroke-width="2"/>
  <g class="tonearm-motion arm-handle" id="armRotor" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" filter="drop-shadow(1px 8px 6px rgba(0,0,0,.55))">
    <path d="M560 75 L544 113 L451 268" fill="none" stroke="#071116" stroke-width="18" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M560 75 L544 113 L451 268" fill="none" stroke="url(#armSilver)" stroke-width="11.5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M559 76 L542 113 L449 266" fill="none" stroke="#f3f3e9" stroke-opacity=".58" stroke-width="2.2" stroke-linecap="round"/>
    <path class="weight-warm" d="M544 111 L534 129" stroke-width="15"/>
    <path class="weight-metal" d="M544 111 L534 129" stroke-width="10"/>
    <g transform="translate(451 268) rotate(28)">
      <rect class="head-edge" x="-16" y="-6.5" width="29" height="13" rx="3.5" stroke-width="2.2"/>
      <rect x="0" y="-7.5" width="12" height="15" rx="2" fill="url(#headMetal)"/>
      <path class="head-needle" d="M-16 6 L-17 16" stroke-width="3"/>
      <circle class="stylus-point" cx="-17" cy="17" r="2.6"/>
    </g>
    <path class="arm-hit" d="M560 66 L544 113 L451 268"/>
    <circle class="arm-head-hit" cx="430" cy="276" r="24"/>
  </g>
  <circle class="hub-hit" cx="560" cy="75" r="36" aria-hidden="true"/>
  <path class="arm-rest" d="M593 102V153" stroke-width="3" stroke-linecap="round"/>
  <circle class="arm-rest-knob" cx="593" cy="148" r="5" stroke-width="2"/>
</svg>`;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Source-permission dialog. The store owns the issue; the modal only mirrors
 * it and calls back. Reauthorizing runs inside the click gesture so FSA and
 * GIS prompts are still allowed.
 */
function createPermissionModal(store) {
  const title = el('h2', {
    id: 'permission-dialog-title',
    tabindex: '-1',
    'data-testid': 'permission-title',
  });
  const body = el('p', { class: 'muted', 'data-testid': 'permission-body' });
  const reauthorize = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'permission-reauthorize',
    text: t('permission.reauthorize'),
  });
  const settingsButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'permission-settings',
    text: t('permission.settings'),
  });
  const closeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'permission-close',
    text: t('permission.close'),
  });
  const panel = el('div', { class: 'modal-panel permission-panel' }, [
    el('header', { class: 'modal-head' }, [title]),
    body,
    el('div', { class: 'modal-actions' }, [reauthorize, settingsButton, closeButton]),
  ]);
  const node = el(
    'div',
    {
      class: 'modal permission-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'permission-dialog-title',
      'data-testid': 'permission-dialog',
      hidden: true,
    },
    panel,
  );

  let trigger = null;
  let previousOverflow = '';
  let open = false;
  let kind = null;
  let onSettings = null;
  let busy = false;

  function onKeydown(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll(FOCUSABLE)].filter(
      (item) => !item.hasAttribute('hidden') && item.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function show() {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!node.isConnected) document.body.append(node);
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setHidden(node, false);
    open = true;
    document.addEventListener('keydown', onKeydown);
    title.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    setHidden(node, true);
    document.removeEventListener('keydown', onKeydown);
    document.body.style.overflow = previousOverflow;
    if (trigger && trigger.isConnected !== false && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  function dismiss() {
    store.resolvePermissionIssue();
    hide();
  }

  function sync(issue) {
    if (!issue) {
      if (open) hide();
      return;
    }
    kind = issue.kind;
    setText(title, t(PERMISSION_TITLE_KEYS[kind] ?? PERMISSION_TITLE_KEYS.local));
    setText(body, t(kind === 'local' ? 'permission.bodyLocal' : 'permission.bodyCloud'));
    if (!open) show();
  }

  node.addEventListener('click', (event) => {
    if (event.target === node) dismiss();
  });
  closeButton.addEventListener('click', dismiss);
  settingsButton.addEventListener('click', () => {
    const target = kind;
    store.resolvePermissionIssue();
    hide();
    if (target) onSettings?.(target);
  });
  reauthorize.addEventListener('click', async () => {
    if (busy || !kind) return;
    busy = true;
    reauthorize.disabled = true;
    try {
      await store.recoverSource(kind);
    } finally {
      busy = false;
      reauthorize.disabled = false;
    }
  });

  return {
    node,
    sync,
    setSettingsHandler(fn) {
      onSettings = typeof fn === 'function' ? fn : null;
    },
  };
}

function createShell(store, sw) {
  const status = el('span', { class: 'status', id: 'status' });
  const statusSep = el('span', { class: 'status-sep', 'aria-hidden': 'true', hidden: true });
  const wordmark = el('div', { class: 'wordmark' }, ['localtune', el('span', { text: '.' })]);

  const deniedHint = el('p', {
    class: 'alert',
    role: 'status',
    text: t('common.deniedHint'),
  });
  const errorBox = el('p', { class: 'alert', role: 'alert' });

  const vipButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'data-testid': 'vip-open', 'aria-label': t('vip.open') },
    [symbolIcon('i-crown', 'icon own-icon'), symbolIcon('i-x', 'icon x-icon')],
  );
  const settingsButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'data-testid': 'settings-open', 'aria-label': t('settings.open') },
    [symbolIcon('i-settings', 'icon own-icon'), symbolIcon('i-x', 'icon x-icon')],
  );
  const themeButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'data-testid': 'theme-toggle' },
    [symbolIcon('i-palette')],
  );
  const panelButton = el(
    'button',
    {
      class: 'icon-btn menu-toggle',
      type: 'button',
      'data-testid': 'panel-open',
      'aria-label': t('aria.library'),
      'aria-expanded': 'false',
      'aria-controls': 'panel',
    },
    [
      symbolIcon('i-menu', 'icon own-icon'),
      symbolIcon('i-x', 'icon x-icon'),
    ],
  );

  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand-group' }, [wordmark, statusSep, status]),
  ]);
  const topActions = el('div', { class: 'top-actions', id: 'topActions' }, [
    vipButton,
    settingsButton,
    themeButton,
    panelButton,
  ]);

  // ---- stage ----
  const cover = el('img', { class: 'disc-art', id: 'cover', alt: '', draggable: 'false' });
  const vinyl = el('div', { class: 'vinyl' }, [
    cover,
    el('span', { class: 'reflection', 'aria-hidden': 'true' }),
    el('span', { class: 'rim', 'aria-hidden': 'true' }),
    el('span', { class: 'spindle', 'aria-hidden': 'true' }),
  ]);
  const discWrap = el('div', { class: 'disc-wrap' }, [vinyl]);
  const deck = el('div', { class: 'deck', id: 'deck' }, [discWrap]);
  deck.insertAdjacentHTML('beforeend', TONEARM);
  const chalk = mountChalkLayer(deck);

  const armSvg = deck.querySelector('#armSvg');
  const armRotor = deck.querySelector('#armRotor');

  const title = el('h1', { class: 'song', id: 'songTitle' });
  const artist = el('p', { class: 'artist', id: 'songArtist' });
  const nowText = el('div', { class: 'now-text' }, [title, artist]);

  const shuffleButton = el(
    'button',
    {
      class: 'mode',
      type: 'button',
      'data-testid': 'control-shuffle',
      'aria-label': t('aria.shuffle'),
      'aria-pressed': 'false',
    },
    [symbolIcon('i-shuffle')],
  );
  const repeatUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  repeatUse.setAttribute('href', '#i-repeat');
  const repeatIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  repeatIcon.setAttribute('class', 'icon');
  repeatIcon.setAttribute('aria-hidden', 'true');
  repeatIcon.append(repeatUse);
  const repeatButton = el(
    'button',
    {
      class: 'mode',
      type: 'button',
      'data-testid': 'control-repeat',
      'aria-label': t('player.repeatOff'),
      'aria-pressed': 'false',
    },
    [repeatIcon],
  );

  const stage = el('main', { class: 'stage player' }, [
    deck,
    el('div', { class: 'now' }, [shuffleButton, nowText, repeatButton]),
  ]);

  // ---- panel: library ----
  const searchInput = el('input', {
    id: 'search',
    type: 'search',
    'data-testid': 'search-input',
    placeholder: t('search.placeholder'),
    autocomplete: 'off',
    'aria-label': t('search.label'),
  });
  const searchClear = el(
    'button',
    {
      class: 'search-clear',
      type: 'button',
      'data-testid': 'search-clear',
      'aria-label': t('search.clear'),
      text: '×',
      hidden: true,
    },
  );
  const search = el('div', { class: 'search' }, [
    symbolIcon('i-search'),
    searchInput,
    searchClear,
  ]);

  const tabButtons = TABS.map(({ id, labelKey, icon: iconId }) =>
    el(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${id}`,
        'data-tab': id,
        'aria-selected': 'false',
        text: null,
      },
      [symbolIcon(iconId), el('span', { text: t(labelKey) })],
    ),
  );
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': t('aria.libraryViews') }, tabButtons);

  const trackList = el('div', { class: 'track-list', id: 'trackList', 'aria-live': 'polite' });
  const listScroll = el('div', { class: 'list-scroll', id: 'listScroll' }, [trackList]);
  const libraryView = el('div', { class: 'panel-view library-view', id: 'libraryView' }, [
    search,
    tabs,
    listScroll,
  ]);

  // ---- panel: settings / vip ----
  const settingsView = createSettingsView(store, sw);
  const vipView = createVipView();
  const settingsHost = el('div', { class: 'panel-view settings-pane', id: 'settingsView', hidden: true }, [
    settingsView.node,
  ]);
  const vipHost = el('div', { class: 'panel-view vip-pane', id: 'vipView', hidden: true }, [
    vipView.node,
  ]);

  const libraryKicker = el('p', { class: 'eyebrow', id: 'libraryKicker' });
  const vipKicker = el(
    'p',
    { class: 'eyebrow vip-kicker', id: 'vipKicker', hidden: true },
    [symbolIcon('i-crown'), el('span', { text: t('panel.vipKicker') })],
  );
  const panelTitle = el('h2', { id: 'panelTitle' });

  const panel = el(
    'aside',
    { class: 'panel', id: 'panel', 'aria-label': t('aria.library'), 'aria-hidden': 'true', inert: true },
    [
      el('div', { class: 'panel-inner' }, [
        el('div', { class: 'panel-head' }, [
          el('div', {}, [libraryKicker, vipKicker, panelTitle]),
        ]),
        libraryView,
        settingsHost,
        vipHost,
      ]),
    ],
  );

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
  const permissionModal = createPermissionModal(store);

  const mainCol = el('div', { class: 'main-col' }, [topbar, errorBox, deniedHint, stage]);

  const app = el('div', { class: 'app' }, [
    el('div', { class: 'backdrop', 'aria-hidden': 'true' }),
    mainCol,
    panel,
    updateBanner,
    toast,
    permissionModal.node,
    topActions,
  ]);
  app.insertAdjacentHTML('afterbegin', SPRITE);

  return {
    app,
    status,
    statusSep,
    deniedHint,
    errorBox,
    cover,
    deck,
    chalk,
    stage,
    armSvg,
    armRotor,
    armHandle: armRotor,
    title,
    artist,
    shuffleButton,
    repeatButton,
    repeatUse,
    topActions,
    vipButton,
    settingsButton,
    themeButton,
    panelButton,
    panel,
    libraryView,
    settingsHost,
    vipHost,
    settingsView,
    vipView,
    searchInput,
    searchClear,
    tabButtons,
    trackList,
    listScroll,
    libraryKicker,
    vipKicker,
    panelTitle,
    updateBanner,
    toast,
    permissionModal,
  };
}

const PANEL_VIEWS = ['vip', 'settings', 'library'];

const PANEL_OPEN_KEYS = {
  vip: 'vip.open',
  settings: 'settings.open',
  library: 'aria.library',
};

/**
 * Icon and aria state for the three top-bar toggles, derived only from the
 * panel state. The active view owns the ✕; everything else shows its own glyph.
 * Labels stay i18n keys so the caller decides when to translate.
 */
export function derivePanelState({ panelView, panelOpen }) {
  const keys = {};
  for (const view of PANEL_VIEWS) {
    const expanded = panelOpen === true && panelView === view;
    keys[view] = {
      icon: expanded ? 'close' : 'own',
      expanded,
      label: expanded ? 'panel.close' : PANEL_OPEN_KEYS[view],
    };
  }
  return keys;
}

/** Next panel state after clicking one of the three toggles. */
export function panelAfterToggle({ panelView, panelOpen }, view, mobile) {
  if (panelOpen && panelView === view) {
    return { panelView: 'library', panelOpen: view === 'library' ? false : !mobile };
  }
  if (mobile && view === 'library') return { panelView: 'library', panelOpen: false };
  return { panelView: view, panelOpen: true };
}

/** Next panel state after Esc, an outside click, or the ✕ on the active view. */
export function panelAfterClose({ panelView }, mobile) {
  return panelView === 'library'
    ? { panelView: 'library', panelOpen: false }
    : { panelView: 'library', panelOpen: !mobile };
}

export function mountUi(root, store, sw) {
  coverStore = store;
  renderedCoverIds = [];
  buildingCoverIds = [];
  let stageCoverId = null;
  let stageCoverUrl = undefined;
  let stageCoverPending = null;
  let stageCoverToken = 0;
  let menuNode = null;
  let menuCleanup = null;
  let toastTimer = null;
  let renderedSignature = null;
  let ui = createShell(store, sw);

  function handlePermissionSettings(kind) {
    show('settings');
    requestAnimationFrame(() => {
      const row = ui.settingsView.node.querySelector(`[data-testid="source-row-${kind}"]`);
      row?.scrollIntoView({ block: 'center' });
      const changeId = kind === 'local' ? 'settings-source-change' : `settings-source-${kind}`;
      const selector =
        `[data-testid="source-connect-${kind}"]:not([hidden]), ` +
        `[data-testid="${changeId}"]:not([hidden])`;
      row?.querySelector(selector)?.focus({ preventScroll: true });
    });
  }
  ui.permissionModal.setSettingsHandler(handlePermissionSettings);

  let panelView = 'library';
  let panelOpen = false;
  let panelTransitionArmed = false;
  let panelSignature = null;
  let swapTimer = 0;
  let lastPlaying = false;
  let lastTrackId = null;
  let armEngageUntil = 0;

  const ARM_INTERVAL_MS = 1000 / 30;
  const ARM_MIN_ANGLE = 0.1;
  const ARM_LOW_POWER_INTERVAL_MS = 1000;

  let armFrame = 0;
  let armTimer = 0;
  let armLastPaintAt = 0;
  let armLastAngle = null;
  let lastFrameAt = 0;

  let lowPower = false;
  let lowPowerSince = 0;
  let lowPowerDecay = 0;
  let idleStop = 0;
  let watchedAudio = null;
  const gate = createLowPowerGate();
  const prefersReducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? {
    matches: false,
  };

  const mobileQuery = globalThis.matchMedia?.(PANEL_BREAKPOINT) ?? { matches: false };
  const isMobile = () => Boolean(mobileQuery.matches);

  if (!isMobile() && loadPanelOpen()) {
    panelOpen = true;
    panelView = 'library';
  }

  let searchQuery = '';
  let searchResult = null;
  let searchTimer = 0;
  let searchToken = 0;
  let folder = { source: null, dir: '' };
  let libraryTab = loadLibraryTab() ?? (store.state.tracks.length ? 'folders' : 'queue');
  let tabChosen = Boolean(loadLibraryTab());

  const last = {
    view: null,
    tracks: null,
    stats: null,
    currentId: null,
    queueTracks: null,
    queueIndex: -1,
    queueOrder: null,
    permissions: null,
    query: '',
    folderSource: null,
    folderDir: '',
    searchResult: null,
    tab: null,
    panelView: null,
  };

  function resetCache() {
    last.view = null;
    last.tracks = null;
    last.stats = null;
    last.currentId = null;
    last.queueTracks = null;
    last.queueIndex = -1;
    last.queueOrder = null;
    last.permissions = null;
    last.query = '';
    last.folderSource = null;
    last.folderDir = '';
    last.searchResult = null;
    last.tab = null;
    last.panelView = null;
    clearTimeout(searchTimer);
    searchTimer = 0;
    searchToken += 1;
    searchQuery = '';
    searchResult = null;
    folder = { source: null, dir: '' };
    clearVirtualLists();
    clearRenderedCovers();
    buildingCoverIds = [];
  }

  function clearRenderedCovers() {
    for (const id of renderedCoverIds) store.releaseCover(id);
    renderedCoverIds = [];
  }

  // ---- virtualized lists ---------------------------------------------------
  // One controller per mounted `.track-list`. They are torn down whenever the
  // list's nodes are replaced, because the controller owns the rows it built.
  let virtualLists = [];
  let listBindings = [];
  let virtualRaf = 0;
  let virtualRetry = 0;
  let virtualAttempts = 0;
  const VIRTUAL_RETRY_MS = 100;
  const VIRTUAL_RETRY_LIMIT = 20;

  /** Row height in px, gap excluded (the gap comes from the list's CSS). */
  const estimateStride = () => (isMobile() ? 60 : 64);

  /**
   * Visible slice in the list's own content coordinates. Desktop scrolls the
   * panel (`.list-scroll`), mobile scrolls the page, so the origin differs.
   */
  function listViewport(container) {
    const scroller = ui.listScroll;
    const overflow = getComputedStyle(scroller).overflowY;
    const box = container.getBoundingClientRect();
    if (overflow === 'auto' || overflow === 'scroll') {
      return { top: scroller.getBoundingClientRect().top - box.top, height: scroller.clientHeight };
    }
    return { top: -box.top, height: window.innerHeight };
  }

  function mountVirtualList(container, count, makeRenderer) {
    const binding = { makeRenderer, renderRow: null };
    binding.renderRow = makeRenderer();
    const list = createVirtualizer({
      container,
      count,
      estimateStride: estimateStride(),
      getViewport: () => listViewport(container),
      scrollParent: ui.listScroll,
      renderRow: (index, coverIds) => binding.renderRow(index, coverIds),
      releaseCover: (id) => store.releaseCover(id),
    });
    binding.list = list;
    listBindings.push(binding);
    virtualLists.push(list);
    // A list mounted into a hidden panel cannot measure yet; retry until the
    // panel gives it a height.
    if (!list.viewportReady) scheduleVirtual();
    return list;
  }

  /** Rebuild each mounted window from the current state without remounting. */
  function repaintVirtualLists() {
    for (const binding of listBindings) {
      binding.renderRow = binding.makeRenderer();
      binding.list.repaint();
    }
  }

  function clearVirtualLists() {
    const lists = virtualLists;
    for (const list of lists) list.dispose();
    virtualLists = [];
    listBindings = [];
    if (virtualRaf) {
      cancelAnimationFrame(virtualRaf);
      virtualRaf = 0;
    }
    clearTimeout(virtualRetry);
    virtualRetry = 0;
    virtualAttempts = 0;
  }

  /**
   * Refresh every list on the next frame. Lists that still cannot measure keep
   * the cycle alive for a bounded number of attempts, so a panel opening later
   * re-paints without waiting for a scroll event.
   */
  function scheduleVirtual() {
    // Nothing to refresh means nothing to schedule: an idle app must stay
    // completely frame-free (the deck's idle-raf budget counts every request).
    if (!virtualLists.length) return;
    if (virtualRaf) return;
    virtualRaf = requestAnimationFrame(() => {
      virtualRaf = 0;
      let pending = false;
      for (const list of virtualLists) {
        list.refresh();
        if (!list.viewportReady) pending = true;
      }
      if (!pending) {
        virtualAttempts = 0;
        clearTimeout(virtualRetry);
        virtualRetry = 0;
        return;
      }
      if (virtualAttempts >= VIRTUAL_RETRY_LIMIT) {
        clearTimeout(virtualRetry);
        virtualRetry = 0;
        return;
      }
      virtualAttempts += 1;
      scheduleVirtual();
      if (virtualRetry) return;
      virtualRetry = setTimeout(() => {
        virtualRetry = 0;
        scheduleVirtual();
      }, VIRTUAL_RETRY_MS);
    });
  }

  // Window-level sources never change identity, so they are bound once.
  window.addEventListener('scroll', scheduleVirtual, { passive: true });
  window.addEventListener('resize', scheduleVirtual);
  window.addEventListener('orientationchange', scheduleVirtual);
  window.visualViewport?.addEventListener('resize', scheduleVirtual);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) scheduleVirtual();
  });

  /** Per-shell scroll sources; rebinding happens when the shell is remounted. */
  function bindVirtualSources() {
    ui.listScroll.addEventListener('scroll', scheduleVirtual, { passive: true });
  }

  /** Attach a freshly built list and hand the previous list's covers back. */
  function replaceTrackList(children) {
    // Remember the offsets BEFORE teardown: the new list has no height until
    // its virtualizer paints, so the browser clamps both the panel scroller and
    // the page while this turn's DOM is being swapped. On ≤900px the panel
    // scroller never scrolls (`overflow: visible`) and `window.scrollY` is the
    // only position to keep.
    const scrollTop = ui.listScroll.scrollTop;
    const pageTop = window.scrollY;
    clearVirtualLists();
    clearRenderedCovers();
    ui.trackList.replaceChildren(...children);
    renderedCoverIds = buildingCoverIds;
    buildingCoverIds = [];
    // Runs after the synchronous mount below, i.e. after the virtualizer's
    // first paint restored the content height, and before the frame paints.
    queueMicrotask(() => {
      if (scrollTop > 0 && ui.listScroll.scrollTop !== scrollTop) {
        ui.listScroll.scrollTop = scrollTop;
      }
      if (pageTop > 0 && window.scrollY !== pageTop) window.scrollTo(0, pageTop);
      if (scrollTop > 0 || pageTop > 0) {
        // The restored offset fires no scroll event; re-anchor the window.
        scheduleVirtual();
      }
    });
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

  function hasLibraryEntry(state) {
    if (state?.tracks?.length) return true;
    return Boolean(
      state?.sources?.some(
        (row) => row.permission !== 'none' || (row.trackCount ?? 0) > 0,
      ),
    );
  }

  /** Single write point for the panel state: persist, paint, then sync the view. */
  function commitPanelState(next, { render: shouldRender = true } = {}) {
    if (next.panelView === 'library' && !tabChosen && hasLibraryEntry(store.state)) {
      libraryTab = 'folders';
    }
    panelView = next.panelView;
    panelOpen = next.panelOpen;
    savePanel(panelView);
    if (!isMobile()) savePanelOpen(panelOpen);
    panelTransitionArmed = true;
    applyPanel();
    store.setView(panelView === 'library' ? libraryTab : panelView);
    if (shouldRender) render(store.state);
  }

  function closePanel() {
    commitPanelState(panelAfterClose({ panelView, panelOpen }, isMobile()), { render: false });
  }

  function show(view) {
    if (isMobile() && view === 'library') {
      commitPanelState({ panelView: 'library', panelOpen: false });
      return;
    }
    commitPanelState({ panelView: view, panelOpen: true });
  }

  function togglePanel(view) {
    const closing = panelOpen && panelView === view;
    const next = panelAfterToggle({ panelView, panelOpen }, view, isMobile());
    commitPanelState(next, { render: !closing && next.panelOpen });
  }

  function applyPanel() {
    const mobile = isMobile();
    const overlay = mobile && panelView !== 'library';
    const visible = mobile ? true : panelOpen;
    ui.app.classList.toggle('is-open', !mobile && panelOpen);
    ui.app.classList.toggle('is-overlay', overlay);
    ui.app.classList.toggle('is-subview', panelView !== 'library');
    ui.panel.classList.toggle('is-subview', panelView !== 'library');
    document.body.classList.toggle('overlay-open', overlay);

    ui.panel.toggleAttribute('inert', !visible);
    ui.panel.setAttribute('aria-hidden', String(!visible));
    ui.libraryView.hidden = panelView !== 'library';
    ui.settingsHost.hidden = panelView !== 'settings';
    ui.vipHost.hidden = panelView !== 'vip';

    ui.libraryKicker.hidden = panelView !== 'library';
    ui.vipKicker.hidden = panelView !== 'vip';

    ui.panelTitle.textContent =
      panelView === 'library'
        ? t('panel.libraryTitle')
        : panelView === 'settings'
          ? t('panel.settingsTitle')
          : t('panel.vipTitle');
    ui.panel.setAttribute(
      'aria-label',
      panelView === 'library' ? t('aria.library') : panelView === 'settings' ? t('settings.open') : t('vip.open'),
    );

    const keys = derivePanelState({ panelView, panelOpen });
    for (const [button, entry] of [
      [ui.vipButton, keys.vip],
      [ui.settingsButton, keys.settings],
      [ui.panelButton, keys.library],
    ]) {
      button.setAttribute('aria-expanded', String(entry.expanded));
      button.setAttribute('aria-label', t(entry.label));
      button.classList.toggle('is-open', entry.icon === 'close');
    }

    // The panel showing or hiding changes what the lists can measure. Only a
    // real change repaints: the first call just records, so an idle deck stays
    // frame-free.
    const signature = `${visible}|${ui.libraryView.hidden}|${overlay}`;
    if (panelSignature !== null && panelSignature !== signature) scheduleVirtual();
    panelSignature = signature;
  }

  function bindShellEvents() {
    bindVirtualSources();
    // The lists can only measure once the panel has its final width; the
    // transitionend is the signal that the animation is over. Only arming in
    // commitPanelState keeps the page-load auto-expand frame-free.
    ui.panel.addEventListener('transitionend', (event) => {
      if (!panelTransitionArmed) return;
      if (event.target !== ui.panel) return;
      const property = event.propertyName;
      if (property !== 'width' && property !== 'opacity' && property !== 'transform') return;
      panelTransitionArmed = false;
      scheduleVirtual();
    });
    ui.shuffleButton.addEventListener('click', () => store.toggleShuffle());
    ui.repeatButton.addEventListener('click', () => store.cycleRepeat());
    ui.settingsButton.addEventListener('click', () => togglePanel('settings'));
    ui.vipButton.addEventListener('click', () => togglePanel('vip'));
    ui.panelButton.addEventListener('click', () => togglePanel('library'));
    ui.themeButton.addEventListener('click', () => {
      const active = currentTheme();
      const next = THEMES[(THEMES.indexOf(active) + 1) % THEMES.length];
      setTheme(next);
    });
    ui.settingsView.node.addEventListener('toast', (event) => {
      showToast(event.detail?.text ?? '');
    });

    ui.searchInput.addEventListener('input', () => {
      const value = ui.searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = 0;
        setQuery(value);
      }, SEARCH_DEBOUNCE_MS);
    });
    ui.searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      ui.searchInput.value = '';
      clearTimeout(searchTimer);
      searchTimer = 0;
      setQuery('');
    });
    ui.searchClear.addEventListener('click', () => {
      ui.searchInput.value = '';
      clearTimeout(searchTimer);
      searchTimer = 0;
      setQuery('');
      ui.searchInput.focus();
    });

    for (const button of ui.tabButtons) {
      button.addEventListener('click', () => {
        libraryTab = button.dataset.tab;
        tabChosen = true;
        saveLibraryTab(libraryTab);
        if (searchQuery) {
          ui.searchInput.value = '';
          searchQuery = '';
          searchResult = null;
        }
        store.setView(libraryTab);
        render(store.state);
        scheduleVirtual();
      });
    }
  }

  function syncTheme() {
    const active = currentTheme();
    const name = THEME_NAMES[active] ?? active;
    ui.themeButton.setAttribute('aria-label', t('theme.switch', { name }));
    ui.themeButton.title = `${name} · ${t('theme.switch', { name })}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (value) meta.content = value;
    }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
    syncTheme();
  }

  function renderHeader(state) {
    const rows = state.sources ?? [];
    const local = rows.find((row) => row.id === 'local') ?? { permission: 'none', name: '' };
    const migration = state.migration;
    const scanningRow = rows.find((row) => row.scanning) ?? null;
    let message = '';

    if (migration?.running) {
      message = t('migration.progress', { done: migration.done ?? 0, total: migration.total ?? 0 });
    } else if (scanningRow) {
      const { done, total, phase } = scanningRow.progress ?? { done: 0, total: 0 };
      const caching = phase === 'cache' && total > 0;
      message =
        phase === 'import'
          ? t('common.importProgress', { done, total })
          : caching
            ? t('settings.source.caching', { done, total })
            : total > 0
              ? t('common.scanProgress', { done, total })
              : t('common.scanCount', { done });
    } else if (!state.ready) {
      message = t('common.loading');
    }

    setHidden(ui.status, !message);
    setHidden(ui.statusSep, !message);
    if (message) setText(ui.status, message);

    setHidden(ui.deniedHint, local.permission !== 'denied');

    const error = rows.find((row) => row.error && !row.errorStage)?.error ?? null;
    setHidden(ui.errorBox, !error);
    if (error) setText(ui.errorBox, typeof error === 'string' ? error : error.message ?? String(error));
  }

  function progressOf(state) {
    const duration = state.current.duration || state.current.track?.duration || 0;
    if (duration <= 0) return 0;
    return Math.min(Math.max((state.current.position || 0) / duration, 0), 1);
  }

  function applyStageCover(url) {
    if (url) {
      if (ui.cover.getAttribute('src') !== url) ui.cover.src = url;
      setHidden(ui.cover, false);
    } else {
      ui.cover.removeAttribute('src');
      setHidden(ui.cover, true);
    }
  }

  function renderStage(state) {
    const { current, queue } = state;
    const track = current.track;
    const duration = current.duration || track?.duration || 0;
    const position = Math.min(Math.max(current.position || 0, 0), duration || 0);
    const playing = Boolean(track) && current.playing;

    ui.chalk.setVisible(
      shouldShowChalk({
        hasDemo: state.queue.tracks.some(isDemoTrack),
        playing,
      }),
    );

    ui.deck.classList.toggle('is-playing', playing);
    ui.stage.classList.toggle('playing', playing);
    ui.armRotor.dataset.playing = String(playing);

    const nextId = track && track.hasCover && !track.coverSrc ? track.id : null;
    if (nextId !== stageCoverId) {
      if (stageCoverId) store.releaseCover(stageCoverId);
      stageCoverId = nextId;
      stageCoverUrl = undefined;
      stageCoverPending = null;
      stageCoverToken += 1;
    }
    if (track?.coverSrc) {
      applyStageCover(track.coverSrc);
    } else if (nextId && stageCoverUrl === undefined) {
      const token = stageCoverToken;
      if (!stageCoverPending) {
        stageCoverPending = store.coverUrl(track).then(
          (url) => {
            if (token !== stageCoverToken) return;
            stageCoverPending = null;
            stageCoverUrl = url ?? null;
            applyStageCover(stageCoverUrl);
          },
          () => {
            if (token !== stageCoverToken) return;
            stageCoverPending = null;
            stageCoverUrl = null;
            applyStageCover(null);
          },
        );
      }
      applyStageCover(null);
    } else {
      applyStageCover(nextId ? stageCoverUrl : null);
    }

    setText(ui.title, track ? track.title : t('player.noTrack'));
    if (track) {
      const parts = [artistLabel(track.artist), albumLabel(track.album)];
      if (Number.isFinite(track.year) && track.year > 0) parts.push(String(track.year));
      const children = [];
      parts.filter(Boolean).forEach((part, index) => {
        if (index > 0) children.push(el('span', { class: 'dot', text: '·' }));
        children.push(el('span', { class: index === 1 ? 'album' : '', text: part }));
      });
      ui.artist.replaceChildren(...children);
    } else {
      setText(ui.artist, t('player.noTrackHint'));
    }

    const label = playing ? t('aria.pause') : t('aria.play');
    const armState = playing
      ? t('player.statusPlaying')
      : position > 0
        ? t('player.statusPaused')
        : t('player.statusStopped');
    ui.armRotor.setAttribute('aria-label', t('aria.tonearm', { state: armState, action: label }));
    ui.armRotor.setAttribute('aria-valuemax', String(Math.round(duration)));
    ui.armRotor.setAttribute('aria-valuenow', String(Math.round(position)));
    ui.armRotor.setAttribute(
      'aria-valuetext',
      `${formatTime(position)} / ${formatTime(duration)}`,
    );

    if (playing && (!lastPlaying || track?.id !== lastTrackId)) {
      armEngageUntil = performance.now() + 850;
    }
    const tracking = playing && performance.now() >= armEngageUntil;

    if (!activeArm?.isDragging()) {
      const changed = playing !== lastPlaying || (track?.id ?? null) !== lastTrackId;
      if (!track || !playing) applyArmAngle(ARM_PARK, changed);
      else applyArmAngle(angleForProgress(progressOf(state)), changed);
      ui.armSvg.classList.toggle('is-tracking', tracking);
    }
    lastPlaying = playing;
    lastTrackId = track?.id ?? null;

    ui.shuffleButton.classList.toggle('is-on', queue.shuffle);
    ui.shuffleButton.setAttribute('aria-pressed', String(queue.shuffle));

    ui.repeatButton.classList.toggle('is-on', queue.repeat !== 'off');
    ui.repeatButton.setAttribute('aria-pressed', String(queue.repeat !== 'off'));
    ui.repeatButton.setAttribute(
      'aria-label',
      t(REPEAT_LABEL_KEY[queue.repeat] ?? REPEAT_LABEL_KEY.off),
    );
    const repeatIconName = queue.repeat === 'one' ? 'i-repeat-1' : 'i-repeat';
    if (ui.repeatUse.getAttribute('href') !== `#${repeatIconName}`) {
      ui.repeatUse.setAttribute('href', `#${repeatIconName}`);
    }
  }

  function renderTabs() {
    ui.tabButtons.forEach((button) => {
      const selected = button.dataset.tab === libraryTab;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('is-active', selected);
    });
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
        onAction: () => show('settings'),
      });
    }

    const kind =
      local.permission === 'granted'
        ? 'local'
        : (state.sources.find((row) => row.id !== 'local' && row.permission === 'granted')?.id ??
          'onedrive');
    return emptyState({
      title: t('empty.noTracksTitle'),
      text: t('empty.noTracksText'),
      actionLabel: t('empty.noTracksAction'),
      onAction: () => run(store.rescan(kind)),
    });
  }

  function rerunQuery() {
    searchToken += 1;
    const token = searchToken;
    searchResult = null;
    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) {
      render(store.state);
      scheduleVirtual();
      return;
    }
    run(
      runSearch(store.state.tracks ?? [], query).then((result) => {
        if (token !== searchToken) return;
        searchResult = { query, items: result.items, total: result.total };
        render(store.state);
        scheduleVirtual();
      }),
    );
    render(store.state);
  }

  function setQuery(value) {
    searchQuery = value;
    rerunQuery();
  }

  function renderSearch(state) {
    setHidden(ui.searchClear, !searchQuery);
    buildingCoverIds = [];

    const query = searchQuery.trim() ? searchQuery : '';
    if (!query) return;

    const result = searchResult;
    if (!result || result.query !== query) {
      replaceTrackList([el('p', { class: 'muted', 'data-testid': 'search-count' })]);
      return;
    }

    const nodes = [
      el('p', {
        class: 'search-count',
        'data-testid': 'search-count',
        text: t('search.results', { count: result.total }),
      }),
    ];
    if (result.total === 0) {
      nodes.push(el('p', { class: 'muted', 'data-testid': 'search-empty', text: t('search.empty') }));
      replaceTrackList(nodes);
      return;
    }

    const groups = [];
    for (const group of SEARCH_GROUPS) {
      const hits = result.items.filter((item) => item.group === group.id);
      if (!hits.length) continue;
      const list = el('div', { class: 'track-list' });
      nodes.push(
        el('section', { class: 'search-group' }, [
          el('h3', { 'data-testid': `search-group-${group.id}`, text: t(group.labelKey) }),
          list,
        ]),
      );
      groups.push({ list, hits });
    }
    replaceTrackList(nodes);
    for (const { list, hits } of groups) {
      mountVirtualList(list, hits.length, () => {
        const currentId = store.state.current.track?.id ?? null;
        const rows = hits.map((hit) => hit.track);
        return (index, coverIds) =>
          trackRow(rows[index], {
            now: rows[index].id === currentId,
            onActivate: () => activateTrack(store.state.tracks, rows[index].id),
            onMore: openTrackMenu,
            coverIds,
          });
      });
    }
  }

  function trackKind(track) {
    if (track.source === 'gdrive') return 'gdrive';
    if (track.source === 'dropbox') return 'dropbox';
    if (track.source === 'onedrive') return 'onedrive';
    return 'local';
  }

  function sourceDisplayName(state, kind) {
    if (kind === 'gdrive') return t('settings.source.gdrive');
    if (kind === 'dropbox') return t('settings.source.dropbox');
    if (kind === 'onedrive') return t('settings.source.onedrive');
    return t('settings.library.localGroup');
  }

  function sourceIconId(kind) {
    if (kind === 'gdrive') return 'i-hard-drive';
    if (kind === 'dropbox') return 'i-dropbox';
    if (kind === 'onedrive') return 'i-cloud';
    return 'i-folder';
  }

  function kindTracks(state, kind) {
    return (state.tracks ?? []).filter((track) => trackKind(track) === kind);
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
          scheduleVirtual();
        },
      },
      [el('span', { class: 'back-arrow', 'aria-hidden': 'true', text: '←' })],
    );

    return el('div', { class: 'folder-head' }, [
      up,
      el('span', { class: 'folder-name', text: dir || sourceDisplayName(state, kind) }),
      el('div', { class: 'folder-actions' }, [
        el('button', {
          class: 'pill',
          type: 'button',
          'data-testid': 'folder-play-all',
          text: t('common.playAll'),
          disabled: !all.length,
          onclick: () => {
            if (!all.length) return;
            pulseSwap();
            // Play all is an explicit new round. Shuffle mode keeps the
            // original track order and opens at a random position.
            const start = store.state.queue.shuffle
              ? all[Math.floor(Math.random() * all.length)].id
              : all[0].id;
            run(store.playQueue(all, start, 'user', { fresh: true }));
          },
        }),
        el('button', {
          class: 'pill quiet',
          type: 'button',
          'data-testid': 'folder-shuffle',
          text: t('common.shufflePlay'),
          disabled: !all.length,
          onclick: () => {
            if (!all.length) return;
            pulseSwap();
            run(store.shufflePlay(all));
          },
        }),
      ]),
    ]);
  }

  function renderFolders(state) {
    buildingCoverIds = [];
    if (folder.source === null) {
      const rows = [];
      for (const row of visibleSources(state.sources)) {
        const list = kindTracks(state, row.id);
        rows.push(
          sourceRow({
            id: row.id,
            label: sourceDisplayName(state, row.id),
            count: list.length,
            iconId: sourceIconId(row.id),
            onOpen: () => {
              folder = { source: row.id, dir: '' };
              render(store.state);
              scheduleVirtual();
            },
          }),
        );
      }

      replaceTrackList(
        rows.length
          ? rows
          : [el('p', { class: 'muted', 'data-testid': 'folder-empty', text: t('empty.noTracksText') })],
      );
      return;
    }

    const kind = folder.source;
    const dir = folder.dir;
    const list = kindTracks(state, kind);
    const all = tracksUnder(list, dir);
    const direct = tracksDirect(list, dir);
    const subs = subdirsOf(list, dir);

    const children = [folderHeader(state, kind, dir, all)];
    let subsBox = null;
    let tracksBox = null;
    if (subs.length) {
      children.push(el('h3', { class: 'group-head', text: t('folders.subfolders') }));
      subsBox = el('div', { class: 'track-list' });
      children.push(subsBox);
    }
    if (direct.length) {
      children.push(el('h3', { class: 'group-head', text: t('folders.tracks') }));
      tracksBox = el('div', { class: 'track-list' });
      children.push(tracksBox);
    }
    if (!subs.length && !direct.length) {
      children.push(el('p', { class: 'muted', 'data-testid': 'folder-empty', text: t('empty.noTracksText') }));
    }
    replaceTrackList(children);

    if (subsBox) {
      mountVirtualList(subsBox, subs.length, () => {
        const rows = subdirsOf(kindTracks(store.state, kind), dir);
        return (index) =>
          dirRow(rows[index], () => {
            folder = { source: kind, dir: rows[index].dir };
            render(store.state);
            scheduleVirtual();
          });
      });
    }
    if (tracksBox) {
      mountVirtualList(tracksBox, direct.length, () => {
        const list = kindTracks(store.state, kind);
        const rows = tracksDirect(list, dir);
        const all = tracksUnder(list, dir);
        const currentId = store.state.current.track?.id ?? null;
        return (index, coverIds) =>
          trackRow(rows[index], {
            now: rows[index].id === currentId,
            onActivate: () => activateTrack(all, rows[index].id),
            onMore: openTrackMenu,
            coverIds,
          });
      });
    }
  }

  function renderQueue(state) {
    buildingCoverIds = [];
    const tracks = state.queue.tracks;
    if (!tracks.length) {
      replaceTrackList([
        emptyState({
          title: t('empty.queueTitle'),
          text: t('empty.queueText'),
          actionLabel: t('empty.queueAction'),
          onAction: () => {
            libraryTab = 'folders';
            saveLibraryTab(libraryTab);
            render(store.state);
          },
        }),
      ]);
      return;
    }

    const head = el('header', { class: 'list-head' }, [
      el('span', { text: t('common.playQueue') }),
      el('div', { class: 'queue-head' }, [
        el('span', { text: t('common.trackCount', { count: tracks.length }) }),
        el('button', {
          class: 'pill quiet queue-clear',
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

    const list = el('div', { class: 'track-list' });
    replaceTrackList([head, list]);
    mountVirtualList(list, tracks.length, () => {
      const queue = store.state.queue;
      // Shuffle shows the playback order; row number = play position. The
      // original `tracks` order stays authoritative behind it.
      const order = queue.shuffle ? queue.order : null;
      const rows = order ? order.map((i) => queue.tracks[i]) : queue.tracks;
      return (index, coverIds) => {
        const trackIndex = order ? order[index] : index;
        return queueRow(rows[index], index, {
          now: trackIndex === queue.index,
          onActivate: () => {
            pulseSwap();
            run(store.jumpTo(trackIndex));
          },
          onRemove: () => store.removeQueueAt(trackIndex),
          coverIds,
        });
      };
    });
  }

  /** Row fields the folder/queue/search rows actually render. */
  const TRACK_ROW_FIELDS = [
    'title',
    'artist',
    'album',
    'year',
    'trackNo',
    'duration',
    'hasCover',
    'coverSrc',
    'source',
  ];

  /** Same count and same ids in the same order: the mounted windows stay valid. */
  function sameTrackStructure(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index]?.id !== b[index]?.id) return false;
    }
    return true;
  }

  /** Shallow row comparison: avoids repainting for an equal-content re-emit. */
  function sameTrackRows(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      const left = a[index];
      const right = b[index];
      if (left === right) continue;
      if (!left || !right || left.id !== right.id) return false;
      for (const field of TRACK_ROW_FIELDS) {
        if (left[field] !== right[field]) return false;
      }
    }
    return true;
  }

  function renderLibrary(state) {
    if (!tabChosen && libraryTab === 'queue' && hasLibraryEntry(state)) {
      libraryTab = 'folders';
      store.setView('folders');
    }
    const currentId = state.current.track?.id ?? null;
    const permissions = (state.sources ?? [])
      .map((row) => `${row.permission}:${row.trackCount ?? 0}`)
      .join(',');
    const query = searchQuery;
    const previousTracks = last.tracks;
    const tracksChanged = previousTracks !== state.tracks;
    const tracksInPlace = tracksChanged && sameTrackStructure(previousTracks, state.tracks);
    const rebuild =
      last.view !== 'library' ||
      last.tab !== libraryTab ||
      (tracksChanged && !tracksInPlace) ||
      last.stats !== state.stats ||
      permissions !== last.permissions ||
      installPromptSeen !== last.installable ||
      currentId !== last.currentId ||
      query !== last.query ||
      searchResult !== last.searchResult ||
      folder.source !== last.folderSource ||
      folder.dir !== last.folderDir ||
      (libraryTab === 'queue' &&
        (state.queue.tracks !== last.queueTracks ||
          state.queue.index !== last.queueIndex ||
          state.queue.order !== last.queueOrder));

    if (!rebuild) {
      if (tracksInPlace) {
        last.tracks = state.tracks;
        if (!sameTrackRows(previousTracks, state.tracks)) repaintVirtualLists();
      }
      return;
    }

    last.view = 'library';
    last.tab = libraryTab;
    last.tracks = state.tracks;
    last.stats = state.stats;
    last.permissions = permissions;
    last.installable = installPromptSeen;
    last.currentId = currentId;
    last.query = query;
    last.searchResult = searchResult;
    last.folderSource = folder.source;
    last.folderDir = folder.dir;
    last.queueTracks = state.queue.tracks;
    last.queueIndex = state.queue.index;
    last.queueOrder = state.queue.order;

    setHidden(ui.searchClear, !searchQuery);

    if (searchQuery.trim()) {
      renderSearch(state);
      return;
    }

    if (libraryTab === 'queue') {
      renderQueue(state);
      return;
    }

    if (!libraryVisible(state)) {
      buildingCoverIds = [];
      replaceTrackList([renderEmpty(state)]);
      return;
    }

    renderFolders(state);
  }

  function renderPanelMeta(state) {
    const count = state.tracks.length || state.queue.tracks.length;
    setText(ui.libraryKicker, t('panel.libraryKicker', { count }));
    ui.panelTitle.textContent =
      panelView === 'library'
        ? t('panel.libraryTitle')
        : panelView === 'settings'
          ? t('panel.settingsTitle')
          : t('panel.vipTitle');
  }

  function pulseSwap() {
    clearTimeout(swapTimer);
    ui.deck.classList.remove('swapping');
    void ui.deck.offsetWidth;
    ui.deck.classList.add('swapping');
    swapTimer = setTimeout(() => {
      swapTimer = 0;
      ui.deck.classList.remove('swapping');
    }, 460);
  }

  function activateTrack(list, id) {
    pulseSwap();
    run(store.playQueue(list, id));
  }

  function render(state) {
    const next = resolveLanguage(state.settings.language, browserLanguages());
    if (next !== getLocale() && hasLocale(next)) {
      setLocale(next);
      applyDocumentLang();
      remount();
      return;
    }

    renderHeader(state);
    renderStage(state);
    renderTabs();
    renderPanelMeta(state);
    renderLibrary(state);
    ui.settingsView.render(state);
    ui.vipView.render(state);
    applyPanel();

    if (state.pendingView) {
      const pending = state.pendingView;
      store.clearPendingView();
      if (pending.view === 'settings') {
        show('settings');
        const section = ui.settingsView.node.querySelector('[data-testid="settings-section-library"]');
        section?.scrollIntoView({ block: 'start' });
        if (pending.picker) {
          const picker = ui.settingsView.node.querySelector(
            `[data-testid="${pending.picker}-picker"]`,
          );
          if (picker) picker.focus({ preventScroll: true });
        }
      }
    }

    ui.permissionModal.sync(state.permissionIssue);
    setHidden(ui.updateBanner, !state.updateReady);
  }

  function remount() {
    closeMenu();
    clearTimeout(toastTimer);
    toastTimer = null;
    activeArm?.destroy();
    activeSwipe?.destroy();
    activeArm = null;
    activeSwipe = null;
    // Tear the old dialog down first: it owns a document keydown listener and
    // the body scroll lock, and the replacement shell builds a fresh one.
    ui.permissionModal.sync(null);
    ui = createShell(store, sw);
    ui.permissionModal.setSettingsHandler(handlePermissionSettings);
    resetCache();
    bindShellEvents();
    bindArm();
    bindSwipe();
    root.replaceChildren(ui.app);
    syncTheme();
    applyPanel();
    render(store.state);
    syncArm();
  }

  function togglePlayback() {
    const current = store.state.current;
    if (!current.track) {
      show('library');
      return;
    }
    const duration = current.duration || current.track.duration || 0;
    const position = current.position || 0;
    if (duration > 0 && position >= duration - 0.1) {
      run(store.seek(0));
      store.toggle();
      return;
    }
    store.toggle();
  }

  function bindArm() {
    activeArm = bindTonearm({
      svg: ui.armSvg,
      rotor: ui.armRotor,
      handle: ui.armHandle,
      getProgress: () => progressOf(store.state),
      getDuration: () => store.state.current.duration || store.state.current.track?.duration || 0,
      getPosition: () => store.state.current.position || 0,
      onToggle: togglePlayback,
      onSeek: (seconds) => {
        run(store.seek(seconds));
        syncArm();
      },
      onPause: () => {
        if (store.state.current.playing) store.pause();
      },
      onResume: () => {
        if (!store.state.current.playing) store.toggle();
        syncArm();
      },
    });
  }

  function bindSwipe() {
    activeSwipe = bindStageSwipe(ui.app.querySelector('.stage'), {
      onPrev: () => {
        if (!store.state.current.track) return;
        pulseSwap();
        run(store.prev('gesture'));
      },
      onNext: () => {
        if (!store.state.current.track) return;
        pulseSwap();
        run(store.next('gesture'));
      },
    });
  }

  // Registered exactly once per app mount, never per remount: a browser
  // language change only moves the app while the setting stays `auto`.
  let languageChangeBusy = false;
  async function followBrowserLanguage() {
    if (store.state.settings.language !== 'auto' || languageChangeBusy) return;
    languageChangeBusy = true;
    try {
      const next = resolveLocale(browserLanguages());
      const loaded = await ensureLocale(next);
      if (loaded !== next || getLocale() === next) return;
      setLocale(next);
      applyDocumentLang();
      remount();
    } finally {
      languageChangeBusy = false;
    }
  }
  window.addEventListener('languagechange', followBrowserLanguage);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key !== 'Escape') return;
    if (document.querySelector('.modal:not([hidden])')) return;
    const mobile = isMobile();
    if (mobile ? panelView !== 'library' : panelOpen) {
      event.preventDefault();
      closePanel();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.code !== 'Space') return;
    if (document.querySelector('.modal:not([hidden])')) return;
    const target = event.target;
    if (
      target?.closest?.('input, textarea, select, [contenteditable="true"], #armRotor')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    togglePlayback();
  }, true);

  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], #armRotor')) {
      return;
    }
    // A focused button would otherwise turn Space keyup into a click.
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // Left/right change tracks. Registered in the bubble phase so list widgets
  // such as the language radiogroup that call preventDefault keep their own
  // arrow-key navigation.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], #armRotor')) return;
    if (!store.state.current.track) return;
    event.preventDefault();
    pulseSwap();
    run(dir > 0 ? store.next('keyboard') : store.prev('keyboard'));
  });

  bindShellEvents();
  bindArm();
  bindSwipe();
  root.replaceChildren(ui.app);
  syncTheme();
  applyPanel();
  render(store.state);
  if (panelView === 'settings') store.setView('settings');
  else if (panelView === 'vip') store.setView('vip');

  window.addEventListener('beforeinstallprompt', () => {
    installPromptSeen = true;
    render(store.state);
  });

  let frame = 0;
  store.addEventListener('change', () => {
    if (frame || document.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render(store.state);
      syncArm();
      // The Web Audio graph swaps the element, so re-attach the stall hooks.
      watchAudio();
      if (store.state.current.playing) {
        clearTimeout(idleStop);
        idleStop = 0;
      } else if (lowPower && !idleStop) {
        idleStop = setTimeout(() => {
          idleStop = 0;
          applyLowPower(false);
          gate.clear();
        }, 30_000);
      }
    });
  });

  function applyArmAngle(angle, force = false) {
    if (!force && armLastAngle !== null && Math.abs(angle - armLastAngle) <= ARM_MIN_ANGLE) {
      return;
    }
    ui.armRotor.style.transform = `rotate(${angle.toFixed(3)}deg)`;
    armLastAngle = angle;
  }

  /** One arm paint from the live audio clock; no self-renewal. */
  function paintArmOnce(now = performance.now(), { force = false } = {}) {
    if (activeArm?.isDragging()) return;
    const current = store.state.current;
    if (!current.playing) {
      if (force || armLastAngle !== ARM_PARK) applyArmAngle(ARM_PARK, true);
      ui.armSvg.classList.remove('is-tracking');
      return;
    }
    const duration = current.duration || current.track?.duration || 0;
    const live = Number(store.audio?.currentTime);
    const position = Number.isFinite(live)
      ? Math.min(Math.max(live, 0), duration || live)
      : current.position || 0;
    if (duration > 0) {
      applyArmAngle(angleForProgress(position / duration), force);
      if (now >= armEngageUntil) ui.armSvg.classList.add('is-tracking');
    }
  }

  function armInterval() {
    return lowPower || prefersReducedMotion.matches
      ? ARM_LOW_POWER_INTERVAL_MS
      : ARM_INTERVAL_MS;
  }

  function armTick(now) {
    armFrame = 0;
    if (document.hidden || !store.state.current.playing) return;
    if (lastFrameAt) {
      if (gate.noteFrameGap(now - lastFrameAt, now)) {
        react(now);
        armDecay(now);
      }
    }
    lastFrameAt = now;
    if (now - armLastPaintAt >= armInterval()) {
      armLastPaintAt = now;
      paintArmOnce(now);
    }
    scheduleArm();
  }

  function scheduleArm() {
    if (armFrame || armTimer) return;
    if (!store.state.current.playing || document.hidden) return;
    if (lowPower || prefersReducedMotion.matches) {
      armTimer = setTimeout(() => {
        armTimer = 0;
        armLastPaintAt = performance.now();
        paintArmOnce();
        scheduleArm();
      }, ARM_LOW_POWER_INTERVAL_MS);
      return;
    }
    armFrame = requestAnimationFrame(armTick);
  }

  function stopArm() {
    cancelAnimationFrame(armFrame);
    clearTimeout(armTimer);
    armFrame = 0;
    armTimer = 0;
    armLastPaintAt = 0;
    lastFrameAt = 0;
  }

  function react(now) {
    const decision = gate.verdict(now, lowPower, lowPowerSince);
    if (decision === 'enter') applyLowPower(true);
    else if (decision === 'exit') applyLowPower(false);
  }

  function applyLowPower(on) {
    if (lowPower === on) return;
    lowPower = on;
    lowPowerSince = on ? performance.now() : 0;
    document.documentElement.classList.toggle('is-low-power', on);
    store.setLowPower(on);
    stopArm();
    scheduleArm();
    paintArmOnce(performance.now(), { force: true });
  }

  /** Keep a verdict check alive until the trigger window has drained. */
  function armDecay() {
    clearTimeout(lowPowerDecay);
    lowPowerDecay = setTimeout(() => {
      const now = performance.now();
      react(now);
      if (lowPower) armDecay();
    }, LOW_POWER_WINDOW_MS);
  }

  function watchAudio() {
    const audio = store.audio;
    if (!audio || audio === watchedAudio) return;
    watchedAudio = audio;
    const hit = () => {
      // The initial `waiting` fires with the loadstart and carries no data:
      // that is normal startup buffering, not playback pressure.
      if (audio.readyState < 2) return;
      const now = performance.now();
      gate.noteAudio(now);
      react(now);
      armDecay();
    };
    audio.addEventListener('waiting', hit);
    audio.addEventListener('stalled', hit);
  }

  try {
    new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) gate.noteLongTask(entry.duration, now);
      react(now);
      armDecay();
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    // longtask unsupported: frame gaps and audio stalls still drive the gate.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopArm();
      return;
    }
    // Store changes were dropped while hidden; paint the current state once.
    render(store.state);
    scheduleVirtual();
    watchAudio();
    if (!store.state.current.playing) {
      syncArm();
      return;
    }
    armLastPaintAt = 0;
    lastFrameAt = 0;
    paintArmOnce(performance.now(), { force: true });
    scheduleArm();
  });

  prefersReducedMotion.addEventListener?.('change', () => {
    if (store.state.current.playing) scheduleArm();
  });

  /** Playing: keep the frame loop alive. Idle/paused: park once and stop. */
  function syncArm() {
    if (store.state.current.playing) {
      scheduleArm();
    } else {
      stopArm();
      paintArmOnce();
    }
  }

  watchAudio();
  syncArm();
}
