/**
 * OneDrive library source. Owns the OAuth redirect, token storage in `meta`,
 * the root folder choice, recursive scanning and ranged/whole-file reads.
 *
 * Tokens never leave `meta`: they are not logged and never rendered. The
 * refresh token of a consumer SPA lives 24 h; after that the user has to go
 * through the top-level authorization redirect again.
 *
 * The PKCE state also lives in `meta` (IndexedDB), not sessionStorage: the
 * installed PWA hands the Microsoft redirect to a new browsing context (an
 * Android Custom Tab), where sessionStorage is empty but IndexedDB is shared.
 */

import {
  PKCE_KEY,
  PKCE_TTL_MS,
  buildAuthorizeUrl,
  buildTokenRequest,
  codeChallenge,
  createCodeVerifier,
  isTokenExpired,
  parseAuthResponse,
  randomState,
  requestToken,
} from './auth.js';
import { audioEntries, createGraphClient, itemPath } from './graph.js';
import { createRemoteFile } from './remoteFile.js';
import { cacheKey } from '../../cache/audioCache.js';
import { t } from '../../../i18n/index.js';

const SILENT_KEY = 'onedriveSilent';
const SILENT_WINDOW_MS = PKCE_TTL_MS;
const ITEM_SELECT =
  'id,name,size,file,folder,lastModifiedDateTime,parentReference,@microsoft.graph.downloadUrl';

function cleanPath(path) {
  return String(path ?? '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function encodePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export { PKCE_TTL_MS };

export class OneDriveSource {
  kind = 'onedrive';
  trackSource = 'onedrive';
  cacheWholeFiles = true;
  name = '';

  constructor({
    meta,
    fetchImpl = (...args) => globalThis.fetch(...args),
    cache = null,
    location = globalThis.location,
    history = globalThis.history,
    now = () => Date.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!meta) throw new Error('OneDriveSource requires a meta store');
    this.meta = meta;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.location = location;
    this.history = history;
    this.now = now;
    this.wait = wait;

    this.authError = null;
    this.authStage = null;
    this._token = null;
    this._root = null;
    this._items = {};
    this._permission = 'none';
    this._driveId = null;

    this.client = createGraphClient({
      fetchImpl,
      getToken: async () => (await this._validToken()).accessToken,
    });
  }

  get redirectUri() {
    return `${this.location.origin}/`;
  }

  permission() {
    return this._permission;
  }

  hasRoot() {
    return Boolean(this._root);
  }

  root() {
    return this._root ? { ...this._root } : null;
  }

  /** Full-page authorization redirect; returns after `location.assign`. */
  async startLogin({ prompt = 'select_account' } = {}) {
    const verifier = createCodeVerifier();
    const challenge = await codeChallenge(verifier);
    const state = randomState();
    const redirectUri = this.redirectUri;
    await this._setMeta(PKCE_KEY, { verifier, state, redirectUri, at: this.now() });
    const url = buildAuthorizeUrl({ redirectUri, codeChallenge: challenge, state });
    this.location.assign(prompt ? `${url}&prompt=${encodeURIComponent(prompt)}` : url);
    return 'redirecting';
  }

  /**
   * Complete the authorization-code exchange after the redirect. The state
   * machine lives in a lazy chunk: plain startup (no OAuth response in the
   * URL) never downloads it.
   */
  async handleRedirect(search = this.location.search) {
    const params = parseAuthResponse(search ?? '');
    if (!params.code && !params.error) return false;
    const { handleRedirect } = await import('./redirect.js');
    return handleRedirect(this, params);
  }

  /** Read token, root and item map from `meta`. No network. */
  async restore() {
    const token = await this._getMeta('onedriveToken');
    const root = await this._getMeta('onedriveRoot');
    const items = await this._getMeta('onedriveItems');

    this._token = token && typeof token === 'object' ? token : null;
    this._root = root && typeof root === 'object' ? root : null;
    this._items = items && typeof items === 'object' ? items : {};
    this.name = this._root?.name ?? '';

    if (!this._token) this._permission = 'none';
    else this._permission = isTokenExpired(this._token, this.now()) ? 'prompt' : 'granted';
    return this._permission;
  }

  /** Refresh an expired token when a refresh token is still present. */
  async ensurePermission() {
    if (this._token && !isTokenExpired(this._token, this.now())) {
      this._permission = 'granted';
      return true;
    }
    const refreshToken = this._token?.refreshToken;
    if (!refreshToken) {
      this._permission = this._token ? 'prompt' : 'none';
      return false;
    }
    try {
      const token = await requestToken(
        buildTokenRequest({ refreshToken, redirectUri: this.redirectUri }),
        this.fetchImpl,
      );
      this._token = token;
      await this.meta.set('onedriveToken', token);
      await this.meta.set('onedriveAuthAt', this.now());
      this._permission = 'granted';
      return true;
    } catch {
      this._token = null;
      await this._setMeta('onedriveToken', null);
      this._permission = 'prompt';
      return false;
    }
  }

  /**
   * List folders under `path`. `path` is relative to the **drive** root
   * (`browse('')` lists `/drives/{id}/root/children`), not to the chosen
   * library root; the picker navigates the whole drive.
   */
  async browse(path = '') {
    if (!(await this.ensurePermission())) {
      throw new Error(t('error.onedrive.authRequired'));
    }
    const driveId = await this._driveIdOrFetch();
    const clean = cleanPath(path);
    const children =
      clean === ''
        ? this._rootChildren(driveId)
        : this.client.listChildren(driveId, await this._browseItemId(driveId, clean), {
            select: ITEM_SELECT,
            top: 200,
          });

    const folders = [];
    for await (const item of children) {
      if (!item?.folder || typeof item.name !== 'string') continue;
      folders.push({
        id: item.id,
        name: item.name,
        path: itemPath(clean, item.name),
        isFolder: true,
      });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return folders;
  }

  /** Drive-relative item lookup; never consults the root-relative item map. */
  async _browseItemId(driveId, path) {
    const item = await this.client.getJson(`/drives/${driveId}/root:/${encodePath(path)}:`);
    if (!item?.id) throw new Error(t('error.onedrive.fetchFailed'));
    return item.id;
  }

  async *_rootChildren(driveId) {
    let page = await this.client.getJson(
      `/drives/${driveId}/root/children?$top=200&$select=${encodeURIComponent(ITEM_SELECT)}`,
    );
    for (;;) {
      for (const item of page.value ?? []) yield item;
      const nextLink = page['@odata.nextLink'];
      if (!nextLink) break;
      page = await this.client.getJson(nextLink);
    }
  }

  async setRoot({ driveId = null, itemId, path, name }) {
    const resolved = driveId ?? (await this._driveIdOrFetch());
    const root = {
      driveId: resolved,
      itemId,
      path: cleanPath(path),
      name: name ?? '',
    };
    this._root = root;
    this.name = root.name;
    this._permission = 'granted';
    await this.meta.set('onedriveRoot', root);
    return { ...root };
  }

  async forget() {
    this._token = null;
    this._root = null;
    this._items = {};
    this._driveId = null;
    this._permission = 'none';
    this.name = '';
    await this._setMeta('onedriveToken', null);
    await this._setMeta('onedriveRoot', null);
    await this._setMeta('onedriveItems', null);
  }

  /**
   * Walk the chosen root and yield audio entries. The item map is persisted
   * when the walk ends or is aborted.
   */
  async *scan({ signal } = {}) {
    if (!(await this.ensurePermission())) {
      throw new Error(t('error.onedrive.authRequired'));
    }
    if (!this._root) throw new Error(t('error.onedrive.authRequired'));
    const driveId = await this._driveIdOrFetch();
    const items = { ...(this._items ?? {}) };
    const self = this;

    async function* walk(itemId, parentPath) {
      for await (const item of self.client.listChildren(driveId, itemId, {
        select: ITEM_SELECT,
        top: 200,
      })) {
        if (signal?.aborted) return;
        if (!item || typeof item.name !== 'string' || item.name.startsWith('.')) continue;
        const path = itemPath(parentPath, item.name);
        if (item.folder) {
          yield* walk(item.id, path);
          continue;
        }
        if (!item.file) continue;
        items[path] = item.id;
        if (!audioEntries([item]).length) continue;
        yield {
          path,
          mtime: Date.parse(item.lastModifiedDateTime) || 0,
          size: item.size ?? 0,
          externalIds: { onedrive: item.id },
          readFile: () => self._fileForTags(path, item),
        };
      }
    }

    try {
      yield* walk(this._root.itemId ?? 'root', '');
    } finally {
      this._items = items;
      await this._setMeta('onedriveItems', items);
    }
  }

  /**
   * Whole-file read. The cache is consulted before authorization, so a cached
   * track still plays after the token expired. A miss downloads the body.
   * Sync passes `awaitCache` so the file is really in Cache Storage when the
   * pass moves on. Playback should call `open` instead: that returns the
   * download URL before the body arrives.
   */
  async getFile(path, options = {}) {
    const opened = await this.open(path, options);
    if (opened.file) return opened.file;
    return opened.cache;
  }

  /**
   * A cached blob, or a short-lived download URL plus a cache fill.
   * The URL is returned as soon as Graph answers, so playback can start
   * while the body is still copying into Cache Storage. `itemId` skips a
   * path lookup (paths such as `90's/...` are easy to miss after a reload).
   */
  async open(path, { awaitCache = false, itemId = null } = {}) {
    const clean = cleanPath(path);
    const key = cacheKey('onedrive', clean);
    const cached = await this._readCached(key);
    if (cached) return { file: cached };

    if (!(await this.ensurePermission())) {
      throw new Error(t('error.onedrive.authRequired'));
    }
    const driveId = await this._driveIdOrFetch();
    const resolved = await this._resolveItemId(driveId, clean, { folder: false, itemId });
    const url = await this._downloadUrl(driveId, resolved);
    const cache = this._downloadToCache(key, clean, driveId, resolved, url, { awaitCache });
    return { url, cache };
  }

  async _readCached(key) {
    if (!this.cache?.read) return null;
    try {
      return await this.cache.read(key);
    } catch {
      return null;
    }
  }

  async _downloadUrl(driveId, itemId) {
    try {
      return await this.client.getDownloadUrl(driveId, itemId);
    } catch (error) {
      try {
        return await this.client.getDownloadUrl(driveId, itemId);
      } catch (retry) {
        throw new Error(t('error.onedrive.fetchFailed'), { cause: retry ?? error });
      }
    }
  }

  async _downloadToCache(key, path, driveId, itemId, url, { awaitCache }) {
    const blob = await this._downloadBlob(url, driveId, itemId);
    if (this.cache?.write) {
      const pending = this.cache.write({ key, source: 'onedrive', path, blob });
      if (pending && typeof pending.then === 'function') {
        if (awaitCache) await pending;
        else pending.catch(() => {});
      }
    }
    return blob;
  }

  /**
   * Startup-only silent reauthorization (`prompt=none`). Never called during
   * playback; the 10-minute guard in `meta` stops redirect loops.
   */
  async silentReauth() {
    const last = await this._getMeta(SILENT_KEY);
    const at = Number(last?.at);
    if (Number.isFinite(at) && this.now() - at < SILENT_WINDOW_MS) return false;
    await this._setMeta(SILENT_KEY, { at: this.now() });
    await this.startLogin({ prompt: 'none' });
    return 'redirecting';
  }

  async _getMeta(key) {
    try {
      return await this.meta.get(key);
    } catch {
      return null;
    }
  }

  async _setMeta(key, value) {
    try {
      await this.meta.set(key, value);
    } catch {
      // Storage failures leave the in-memory state authoritative for this run.
    }
  }

  async _clearPkce() {
    await this._setMeta(PKCE_KEY, null);
  }

  _clearQuery() {
    try {
      this.history.replaceState({}, '', `${this.location.pathname}${this.location.hash ?? ''}`);
    } catch {
      // Non-navigable test doubles may not implement history.
    }
  }

  async _validToken() {
    if (this._token && !isTokenExpired(this._token, this.now())) return this._token;
    const granted = await this.ensurePermission();
    if (!granted || !this._token) throw new Error(t('error.onedrive.authRequired'));
    return this._token;
  }

  async _driveIdOrFetch() {
    if (this._root?.driveId) return this._root.driveId;
    if (this._driveId) return this._driveId;
    const drive = await this.client.getJson('/me/drive');
    this._driveId = drive?.id ?? null;
    if (!this._driveId) throw new Error(t('error.onedrive.fetchFailed'));
    return this._driveId;
  }

  async _resolveItemId(driveId, path, { folder = false, itemId = null } = {}) {
    if (!path) return 'root';
    if (itemId) {
      this._items[path] = itemId;
      return itemId;
    }
    const known = this._items[path];
    if (known) return known;

    const full = itemPath(this._root?.path ?? '', path);
    const encoded = encodePath(full);
    const item = await this.client.getJson(`/drives/${driveId}/root:/${encoded}:`);
    if (!item?.id) throw new Error(t('error.onedrive.fetchFailed'));
    if (!folder) this._items[path] = item.id;
    return item.id;
  }

  async _downloadBlob(url, driveId, itemId) {
    const attempt = async (downloadUrl) => {
      const response = await this.fetchImpl(downloadUrl);
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response?.status ?? 0}`);
      }
      return response.blob();
    };
    try {
      return await attempt(url);
    } catch (error) {
      let fresh = url;
      try {
        fresh = await this.client.getDownloadUrl(driveId, itemId);
      } catch {
        // Keep the URL we already have; the second body read is the retry.
      }
      try {
        return await attempt(fresh);
      } catch (retry) {
        throw new Error(t('error.onedrive.fetchFailed'), { cause: retry ?? error });
      }
    }
  }

  /**
   * One ranged read. A failed request (throw or non-2xx, including 401/403/404)
   * refetches the item once for a fresh download URL and retries once.
   */
  async _fetchRange(itemId, start, end) {
    const driveId = await this._driveIdOrFetch();
    const attempt = async () => {
      const url = await this.client.getDownloadUrl(driveId, itemId);
      return this.client.fetchRange(url, start, end);
    };
    try {
      return await attempt();
    } catch {
      return attempt();
    }
  }

  /** Prefer the cached audio so tags are read from the bytes already on device. */
  async _fileForTags(path, item) {
    const key = cacheKey('onedrive', path);
    try {
      const cached = await this.cache?.read?.(key);
      if (cached) return cached;
    } catch {
      // A cache miss falls through to a ranged read.
    }
    return this._remoteFile(item);
  }

  _remoteFile(item) {
    return createRemoteFile({
      name: item.name,
      size: item.size ?? 0,
      fetchRange: (start, end) => this._fetchRange(item.id, start, end),
    });
  }
}
