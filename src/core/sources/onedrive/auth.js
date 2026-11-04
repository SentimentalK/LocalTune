/**
 * Browser-side Microsoft Graph (OneDrive consumer) PKCE helpers.
 *
 * Pure logic plus injectable fetch: no DOM, no storage, no UI. Callers own the
 * redirect, state persistence and token storage.
 */

export const GRAPH_CLIENT_ID = '195e9ac7-6f9e-4a3c-bf09-42e0961c796a';
export const GRAPH_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const GRAPH_SCOPES = 'Files.Read offline_access openid';
export const TOKEN_SKEW_MS = 60000;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Unpadded base64url of a byte array.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string}
 */
export function base64UrlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 3) {
    const b0 = view[i];
    const b1 = i + 1 < view.length ? view[i + 1] : 0;
    const b2 = i + 2 < view.length ? view[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64URL_ALPHABET[(triple >> 18) & 63];
    out += BASE64URL_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < view.length) out += BASE64URL_ALPHABET[(triple >> 6) & 63];
    if (i + 2 < view.length) out += BASE64URL_ALPHABET[triple & 63];
  }
  return out;
}

/**
 * Random PKCE verifier: `randomBytes` random bytes, base64url encoded.
 * @param {number} [randomBytes]
 * @returns {string}
 */
export function createCodeVerifier(randomBytes = 32) {
  const bytes = new Uint8Array(randomBytes);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * S256 challenge: base64url(sha256(utf8(verifier))).
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function codeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Opaque CSRF state value.
 * @returns {string}
 */
export function randomState() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

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
 * Parse `location.search` (or a bare query string) after the redirect.
 * @param {string} search
 * @returns {{ code: string|null, state: string|null, error: string|null, errorDescription: string|null }}
 */
export function parseAuthResponse(search) {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
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
