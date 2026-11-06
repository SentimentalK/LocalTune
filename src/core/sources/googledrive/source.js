/**
 * Google Drive library source. Owns the GIS access token in `meta`, the root
 * folder choice, recursive scanning and whole-file downloads.
 *
 * The token is short-lived and there is no refresh token: when it expires the
 * source reports `prompt` and the UI asks the user to reconnect. Tokens never
 * leave `meta`; they are never logged or rendered.
 *
 * Browsing walks the whole My Drive root, like the OneDrive picker, while a
 * scan starts at the chosen root and yields root-relative paths.
 */

import { googleClientId, isConfigured } from './config.js';
import { GdriveAuthError, isTokenExpired, loadGis, requestToken } from './auth.js';
import {
  FOLDER_FIELDS,
  FOLDER_MIME,
  FILE_FIELDS,
  GdriveError,
  allChildrenQuery,
  createDriveClient,
  escapeQueryValue,
  folderChildrenQuery,
  namedFolderQuery,
} from './drive.js';
import { createRemoteFile } from '../onedrive/remoteFile.js';
import { cacheKey } from '../../cache/audioCache.js';
import { AUDIO_EXTENSIONS } from '../../source.js';
import { t } from '../../../i18n/index.js';

/** Root-relative path without leading/trailing slashes. */
function cleanPath(path) {
  return String(path ?? '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** Root-relative join that never emits empty or doubled segments. */
function itemPath(parentPath, name) {
  return [parentPath, name]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** Drive query for any child named `name`, folder or file. */
function namedItemQuery(parentId, name) {
  return `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' and trashed = false`;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isAudioName(name) {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

export class GdriveSource {
  kind = 'gdrive';
  trackSource = 'gdrive';
  cacheWholeFiles = true;
  name = '';

  constructor({
    meta,
    fetchImpl = (...args) => globalThis.fetch(...args),
    cache = null,
    now = () => Date.now(),
    getGis = null,
    clientId = null,
  } = {}) {
    if (!meta) throw new Error('GdriveSource requires a meta store');
    this.meta = meta;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.now = now;
    this.clientId = clientId ?? googleClientId();
    this.getGis = getGis ?? (() => loadGis());

    this._token = null;
    this._root = null;
    this._items = {};
    this._browseIndex = new Map();
    this._permission = 'none';

    this.client = createDriveClient({
      fetchImpl,
      getToken: () => this._validToken(),
    });
  }

  /** Whether a build-time (or injected) client ID is present. */
  configured() {
    return isConfigured(this.clientId);
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

  /**
   * Run the GIS token flow and store the token. An unconfigured build throws
   * before any script insert or network call; a failed flow leaves the
   * previous token untouched.
   * @returns {Promise<'granted'>}
   */
  async connect() {
    if (!this.configured()) {
      throw new GdriveAuthError('Google client ID is not configured', 'not_configured');
    }
    const token = await requestToken({
      clientId: this.clientId,
      getGis: this.getGis,
      now: this.now,
    });
    this._token = token;
    await this._setMeta('gdriveToken', token);
    await this._setMeta('gdriveAuthAt', this.now());
    this._permission = 'granted';
    return 'granted';
  }

  /** Read token, root and item map from `meta`. No network. */
  async restore() {
    const token = await this._getMeta('gdriveToken');
    const root = await this._getMeta('gdriveRoot');
    const items = await this._getMeta('gdriveItems');

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
   * A valid stored token is the only way through. Expired tokens are not
   * refreshed: the caller must reconnect. No network.
   */
  async ensurePermission() {
    if (this._token && !isTokenExpired(this._token, this.now())) {
      this._permission = 'granted';
      return true;
    }
    this._permission = this._token ? 'prompt' : 'none';
    return false;
  }

  /**
   * List folders under `path`. `path` is relative to the **My Drive** root
   * (`browse('')` uses the `root` alias), not to the chosen library root; the
   * picker navigates the whole drive.
   */
  async browse(path = '') {
    if (!(await this.ensurePermission())) {
      throw new GdriveError(t('error.gdrive.authRequired'), { code: 'authRequired' });
    }
    const clean = cleanPath(path);
    const parentId = clean === '' ? 'root' : await this._resolveFolderId(clean);
    const files = await this._guard(() =>
      this.client.listFiles({
        q: folderChildrenQuery(parentId),
        fields: FOLDER_FIELDS,
        orderBy: 'name',
      }),
    );

    const folders = [];
    for (const item of files) {
      if (!item || typeof item.name !== 'string' || item.name === '') continue;
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

  /** Folder id for a root-relative path, cached per segment. */
  async _resolveFolderId(path) {
    const known = this._browseIndex.get(path);
    if (known) return known;

    let parentId = 'root';
    let accumulated = '';
    for (const segment of path.split('/').filter(Boolean)) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const cached = this._browseIndex.get(accumulated);
      if (cached) {
        parentId = cached;
        continue;
      }
      const files = await this._guard(() =>
        this.client.listFiles({
          q: namedFolderQuery(parentId, segment),
          fields: FOLDER_FIELDS,
        }),
      );
      const match = files.find((item) => item?.name === segment) ?? files[0];
      if (!match?.id) {
        throw new GdriveError(t('error.gdrive.fetchFailed'), { code: 'notFound' });
      }
      this._browseIndex.set(accumulated, match.id);
      parentId = match.id;
    }
    return parentId;
  }

  async setRoot({ id, path, name }) {
    const root = { id, path: cleanPath(path), name: name ?? '' };
    this._root = root;
    this.name = root.name;
    this._permission = 'granted';
    await this._setMeta('gdriveRoot', root);
    return { ...root };
  }

  async forget() {
    this._token = null;
    this._root = null;
    this._items = {};
    this._browseIndex.clear();
    this._permission = 'none';
    this.name = '';
    await this._setMeta('gdriveToken', null);
    await this._setMeta('gdriveRoot', null);
    await this._setMeta('gdriveItems', null);
  }

  /**
   * Walk the chosen root and yield audio entries. The item map is persisted
   * when the walk ends or is aborted.
   */
  async *scan({ signal } = {}) {
    if (!(await this.ensurePermission())) {
      throw new GdriveError(t('error.gdrive.authRequired'), { code: 'authRequired' });
    }
    if (!this._root) {
      throw new GdriveError(t('error.gdrive.authRequired'), { code: 'authRequired' });
    }

    const items = { ...(this._items ?? {}) };
    const self = this;

    async function* walk(folderId, parentPath) {
      const query = allChildrenQuery(folderId);
      for await (const page of self.client.list({ q: query, fields: FILE_FIELDS })) {
        for (const item of page ?? []) {
          if (signal?.aborted) return;
          const name = item?.name;
          if (typeof name !== 'string' || name === '' || name.startsWith('.')) continue;
          const path = itemPath(parentPath, name);
          if (item.mimeType === FOLDER_MIME) {
            yield* walk(item.id, path);
            continue;
          }
          const audioMime = typeof item.mimeType === 'string' && item.mimeType.startsWith('audio/');
          if (!audioMime && !isAudioName(name)) continue;
          items[path] = item.id;
          yield {
            path,
            size: Number(item.size) || 0,
            mtime: Date.parse(item.modifiedTime) || 0,
            externalIds: { gdrive: item.id },
            readFile: () => self._fileForTags(path, item),
          };
        }
      }
    }

    try {
      yield* walk(this._root.id ?? 'root', '');
    } catch (error) {
      await this._handleClientError(error);
      throw error;
    } finally {
      this._items = items;
      await this._setMeta('gdriveItems', items);
    }
  }

  /**
   * Whole-file read. The cache is consulted before authorization, so a cached
   * track still plays after the token expired. A miss downloads the body.
   */
  async getFile(path, { awaitCache = false, itemId = null } = {}) {
    const clean = cleanPath(path);
    const key = cacheKey('gdrive', clean);
    const cached = await this._readCached(key);
    if (cached) return cached;

    if (!(await this.ensurePermission())) {
      throw new GdriveError(t('error.gdrive.authRequired'), { code: 'authRequired' });
    }
    const id = await this._resolveItemId(clean, itemId);
    const { bytes } = await this._guard(() => this.client.fetchMedia(id));
    const blob = new Blob([bytes]);

    if (this.cache?.write) {
      const pending = this.cache.write({ key, source: 'gdrive', path: clean, blob });
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
      throw new GdriveError(t('error.gdrive.fetchFailed'), { code: 'notFound' });
    }

    let parentId = this._root?.id ?? 'root';
    let accumulated = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const cached = this._items[accumulated];
      if (cached) {
        parentId = cached;
        continue;
      }
      const last = index === segments.length - 1;
      const query = last ? namedItemQuery(parentId, segment) : namedFolderQuery(parentId, segment);
      const files = await this._guard(() =>
        this.client.listFiles({ q: query, fields: FILE_FIELDS }),
      );
      const match = files.find((item) => item?.name === segment) ?? files[0];
      if (!match?.id) {
        throw new GdriveError(t('error.gdrive.fetchFailed'), { code: 'notFound' });
      }
      this._items[accumulated] = match.id;
      parentId = match.id;
    }
    return parentId;
  }

  /** Prefer the cached audio so tags are read from the bytes already on device. */
  async _fileForTags(path, item) {
    const cached = await this._readCached(cacheKey('gdrive', path));
    if (cached) return cached;
    return createRemoteFile({
      name: item.name,
      size: Number(item.size) || 0,
      maxRangeBytes: Number.POSITIVE_INFINITY,
      fetchRange: (start, end) =>
        this._guard(() => this.client.fetchMedia(item.id, { range: { start, end } })),
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

  /** Wrap one client call: a `401` drops the token and forces a reconnect. */
  async _guard(fn) {
    try {
      return await fn();
    } catch (error) {
      await this._handleClientError(error);
      throw error;
    }
  }

  async _handleClientError(error) {
    if (!(error instanceof GdriveError) || error.status !== 401) return;
    this._token = null;
    this._permission = 'prompt';
    await this._setMeta('gdriveToken', null);
  }

  async _validToken() {
    if (this._token && !isTokenExpired(this._token, this.now())) {
      return this._token.accessToken;
    }
    this._permission = this._token ? 'prompt' : 'none';
    throw new GdriveError(t('error.gdrive.authRequired'), { code: 'authRequired' });
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
}
