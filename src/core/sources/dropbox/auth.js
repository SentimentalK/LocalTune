/**
 * Browser-side Dropbox OAuth 2.0 + PKCE helpers.
 *
 * Pure logic plus injectable fetch: no DOM, no storage, no UI. Callers own the
 * redirect, state persistence and token storage. Dropbox is a confidential-free
 * PKCE flow (`token_access_type=offline` for a refresh token): the app secret
 * never enters the browser or this module.
 */

import {
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_SCOPES,
  DROPBOX_TOKEN_URL,
  TOKEN_SKEW_MS,
  isConfigured,
} from './config.js';

export const PKCE_KEY = 'dropboxPkce';
export const PKCE_TTL_MS = 10 * 60 * 1000;
export const TOKEN_KEY = 'dropboxToken';

export class DropboxAuthError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'auth') {
    super(message);
    this.name = 'DropboxAuthError';
    this.code = code;
  }
}

/**
 * Build the authorize redirect URL.
 * @param {{ appKey: string, redirectUri: string, codeChallenge: string, state: string, scopes?: string }} options
 * @returns {string}
 */
export function buildAuthorizeUrl({
  appKey,
  redirectUri,
  codeChallenge: challenge,
  state,
  scopes = DROPBOX_SCOPES,
}) {
  if (!isConfigured(appKey)) {
    throw new DropboxAuthError('Dropbox app key is not configured', 'not_configured');
  }
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    token_access_type: 'offline',
    scope: scopes,
  });
  return `${DROPBOX_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Build the token endpoint request body for a code exchange or refresh.
 * @param {{ appKey: string, code?: string, codeVerifier?: string, redirectUri?: string, refreshToken?: string|null }} options
 * @returns {{ url: string, body: string }}
 */
export function buildTokenRequest({
  appKey,
  code,
  codeVerifier,
  redirectUri,
  refreshToken = null,
}) {
  const body = new URLSearchParams();
  if (refreshToken) {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refreshToken);
  } else {
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('code_verifier', codeVerifier);
    body.set('redirect_uri', redirectUri);
  }
  body.set('client_id', appKey);
  return { url: DROPBOX_TOKEN_URL, body: body.toString() };
}

/**
 * Map a Dropbox token endpoint payload onto the local token shape.
 *
 * Dropbox refresh responses usually omit `refresh_token`, so the previous value
 * is kept unless the response carries a new one.
 * @param {Record<string, unknown>} json
 * @param {number} [now]
 * @param {{ refreshToken?: string }|null} [previous]
 * @returns {{ accessToken: string, refreshToken: string, expiresAt: number, scope: string }}
 */
export function normalizeTokenResponse(json, now = Date.now(), previous = null) {
  if (!json?.access_token) {
    throw new DropboxAuthError('token response missing access_token', 'token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || previous?.refreshToken || '',
    expiresAt: now + Number(json.expires_in) * 1000,
    scope: json.scope ?? '',
  };
}

/**
 * Whether a stored token is missing or too close to expiry.
 * @param {{ expiresAt?: number }|null|undefined} token
 * @param {number} [now]
 * @param {number} [skewMs]
 * @returns {boolean}
 */
export function isTokenExpired(token, now = Date.now(), skewMs = TOKEN_SKEW_MS) {
  if (!token || !Number.isFinite(token.expiresAt)) return true;
  return token.expiresAt - skewMs <= now;
}

/**
 * POST a token request and normalize the response.
 * @param {{ url: string, body: string }} request
 * @param {typeof fetch} [fetchImpl]
 * @param {{ previous?: { refreshToken?: string }|null, now?: () => number }} [options]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, scope: string }>}
 */
export async function requestToken(
  request,
  fetchImpl = globalThis.fetch,
  { previous = null, now = Date.now } = {},
) {
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: request.body,
  });
  if (response.status < 200 || response.status >= 300) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const error = new DropboxAuthError(
      payload?.error_description || payload?.error || `HTTP ${response.status}`,
      payload?.error ?? 'auth',
    );
    error.status = response.status;
    throw error;
  }
  return normalizeTokenResponse(await response.json(), now(), previous);
}
