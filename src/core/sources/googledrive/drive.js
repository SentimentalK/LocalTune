/**
 * Minimal Google Drive v3 client: listing, query builders and media reads.
 *
 * Pure logic plus an injectable fetch: no gapi script, no DOM, no token
 * storage. Callers pass `getToken` and decide where tokens live.
 */

export class GdriveError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string|number|null }} [options]
   */
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'GdriveError';
    this.status = status;
    this.code = code;
  }
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FOLDER_FIELDS = 'nextPageToken,files(id,name,mimeType)';
export const FILE_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)';

/**
 * Escape a value for a Drive query string: backslash first, then the quote.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeQueryValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/** Folders directly under `parentId`. */
export function folderChildrenQuery(parentId) {
  return `'${escapeQueryValue(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
}

/** The folder named `name` directly under `parentId`. */
export function namedFolderQuery(parentId, name) {
  return `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
}

/** Every untrashed child (folder or file) directly under `parentId`. */
export function allChildrenQuery(parentId) {
  return `'${escapeQueryValue(parentId)}' in parents and trashed = false`;
}

function resolveUrl(baseUrl, url) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

async function readErrorPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getToken: () => string|Promise<string>,
 *   baseUrl?: string,
 * }} [options]
 */
export function createDriveClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getToken,
  baseUrl = 'https://www.googleapis.com/drive/v3',
} = {}) {
  async function getJson(url) {
    const token = await getToken();
    const response = await fetchImpl(resolveUrl(baseUrl, url), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const payload = await readErrorPayload(response);
      throw new GdriveError(payload?.error?.message || `HTTP ${response.status}`, {
        status: response.status,
        code: payload?.error?.code ?? null,
      });
    }
    return response.json();
  }

  /**
   * One page of `files` at a time; `nextPageToken` drives the loop.
   * @param {{ q: string, fields?: string, pageSize?: number, orderBy?: string|null, pageToken?: string|null }} params
   */
  async function* list({
    q,
    fields = FILE_FIELDS,
    pageSize = 1000,
    orderBy = null,
    pageToken = null,
  }) {
    let token = pageToken ?? null;
    for (;;) {
      const search = new URLSearchParams();
      search.set('q', q);
      search.set('fields', fields);
      search.set('pageSize', String(pageSize));
      if (orderBy) search.set('orderBy', orderBy);
      if (token) search.set('pageToken', token);

      const page = await getJson(`/files?${search.toString()}`);
      yield page?.files ?? [];
      token = page?.nextPageToken;
      if (!token) return;
    }
  }

  /** Every page flattened into one array. */
  async function listFiles(params) {
    const files = [];
    for await (const page of list(params)) files.push(...page);
    return files;
  }

  function mediaUrl(id) {
    return `${baseUrl}/files/${encodeURIComponent(id)}?alt=media`;
  }

  /**
   * Whole body, or one byte range when the server honours it. A `200` status
   * means the range was ignored and `bytes` is the whole file.
   * @param {string} id
   * @param {{ range?: { start: number, end: number }|null }} [options]
   * @returns {Promise<{ bytes: Uint8Array, status: number }>}
   */
  async function fetchMedia(id, { range = null } = {}) {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    const response = await fetchImpl(mediaUrl(id), { method: 'GET', headers });
    if (response.status < 200 || response.status >= 300) {
      const payload = await readErrorPayload(response);
      throw new GdriveError(payload?.error?.message || `HTTP ${response.status}`, {
        status: response.status,
        code: payload?.error?.code ?? null,
      });
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      status: response.status,
    };
  }

  return { getJson, list, listFiles, mediaUrl, fetchMedia };
}
