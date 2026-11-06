/**
 * Google Identity Services (GIS) token-model helpers.
 *
 * The browser holds a short-lived access token only: there is no client
 * secret and no refresh token. When the token expires the source goes back to
 * `prompt` and the user reconnects. Nothing here touches IndexedDB or the UI;
 * callers inject `getGis` and a clock.
 */

import { DRIVE_SCOPE, GIS_SRC, TOKEN_SKEW_MS, isConfigured } from './config.js';

const GIS_TIMEOUT_MS = 15_000;

export class GdriveAuthError extends Error {
  /**
   * @param {string} message
   * @param {string|null} [code] one of not_configured, access_denied,
   *   popup_closed, script_failed, no_token (or the GIS error string)
   */
  constructor(message, code = null) {
    super(message);
    this.name = 'GdriveAuthError';
    this.code = code;
  }
}

/** Module-level promise: the GIS script is inserted at most once. */
let gisPromise = null;

/**
 * Insert the GIS script once and resolve with `google.accounts.oauth2`.
 * A script error or a 15 s timeout rejects with `code: 'script_failed'`.
 * @param {{ src?: string, doc?: Document }} [options]
 * @returns {Promise<any>}
 */
export function loadGis({ src = GIS_SRC, doc = globalThis.document } = {}) {
  if (gisPromise) return gisPromise;

  gisPromise = new Promise((resolve, reject) => {
    const fail = () => reject(new GdriveAuthError('Google Identity Services failed to load', 'script_failed'));
    if (!doc || typeof doc.createElement !== 'function') {
      fail();
      return;
    }

    let timer = null;
    const finish = (callback) => {
      clearTimeout(timer);
      callback();
    };

    try {
      const script = doc.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () =>
        finish(() => {
          const oauth2 = globalThis.google?.accounts?.oauth2;
          if (!oauth2) fail();
          else resolve(oauth2);
        });
      script.onerror = () => finish(fail);
      timer = setTimeout(fail, GIS_TIMEOUT_MS);
      // Never hold the Node test runner open on the 15 s guard.
      if (typeof timer?.unref === 'function') timer.unref();
      const parent = doc.head ?? doc.body ?? doc.documentElement;
      parent.appendChild(script);
    } catch {
      fail();
    }
  });

  // A failed load must stay retryable: clear the cache so the next call
  // inserts the script again instead of replaying the rejection forever.
  gisPromise.catch(() => {
    gisPromise = null;
  });

  return gisPromise;
}

/**
 * Map a GIS token response onto the local token shape.
 * @param {{ access_token?: string, expires_in?: number|string, scope?: string }} json
 * @param {number} [now]
 * @returns {{ accessToken: string, expiresAt: number, scope: string }}
 */
export function normalizeTokenResponse(json, now = Date.now()) {
  const accessToken = json?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new GdriveAuthError('token response has no access_token', 'no_token');
  }
  return {
    accessToken,
    expiresAt: now + Number(json.expires_in) * 1000,
    scope: json.scope ?? '',
  };
}

/**
 * Whether a stored token is missing or too close to expiry.
 * @param {{ expiresAt?: number }|null} token
 * @param {number} [now]
 * @param {number} [skewMs]
 * @returns {boolean}
 */
export function isTokenExpired(token, now = Date.now(), skewMs = TOKEN_SKEW_MS) {
  const expiresAt = token?.expiresAt;
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - skewMs <= now;
}

/**
 * Ask GIS for an access token through the token model.
 *
 * A blank client ID rejects before `getGis` runs: no script insert, no
 * network. The GIS callback error string becomes the error code.
 * @param {{
 *   clientId?: string,
 *   scope?: string,
 *   getGis?: () => Promise<any>,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<{ accessToken: string, expiresAt: number, scope: string }>}
 */
export async function requestToken({
  clientId,
  scope = DRIVE_SCOPE,
  getGis = () => loadGis(),
  now = Date.now,
} = {}) {
  if (!isConfigured(clientId)) {
    throw new GdriveAuthError('Google client ID is not configured', 'not_configured');
  }

  const gis = await getGis();
  if (typeof gis?.initTokenClient !== 'function') {
    throw new GdriveAuthError('Google Identity Services is unavailable', 'script_failed');
  }

  return new Promise((resolve, reject) => {
    const client = gis.initTokenClient({
      client_id: clientId,
      scope,
      callback: (response) => {
        if (response?.error) {
          reject(new GdriveAuthError(`Google authorization failed: ${response.error}`, response.error));
          return;
        }
        try {
          resolve(normalizeTokenResponse(response, now()));
        } catch (error) {
          reject(error);
        }
      },
    });
    client.requestAccessToken();
  });
}
