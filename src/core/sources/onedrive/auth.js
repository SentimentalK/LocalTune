/**
 * Browser-side Microsoft Graph (OneDrive consumer) PKCE helpers.
 *
 * Pure logic plus injectable fetch: no DOM, no storage, no UI. Callers own the
 * redirect, state persistence and token storage. The PKCE primitives live in
 * `../pkce.js`; they are re-exported here so existing callers keep working.
 */

import {
  base64UrlEncode,
  codeChallenge,
  createCodeVerifier,
  parseAuthResponse,
  randomState,
} from '../pkce.js';

export { base64UrlEncode, codeChallenge, createCodeVerifier, parseAuthResponse, randomState };

export const GRAPH_CLIENT_ID = '195e9ac7-6f9e-4a3c-bf09-42e0961c796a';
export const GRAPH_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const GRAPH_SCOPES = 'Files.Read offline_access openid';
export const TOKEN_SKEW_MS = 60000;
/** `meta` keys and lifetime of the stored PKCE handshake. */
export const PKCE_KEY = 'onedrivePkce';
export const PKCE_TTL_MS = 10 * 60 * 1000;

/**
 * Build the authorize redirect URL.
 * @param {{ clientId?: string, redirectUri: string, codeChallenge: string, state: string, scopes?: string }} options
 * @returns {string}
 */
export function buildAuthorizeUrl({
  clientId = GRAPH_CLIENT_ID,
  redirectUri,
  codeChallenge: challenge,
  state,
  scopes = GRAPH_SCOPES,
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${GRAPH_AUTHORITY}/authorize?${params.toString()}`;
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
 * Map an OAuth token endpoint payload onto the local token shape.
 * @param {Record<string, unknown>} json
 * @param {number} [now]
 * @returns {{ accessToken: string, refreshToken: string, expiresAt: number, scope: string }}
 */
export function normalizeTokenResponse(json, now = Date.now()) {
  if (!json || !json.access_token) {
    throw new Error('token response missing access_token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt: now + Number(json.expires_in) * 1000,
    scope: json.scope ?? '',
  };
}

/**
 * Build the token endpoint request body for a code exchange or refresh.
 * @param {{ code?: string, codeVerifier?: string, redirectUri?: string, clientId?: string, refreshToken?: string|null, scopes?: string }} options
 * @returns {{ url: string, body: string }}
 */
export function buildTokenRequest({
  code,
  codeVerifier,
  redirectUri,
  clientId = GRAPH_CLIENT_ID,
  refreshToken = null,
  scopes = GRAPH_SCOPES,
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
  body.set('client_id', clientId);
  body.set('scope', scopes);
  return { url: `${GRAPH_AUTHORITY}/token`, body: body.toString() };
}

/**
 * POST a token request and normalize the response.
 * @param {{ url: string, body: string }} request
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, scope: string }>}
 */
export async function requestToken(request, fetchImpl = globalThis.fetch) {
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
    const error = new Error(
      payload?.error_description || payload?.error || `HTTP ${response.status}`,
    );
    error.status = response.status;
    error.code = payload?.error ?? null;
    throw error;
  }
  return normalizeTokenResponse(await response.json());
}
