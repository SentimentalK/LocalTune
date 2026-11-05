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
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  search:
    'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  more: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  folder: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  crown:
    'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664A1 1 0 0 0 8.61 8.87z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
  refresh:
    'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
  pencil:
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  trash:
    'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z',
  onedrive:
    'M4.92 17.562c-.499.305-1.059.457-1.68.457-.92-.029-1.68-.346-2.287-.951-.607-.601-.922-1.367-.953-2.282.016-.862.291-1.594.83-2.192.54-.601 1.225-.948 2.058-1.05-.03-.178-.042-.367-.042-.566.03-1.14.42-2.084 1.17-2.819.754-.735 1.7-1.125 2.842-1.155.719 0 1.364.165 1.934.51.48-.766 1.096-1.395 1.861-1.859.779-.465 1.65-.705 2.609-.721 1.291.03 2.385.436 3.314 1.215.93.78 1.516 1.785 1.756 3.03h-.285c-.465 0-.869.06-1.23.194-.479-.51-1.035-.898-1.664-1.169-.615-.271-1.29-.39-2.011-.39-.66 0-1.29.104-1.89.33-.6.225-1.14.539-1.62.959-.42.36-.765.766-1.05 1.23s-.48.96-.585 1.485c-.36.075-.705.179-1.021.314-.51.239-.944.569-1.289 1.005-.33.375-.586.811-.75 1.305-.165.496-.256 1.006-.256 1.545 0 .6.091 1.156.301 1.666l-.062-.091zm16.848-3.747c1.576.391 2.318 1.24 2.318 2.598 0 .464-.062.914-.187 1.35-.125.435-.313.83-.563 1.185-.25.355-.562.665-.937.93-.375.265-.799.44-1.272.525-.248.06-.51.09-.787.09H9.68c-.03 0-.06-.008-.09-.023-.03-.016-.045-.046-.045-.09v-1.005c0-.045.015-.075.045-.09.03-.015.06-.023.09-.023h10.66c.378 0 .73-.09 1.058-.27.33-.18.596-.42.799-.72.202-.3.303-.63.303-.99 0-.54-.19-.99-.57-1.35-.38-.36-.84-.54-1.38-.54h-1.35c-.045 0-.075-.015-.09-.045-.015-.03-.023-.06-.023-.09v-1.02c0-.045.008-.075.023-.09.015-.03.045-.045.09-.045.09 0 .18-.008.27-.023.09-.015.18-.03.27-.045z',
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
