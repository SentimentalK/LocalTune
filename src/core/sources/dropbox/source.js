/**
 * Dropbox library source. Owns the OAuth redirect, token storage in `meta`,
 * the root folder choice, recursive scanning and whole-file downloads.
 *
 * The access token is short-lived (about 4 h) and refreshed silently with the
 * refresh token; a 401 triggers one refresh-and-retry. When the refresh token
 * itself is dead the source reports `prompt` and cached tracks still play.
 *
 * Browsing walks the whole Dropbox account, like the OneDrive picker, while a
 * scan starts at the chosen root and yields root-relative paths.
 */

import { dropboxAppKey, isConfigured } from './config.js';
import {
  DropboxAuthError,
  PKCE_KEY,
  buildAuthorizeUrl,
  buildTokenRequest,
  isTokenExpired,
  requestToken,
  TOKEN_KEY,
} from './auth.js';
import {
  DropboxError,
  apiPath,
  audioEntries,
  cleanPath,
  createDropboxClient,
  relativeToRoot,
} from './client.js';
import { codeChallenge, createCodeVerifier, parseAuthResponse, randomState } from '../pkce.js';
import { createRemoteFile } from '../onedrive/remoteFile.js';
import { cacheKey } from '../../cache/audioCache.js';
import { t } from '../../../i18n/index.js';

/** Root-relative join that never emits empty or doubled segments. */
function itemPath(parentPath, name) {
  return [parentPath, name]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** Account-absolute Dropbox API path for a root-relative path. */
function dropboxPathOf(rootPath, relative) {
  return apiPath([rootPath, relative].filter(Boolean).join('/'));
}

export class DropboxSource {
  kind = 'dropbox';
  trackSource = 'dropbox';
  cacheWholeFiles = true;
  name = '';

  constructor({
    meta,
    fetchImpl = (...args) => globalThis.fetch(...args),
    cache = null,
    location = globalThis.location,
    history = globalThis.history,
    now = () => Date.now(),
    appKey = null,
  } = {}) {
    if (!meta) throw new Error('DropboxSource requires a meta store');
    this.meta = meta;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.location = location;
    this.history = history;
    this.now = now;
    this.appKey = appKey ?? dropboxAppKey();

    this.authError = null;
    this.authStage = null;
    this._token = null;
    this._root = null;
    this._items = {};
    this._permission = 'none';

    this.client = createDropboxClient({
      fetchImpl,
      getToken: () => this._validToken(),
    });
  }

  get redirectUri() {
    return `${this.location.origin}/`;
  }

  /** Whether a build-time (or injected) app key is present. */
  configured() {
    return isConfigured(this.appKey);
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
  async startLogin() {
    if (!this.configured()) {
      throw new DropboxAuthError('Dropbox app key is not configured', 'not_configured');
    }
    const verifier = createCodeVerifier();
    const challenge = await codeChallenge(verifier);
    const state = randomState();
    const redirectUri = this.redirectUri;
    await this._setMeta(PKCE_KEY, { verifier, state, redirectUri, at: this.now() });
    this.location.assign(
      buildAuthorizeUrl({ appKey: this.appKey, redirectUri, codeChallenge: challenge, state }),
    );
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
    const token = await this._getMeta(TOKEN_KEY);
    const root = await this._getMeta('dropboxRoot');
    const items = await this._getMeta('dropboxItems');

    this._token = token && typeof token === 'object' ? token : null;
    this._root = root && typeof root === 'object' ? root : null;
    this._items = items && typeof items === 'object' ? items : {};
    this.name = this._root?.name ?? '';
    this._permission = !this._token
      ? 'none'
      : isTokenExpired(this._token, this.now())
        ? 'prompt'
        : 'granted';
    return this._permission;
  }

  /**
   * A valid token is enough; otherwise refresh it with the stored refresh
   * token. No refresh token means the user has to reconnect. `force` skips
   * the validity check after a 401 from the API.
   */
  async ensurePermission({ force = false } = {}) {
    if (!force && this._token && !isTokenExpired(this._token, this.now())) {
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
        buildTokenRequest({ appKey: this.appKey, refreshToken }),
        this.fetchImpl,
        { previous: this._token },
      );
      this._token = token;
      await this.meta.set(TOKEN_KEY, token);
      await this._setMeta('dropboxAuthAt', this.now());
      this._permission = 'granted';
      return true;
    } catch {
      this._token = null;
      await this._setMeta(TOKEN_KEY, null);
      this._permission = 'prompt';
      return false;
    }
  }

  /**
   * List folders under `path`. `path` is relative to the **Dropbox account**
   * (`browse('')` lists the account root), not to the chosen library root; the
   * picker navigates the whole account.
   */
  async browse(path = '') {
    if (!(await this.ensurePermission())) {
      throw new DropboxError(t('error.dropbox.authRequired'), { code: 'authRequired' });
    }
    const clean = cleanPath(path);
    const folders = [];
    for await (const entry of this.client.listFolder({ path: apiPath(clean) })) {
      if (entry?.['.tag'] !== 'folder') continue;
      if (typeof entry.name !== 'string' || entry.name === '') continue;
      folders.push({
        id: entry.id,
        name: entry.name,
        path: itemPath(clean, entry.name),
        isFolder: true,
      });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return folders;
  }

  async setRoot({ id, path, name }) {
    const root = { id, path: cleanPath(path), name: name ?? '' };
    this._root = root;
    this.name = root.name;
    this._permission = 'granted';
    await this._setMeta('dropboxRoot', root);
    return { ...root };
  }

  async forget() {
    this._token = null;
    this._root = null;
    this._items = {};
    this._permission = 'none';
    this.name = '';
    await this._setMeta(TOKEN_KEY, null);
    await this._setMeta('dropboxRoot', null);
    await this._setMeta('dropboxItems', null);
    await this._setMeta(PKCE_KEY, null);
    await this._setMeta('dropboxAuth', null);
  }

  /**
   * Walk the chosen root and yield audio entries. The item map is persisted
   * when the walk ends or is aborted.
   */
  async *scan({ signal } = {}) {
    if (!(await this.ensurePermission())) {
      throw new DropboxError(t('error.dropbox.authRequired'), { code: 'authRequired' });
    }
    if (!this._root) {
      throw new DropboxError(t('error.dropbox.authRequired'), { code: 'authRequired' });
    }

    const items = { ...(this._items ?? {}) };
    const self = this;
    const rootPath = this._root?.path ?? '';

    try {
      // `_guard` retries the whole listing once after refreshing an expired
      // token. Entries are collected first so a mid-stream 401 cannot replay
      // duplicates into the store's scan loop.
      const entries = await this._guard(async () => {
        const collected = [];
        for await (const entry of this.client.listFolder({
          path: apiPath(rootPath),
          recursive: true,
        })) {
          collected.push(entry);
        }
        return collected;
      });

      for (const entry of entries) {
        if (signal?.aborted) return;
        if (entry?.['.tag'] === 'deleted') continue;
        if (typeof entry?.name !== 'string' || entry.name === '') continue;
        if (entry.name.startsWith('.')) continue;
        const full = cleanPath(entry.path_display ?? entry.path_lower ?? '');
        const path = relativeToRoot(rootPath, full);
        if (path === '' || path.startsWith('/')) continue;
        // `relativeToRoot` returns the cleaned account path for entries
        // outside the root; Dropbox paths are case-insensitive, so compare
        // the prefix lowercased.
        if (
          rootPath !== '' &&
          !full.toLowerCase().startsWith(`${cleanPath(rootPath).toLowerCase()}/`)
        ) {
          continue;
        }
        if (entry['.tag'] === 'folder') continue;
        if (!audioEntries([entry]).length) continue;
        items[path] = entry.id;
        yield {
          path,
          size: Number(entry.size) || 0,
          mtime: Date.parse(entry.server_modified) || 0,
          externalIds: { dropbox: entry.id },
          readFile: () => self._fileForTags(path, entry),
        };
      }
    } finally {
      this._items = items;
      await this._setMeta('dropboxItems', items);
    }
  }

  /**
   * Whole-file read. The cache is consulted before authorization, so a cached
   * track still plays after the token died. A miss downloads the body.
   */
  async getFile(path, { awaitCache = false, itemId = null } = {}) {
    const clean = cleanPath(path);
    const key = cacheKey('dropbox', clean);
    const cached = await this._readCached(key);
    if (cached) return cached;

    if (!(await this.ensurePermission())) {
      throw new DropboxError(t('error.dropbox.authRequired'), { code: 'authRequired' });
    }
    await this._resolveItemId(clean, itemId);
    const fullPath = dropboxPathOf(this._root?.path ?? '', clean);
    const { blob } = await this._guard(() => this.client.download(fullPath));

    if (this.cache?.write) {
      const pending = this.cache.write({ key, source: 'dropbox', path: clean, blob });
      if (pending && typeof pending.then === 'function') {
        if (awaitCache) await pending;
        else pending.catch(() => {});
      }
    }
    return blob;
  }

  /** `itemId` wins, then the scanned map, then a per-segment name lookup. */
  async _resolveItemId(path, itemId) {
    const clean = cleanPath(path);
    if (itemId) {
      this._items[clean] = itemId;
      return itemId;
    }
    const known = this._items[clean];
    if (known) return known;

    const segments = clean.split('/').filter(Boolean);
    if (segments.length === 0) {
      throw new DropboxError(t('error.dropbox.fetchFailed'), { code: 'notFound' });
    }

    const rootPath = this._root?.path ?? '';
    let parent = apiPath(rootPath);
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const cached = this._items[accumulated];
      if (cached) {
        parent = dropboxPathOf(rootPath, accumulated);
        continue;
      }
      const entries = [];
      for await (const entry of this.client.listFolder({ path: parent })) entries.push(entry);
      const match = entries.find(
        (entry) =>
          typeof entry?.name === 'string' &&
          entry.name.toLowerCase() === segment.toLowerCase(),
      );
      if (!match?.id) {
        throw new DropboxError(t('error.dropbox.fetchFailed'), { code: 'notFound' });
      }
      this._items[accumulated] = match.id;
      parent = dropboxPathOf(rootPath, accumulated);
    }
    return this._items[clean] ?? null;
  }

  /** Prefer the cached audio so tags are read from the bytes already on device. */
  async _fileForTags(path, item) {
    const cached = await this._readCached(cacheKey('dropbox', path));
    if (cached) return cached;
    const fullPath = dropboxPathOf(this._root?.path ?? '', path);
    return createRemoteFile({
      name: item.name,
      size: Number(item.size) || 0,
      maxRangeBytes: Number.POSITIVE_INFINITY,
      fetchRange: async () => ({
        status: 200,
        bytes: new Uint8Array(await (await this.client.download(fullPath)).blob.arrayBuffer()),
      }),
    });
  }

  async _readCached(key) {
    if (!this.cache?.read) return null;
    try {
      return await this.cache.read(key);
    } catch {
      return null;
    }
  }

  /** Wrap one client call: a `401` refreshes once and retries once. */
  async _guard(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof DropboxError) || error.status !== 401) throw error;
      const ok = await this.ensurePermission({ force: true });
      if (!ok) {
        this._permission = 'prompt';
        throw error;
      }
      try {
        return await fn();
      } catch (retry) {
        if (retry instanceof DropboxError && retry.status === 401) {
          this._token = null;
          await this._setMeta(TOKEN_KEY, null);
          this._permission = 'prompt';
        }
        throw retry;
      }
    }
  }

  async _validToken() {
    if (this._token && !isTokenExpired(this._token, this.now())) {
      return this._token.accessToken;
    }
    const granted = await this.ensurePermission();
    if (!granted || !this._token) {
      throw new DropboxError(t('error.dropbox.authRequired'), { code: 'authRequired' });
    }
    return this._token.accessToken;
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
}
