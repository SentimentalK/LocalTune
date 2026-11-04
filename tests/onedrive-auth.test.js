import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_AUTHORITY,
  GRAPH_CLIENT_ID,
  GRAPH_SCOPES,
  TOKEN_SKEW_MS,
  base64UrlEncode,
  buildAuthorizeUrl,
  buildTokenRequest,
  codeChallenge,
  createCodeVerifier,
  isTokenExpired,
  normalizeTokenResponse,
  parseAuthResponse,
  randomState,
  requestToken,
} from '../src/core/sources/onedrive/auth.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

test('codeChallenge matches the RFC 7636 S256 test vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  assert.equal(
    await codeChallenge(verifier),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('createCodeVerifier returns 43 base64url characters and differs per call', () => {
  const first = createCodeVerifier();
  const second = createCodeVerifier();

  assert.equal(first.length, 43);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});

test('base64UrlEncode emits unpadded base64url', () => {
  assert.equal(base64UrlEncode(new Uint8Array([0xfb, 0xff])), '-_8');
  assert.equal(base64UrlEncode(new Uint8Array([0x00])), 'AA');
});

test('randomState is 16 random bytes as base64url', () => {
  const state = randomState();

  assert.equal(state.length, 22);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(state, randomState());
});

test('buildAuthorizeUrl carries PKCE, redirect and scopes', () => {
  const url = buildAuthorizeUrl({
    redirectUri: 'https://app.example/cb?x=1',
    codeChallenge: 'challenge-value',
    state: 'state-value',
  });
  const parsed = new URL(url);

  assert.equal(`${parsed.origin}${parsed.pathname}`, `${GRAPH_AUTHORITY}/authorize`);
  assert.equal(parsed.searchParams.get('client_id'), GRAPH_CLIENT_ID);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('response_mode'), 'query');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(parsed.searchParams.get('state'), 'state-value');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example/cb?x=1');
  assert.ok(parsed.searchParams.get('scope').includes('Files.Read'));
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Fapp.example%2Fcb%3Fx%3D1'));
});

test('parseAuthResponse reads success and error redirects', () => {
  assert.deepEqual(parseAuthResponse('?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    error: null,
    errorDescription: null,
  });
  assert.deepEqual(parseAuthResponse('?error=access_denied&error_description=nope'), {
    code: null,
    state: null,
    error: 'access_denied',
    errorDescription: 'nope',
  });
});

test('isTokenExpired honours the skew window', () => {
  const now = 1_700_000_000_000;

  assert.equal(isTokenExpired({ expiresAt: now + 30_000 }, now, TOKEN_SKEW_MS), true);
  assert.equal(isTokenExpired({ expiresAt: now + 120_000 }, now, TOKEN_SKEW_MS), false);
  assert.equal(isTokenExpired(null, now, TOKEN_SKEW_MS), true);
  assert.equal(isTokenExpired({ expiresAt: Number.NaN }, now, TOKEN_SKEW_MS), true);
});

test('normalizeTokenResponse maps the payload and rejects missing access_token', () => {
  const now = 1_700_000_000_000;
  const token = normalizeTokenResponse(
    { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'Files.Read' },
    now,
  );

  assert.deepEqual(token, {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: now + 3_600_000,
    scope: 'Files.Read',
  });
  assert.equal(
    normalizeTokenResponse({ access_token: 'at', expires_in: 60 }, now).refreshToken,
    '',
  );
  assert.throws(
    () => normalizeTokenResponse({ expires_in: 60 }, now),
    /token response missing access_token/,
  );
});

test('buildTokenRequest covers code exchange and refresh', () => {
  const exchange = buildTokenRequest({
    code: 'the-code',
    codeVerifier: 'the-verifier',
    redirectUri: 'https://app.example/cb',
  });
  const exchangeBody = new URLSearchParams(exchange.body);

  assert.equal(exchange.url, `${GRAPH_AUTHORITY}/token`);
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');
  assert.equal(exchangeBody.get('code'), 'the-code');
  assert.equal(exchangeBody.get('code_verifier'), 'the-verifier');
  assert.equal(exchangeBody.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(exchangeBody.get('scope'), GRAPH_SCOPES);
  assert.equal(exchangeBody.get('client_id'), GRAPH_CLIENT_ID);
  assert.equal(exchangeBody.has('refresh_token'), false);

  const refresh = buildTokenRequest({
    refreshToken: 'the-refresh',
    redirectUri: 'https://app.example/cb',
  });
  const refreshBody = new URLSearchParams(refresh.body);

  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'the-refresh');
  assert.equal(refreshBody.get('scope'), GRAPH_SCOPES);
});

test('requestToken posts form data and normalizes the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return jsonResponse(200, {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      scope: 'Files.Read',
    });
  };
  const before = Date.now();
  const token = await requestToken(
    { url: `${GRAPH_AUTHORITY}/token`, body: 'grant_type=authorization_code' },
    fetchImpl,
  );
  const after = Date.now();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${GRAPH_AUTHORITY}/token`);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0][1].body, 'grant_type=authorization_code');
  assert.equal(token.accessToken, 'access');
  assert.equal(token.refreshToken, 'refresh');
  assert.ok(token.expiresAt >= before + 3_600_000);
  assert.ok(token.expiresAt <= after + 3_600_000);
});

test('requestToken surfaces OAuth error payloads with status and code', async () => {
  const fetchImpl = async () =>
    jsonResponse(400, { error: 'invalid_grant', error_description: 'bad' });

  await assert.rejects(
    requestToken({ url: `${GRAPH_AUTHORITY}/token`, body: '' }, fetchImpl),
    (error) => {
      assert.equal(error.message, 'bad');
      assert.equal(error.code, 'invalid_grant');
      assert.equal(error.status, 400);
      return true;
    },
  );
});
