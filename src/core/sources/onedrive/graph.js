/**
 * Minimal Microsoft Graph client for OneDrive browsing and ranged downloads.
 *
 * Pure logic plus an injectable fetch: no DOM, no token storage. Callers pass
 * `getToken` and decide where tokens live.
 */

const DEFAULT_ITEM_SELECT =
  'id,name,size,file,folder,lastModifiedDateTime,parentReference,@microsoft.graph.downloadUrl';

export class GraphError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string|null }} [options]
   */
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
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
export function createGraphClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getToken,
  baseUrl = 'https://graph.microsoft.com/v1.0',
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
      throw new GraphError(payload?.error?.message || `HTTP ${response.status}`, {
        status: response.status,
        code: payload?.error?.code ?? null,
      });
    }
    return response.json();
  }

  async function* listChildren(
    driveId,
    itemId,
    {
      select = 'id,name,size,file,folder,lastModifiedDateTime,parentReference',
      top = 200,
    } = {},
  ) {
    const query = `?$top=${top}&$select=${encodeURIComponent(select)}`;
    const id = encodeURIComponent(itemId);
    let page = await getJson(`/drives/${driveId}/items/${id}/children${query}`);
    for (;;) {
      for (const item of page.value ?? []) yield item;
      const nextLink = page['@odata.nextLink'];
      if (!nextLink) break;
      page = await getJson(nextLink);
    }
  }

  function getItem(driveId, itemId) {
    // `@` in the annotation is a reserved character. Left raw, some Graph
    // front doors drop `@microsoft.graph.downloadUrl` from `$select`.
    const id = encodeURIComponent(itemId);
    const select = encodeURIComponent(DEFAULT_ITEM_SELECT);
    return getJson(`/drives/${driveId}/items/${id}?$select=${select}`);
  }

  async function getDownloadUrl(driveId, itemId) {
    const item = await getItem(driveId, itemId);
    const url = item?.['@microsoft.graph.downloadUrl'];
    if (!url) {
      throw new GraphError('item has no download url', { code: 'noDownloadUrl' });
    }
    return url;
  }

  async function fetchRange(url, start, end) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new GraphError(`HTTP ${response.status}`, { status: response.status });
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      status: response.status,
    };
  }

  return { getJson, listChildren, getItem, getDownloadUrl, fetchRange };
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'flac', 'ogg', 'oga', 'wav', 'webm']);

/**
 * Filter Graph drive items down to playable audio files.
 * @param {Array<Record<string, any>>} items
 * @returns {Array<Record<string, any>>}
 */
export function audioEntries(items) {
  return (items ?? []).filter((item) => {
    if (!item?.file) return false;
    const name = typeof item.name === 'string' ? item.name : '';
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  });
}

/**
 * POSIX-style path join that never emits leading/trailing or doubled slashes.
 * @param {string} parentPath
 * @param {string} name
 * @returns {string}
 */
export function itemPath(parentPath, name) {
  return [parentPath, name]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/**
 * Strip a known root prefix from a path.
 * @param {string} rootPath
 * @param {string} itemPathValue
 * @returns {string}
 */
export function relativeToRoot(rootPath, itemPathValue) {
  const root = itemPath(rootPath, '');
  const item = (itemPathValue ?? '').replace(/^\/+/, '');
  if (!root) return item;
  if (item === root) return '';
  if (item.startsWith(`${root}/`)) return item.slice(root.length + 1);
  throw new Error(`path "${itemPathValue}" is outside root "${rootPath}"`);
}
