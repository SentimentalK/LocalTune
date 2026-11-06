/**
 * Tiny DOM helpers. Text always goes through textContent; user data is never
 * interpolated into markup. Glyphs use a Lucide-style stroke set.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  shuffle:
    'M18 4l3 3-3 3M3 7h3.6a4 4 0 0 1 3.3 1.7l5.1 7.6a4 4 0 0 0 3.3 1.7H21M18 14l3 3-3 3M3 17h3.6a4 4 0 0 0 3.3-1.7l1.1-1.6M21 7h-1.7a4 4 0 0 0-3.3 1.7l-.6.9',
  prev: 'M19 20 9 12l10-8v16zM5 19V5',
  play: 'M6 3l14 9-14 9V3z',
  pause: 'M10 4H6v16h4V4zM18 4h-4v16h4V4z',
  next: 'M5 4l10 8-10 8V4zM19 5v14',
  repeat: 'm17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14m-4 14 4-4-4-4M21 13v1a4 4 0 0 1-4 4H3',
  'repeat-one':
    'm17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14m-4 14 4-4-4-4M21 13v1a4 4 0 0 1-4 4H3M11 10h1v4',
  gear:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16ZM21 21l-4.3-4.3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  crown:
    'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 6.87a1 1 0 0 0 1.417.294l3.176-2.383a.5.5 0 0 1 .794.52l-1.7 9.36a1 1 0 0 1-.984.815H5.906a1 1 0 0 1-.984-.816l-1.7-9.36a.5.5 0 0 1 .794-.518L7.193 7.16A1 1 0 0 0 8.61 6.867zM5 21h14',
  close: 'M18 6 6 18M6 6l12 12',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  check: 'M20 6 9 17l-5-5',
  onedrive: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  gdrive:
    'M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01',
  dropbox:
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
};

function appendChild(node, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
    return;
  }
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * el('button', { class: 'btn', type: 'button', onclick: fn }, ['文本'])
 * Strings/numbers become text nodes; nodes are appended as-is.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'value' || key === 'checked') node[key] = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  appendChild(node, children);
  return node;
}

/** Swap the glyph of an existing icon element without replacing the node. */
export function setIcon(svg, name) {
  const path = svg.querySelector('path');
  const d = ICONS[name] ?? '';
  if (path.getAttribute('d') !== d) path.setAttribute('d', d);
  return svg;
}

/** Inline SVG icon; decorative, so hidden from assistive tech. */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.append(document.createElementNS(SVG_NS, 'path'));
  return setIcon(svg, name);
}

/** Reference an icon symbol from the shell sprite (stroke icons). */
export function symbolIcon(id, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export function setText(node, value) {
  const text = String(value ?? '');
  if (node.textContent !== text) node.textContent = text;
}

export function setHidden(node, hidden) {
  const value = Boolean(hidden);
  if (value) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
  if ('hidden' in node) node.hidden = value;
}
