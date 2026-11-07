/** Small, synchronous UI preferences that must be readable before paint. */

const THEME_KEY = 'localtune-theme';
const PANEL_KEY = 'localtune-panel';
const PANEL_OPEN_KEY = 'localtune-panel-open';
const TAB_KEY = 'localtune-library-tab';
const GDRIVE_BETA_ACK_KEY = 'localtune:gdriveBetaAck';

/** Bumping this re-asks every browser once after the beta copy changes. */
export const GDRIVE_BETA_ACK_VALUE = 'v1';

/** The theme whose tokens live in plain `:root`; also the storage fallback. */
export const DEFAULT_THEME = 'blue';

export const THEMES = [
  'blue',
  'burgundy',
  'forest',
  'obsidian',
  'aubergine',
  'graphite',
  'petrol',
  'espresso',
  'ink',
  'sage',
];
export const THEME_NAMES = {
  blue: 'Midnight Blue',
  burgundy: 'Oxblood Burgundy',
  forest: 'Forest Noir',
  obsidian: 'Obsidian',
  aubergine: 'Aubergine',
  graphite: 'Graphite',
  petrol: 'Petrol',
  espresso: 'Espresso',
  ink: 'Ink Blue',
  sage: 'Morandi Sage',
};

function read(key, fallback) {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private mode or a blocked storage partition: the UI still works.
  }
}

export function currentTheme() {
  const value = read(THEME_KEY, DEFAULT_THEME);
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function saveTheme(theme) {
  write(THEME_KEY, THEMES.includes(theme) ? theme : DEFAULT_THEME);
}

export function loadPanel() {
  const view = read(PANEL_KEY, 'library');
  return ['library', 'settings', 'vip'].includes(view) ? view : 'library';
}

export function savePanel(view) {
  write(PANEL_KEY, view);
}

export function loadPanelOpen() {
  return read(PANEL_OPEN_KEY, 'true') === 'true';
}

export function savePanelOpen(open) {
  write(PANEL_OPEN_KEY, open ? 'true' : 'false');
}

export function loadLibraryTab() {
  const value = read(TAB_KEY, '');
  return value === 'queue' || value === 'folders' ? value : null;
}

export function saveLibraryTab(tab) {
  write(TAB_KEY, tab);
}

/**
 * Whether this browser already accepted the Google Drive beta notice. The
 * stored value is versioned so a copy rewrite can ask once again.
 * @param {{ getItem: (key: string) => string|null }} [storage]
 */
export function loadGdriveBetaAck(storage = safeStorage()) {
  try {
    return storage?.getItem(GDRIVE_BETA_ACK_KEY) === GDRIVE_BETA_ACK_VALUE;
  } catch {
    return false;
  }
}

/** Remember the beta notice; a blocked storage simply asks again next time. */
export function saveGdriveBetaAck(storage = safeStorage()) {
  try {
    storage?.setItem(GDRIVE_BETA_ACK_KEY, GDRIVE_BETA_ACK_VALUE);
  } catch {
    // Private mode or a blocked storage partition: the flow still proceeds.
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
