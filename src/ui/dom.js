/**
 * Tiny DOM helpers. Text always goes through textContent; user data is never
 * interpolated into markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  shuffle:
    'M17 4l4 4-4 4V9h-2.2l-2.6 3 2.6 3H17v-3l4 4-4 4v-3h-3.1l-3.2-3.8L7.5 17H3v-2h3.6l2.6-3-2.6-3H3V7h4.5l3.2 3.8L13.9 7H17z',
  prev: 'M6 5h2v14H6zm12 0v14L9 12z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  next: 'M16 5h2v14h-2zM6 5l9 7-9 7z',
  repeat: 'M7 7h10V4l4 4-4 4V9H9v3H7zm10 10H7v3l-4-4 4-4v3h8v-3h2z',
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

/** Inline SVG icon; decorative, so hidden from assistive tech. */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

// One object URL per cover Blob for the life of the page; revoked only when a
// rescan drops the track that owned it.
const coverUrls = new Map();

export function coverUrl(blob) {
  if (!blob) return null;
  const cached = coverUrls.get(blob);
  if (cached) return cached;
  const url = URL.createObjectURL(blob);
  coverUrls.set(blob, url);
  return url;
}

export function syncCoverCache(blobs) {
  const keep = new Set(blobs);
  for (const [blob, url] of coverUrls) {
    if (keep.has(blob)) continue;
    URL.revokeObjectURL(url);
    coverUrls.delete(blob);
  }
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
