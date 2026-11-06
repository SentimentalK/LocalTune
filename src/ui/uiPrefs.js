/** Small, synchronous UI preferences that must be readable before paint. */

const THEME_KEY = 'localtune-theme';
const PANEL_KEY = 'localtune-panel';
const PANEL_OPEN_KEY = 'localtune-panel-open';
const TAB_KEY = 'localtune-library-tab';

export const THEMES = ['blue', 'burgundy', 'forest'];
export const THEME_NAMES = {
  blue: 'Midnight Blue',
  burgundy: 'Oxblood Burgundy',
  forest: 'Forest Noir',
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
  const value = read(THEME_KEY, 'blue');
  return THEMES.includes(value) ? value : 'blue';
}

export function saveTheme(theme) {
  write(THEME_KEY, THEMES.includes(theme) ? theme : 'blue');
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
