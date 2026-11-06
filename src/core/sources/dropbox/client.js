/**
 * Dropbox API client: RPC (JSON) and content (download) endpoints.
 *
 * Pure logic plus injectable fetch: no DOM, no storage, no UI. Only the two
 * CORS-enabled hosts in `config.js` are called.
 */

import { DROPBOX_CONTENT_URL, DROPBOX_RPC_URL } from './config.js';

export class DropboxError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string|null, cause?: unknown }} [options]
   */
  constructor(message, { status = 0, code = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DropboxError';
    this.status = status;
    this.code = code;
  }
}

export const DROPBOX_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'flac',
  'wav',
  'ogg',
  'aac',
  'opus',
]);

/** Lowercase extension after the last dot, or `''` when there is none. */
export function extensionOf(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Whether a file name carries a supported audio extension. */
export function isAudioName(name) {
  return DROPBOX_AUDIO_EXTENSIONS.has(extensionOf(name));
}

/** Strip leading/trailing slashes and empty segments; join with `/`. */
export function cleanPath(path) {
  return String(path ?? '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** Dropbox API path: `''` for the root, otherwise `/<clean path>`. */
export function apiPath(path) {
  const clean = cleanPath(path);
  return clean === '' ? '' : `/${clean}`;
}

/**
 * App path of `dropboxPath` relative to `rootPath`. Paths outside the chosen
 * root are returned cleaned but unchanged.
 */
export function relativeToRoot(rootPath, dropboxPath) {
  const root = cleanPath(rootPath);
  const full = cleanPath(dropboxPath);
  if (root === '') return full;
  const lowerRoot = root.toLowerCase();
  const lowerFull = full.toLowerCase();
  if (lowerFull === lowerRoot) return '';
  if (lowerFull.startsWith(lowerRoot + '/')) return full.slice(root.length + 1);
  return full;
}

/** Files (not folders, not hidden) with a supported audio extension. */
export function audioEntries(entries) {
  return entries.filter(
    (entry) =>
      entry?.['.tag'] === 'file' &&
      typeof entry.name === 'string' &&
      !entry.name.startsWith('.') &&
      isAudioName(entry.name),
  );
}

/** Parse JSON, returning null instead of throwing. */
function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Best-effort error tag out of a Dropbox error payload. */
function errorTag(payload) {
  return payload?.error_summary?.split('/')[0] ?? payload?.error?.['.tag'] ?? null;
}

/**
 * Create a Dropbox client bound to a token getter.
 * @param {{ fetchImpl?: typeof fetch, getToken?: () => string|Promise<string> }} [options]
 */
export function createDropboxClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getToken = () => '',
} = {}) {
  async function authHeaders() {
    return { Authorization: `Bearer ${await getToken()}` };
  }

  async function rpc(endpoint, body = {}) {
    const response = await fetchImpl(`${DROPBOX_RPC_URL}${endpoint}`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      const payload = parseJson(await response.text());
      throw new DropboxError(
        payload?.error_summary || payload?.error?.tag || `HTTP ${response.status}`,
        { status: response.status, code: errorTag(payload) },
      );
    }
    return response.json();
  }

  // Whole-file only: HTTP `Range` is not a CORS-safelisted request header and
  // Dropbox does not expose range reads from the browser.
  async function download(path) {
    const response = await fetchImpl(`${DROPBOX_CONTENT_URL}/files/download`, {
      method: 'POST',
      headers: {
        ...(await authHeaders()),
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const payload = parseJson(await response.text());
      throw new DropboxError(
        payload?.error_summary || payload?.error?.['.tag'] || `HTTP ${response.status}`,
        { status: response.status, code: errorTag(payload) },
      );
    }
    return {
      blob: await response.blob(),
      metadata: parseJson(response.headers.get('Dropbox-API-Result')),
    };
  }

  async function* listFolder({
    path = '',
    recursive = false,
    limit = 1000,
    includeDeleted = false,
  } = {}) {
    let page = await rpc('/files/list_folder', {
      path,
      recursive,
      limit,
      include_deleted: includeDeleted,
      include_non_downloadable_files: false,
    });
    for (;;) {
      yield* page.entries ?? [];
      if (!page.has_more || !page.cursor) return;
      page = await rpc('/files/list_folder/continue', { cursor: page.cursor });
    }
  }

  return { rpc, download, listFolder };
}
