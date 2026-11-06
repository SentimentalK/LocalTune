import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_SCOPES,
  DROPBOX_TOKEN_URL,
  TOKEN_SKEW_MS,
} from '../src/core/sources/dropbox/config.js';
import {
  DropboxAuthError,
  buildAuthorizeUrl,
  buildTokenRequest,
  isTokenExpired,
  normalizeTokenResponse,
  requestToken,
} from '../src/core/sources/dropbox/auth.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

test('buildAuthorizeUrl carries PKCE, offline access, redirect and scopes', () => {
  const url = buildAuthorizeUrl({
    appKey: 'app-key',
    redirectUri: 'https://app.example/cb?x=1',
    codeChallenge: 'challenge-value',
    state: 'state-value',
  });
  const parsed = new URL(url);

  assert.equal(`${parsed.origin}${parsed.pathname}`, DROPBOX_AUTHORIZE_URL);
  assert.equal(parsed.searchParams.get('client_id'), 'app-key');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example/cb?x=1');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), 'state-value');
  assert.equal(parsed.searchParams.get('token_access_type'), 'offline');
  assert.equal(parsed.searchParams.get('scope'), DROPBOX_SCOPES);
  assert.ok(parsed.searchParams.get('scope').includes('files.metadata.read'));
  assert.ok(parsed.searchParams.get('scope').includes('files.content.read'));
  assert.equal(url.includes('client_secret'), false);
});

test('buildAuthorizeUrl rejects a missing or blank app key', () => {
  for (const appKey of ['', '   ']) {
    assert.throws(
      () =>
        buildAuthorizeUrl({
          appKey,
          redirectUri: 'https://app.example/cb',
          codeChallenge: 'challenge',
          state: 'state',
        }),
      (error) => {
        assert.ok(error instanceof DropboxAuthError);
        assert.equal(error.code, 'not_configured');
        return true;
      },
    );
  }
});

test('buildTokenRequest covers code exchange and refresh without a client secret', () => {
  const exchange = buildTokenRequest({
    appKey: 'app-key',
    code: 'the-code',
    codeVerifier: 'the-verifier',
    redirectUri: 'https://app.example/cb',
  });
  const exchangeBody = new URLSearchParams(exchange.body);

  assert.equal(exchange.url, DROPBOX_TOKEN_URL);
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');
  assert.equal(exchangeBody.get('code'), 'the-code');
  assert.equal(exchangeBody.get('code_verifier'), 'the-verifier');
  assert.equal(exchangeBody.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(exchangeBody.get('client_id'), 'app-key');
  assert.equal(exchange.body.includes('client_secret'), false);

  const refresh = buildTokenRequest({
    appKey: 'app-key',
    refreshToken: 'the-refresh',
    redirectUri: 'https://app.example/cb',
  });
  const refreshBody = new URLSearchParams(refresh.body);

  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'the-refresh');
  assert.equal(refreshBody.get('client_id'), 'app-key');
  assert.equal(refreshBody.has('code_verifier'), false);
  assert.equal(refreshBody.has('redirect_uri'), false);
  assert.equal(refresh.body.includes('client_secret'), false);
});

test('normalizeTokenResponse computes expiry and keeps the previous refresh token', () => {
  const now = 1_700_000_000_000;

  assert.deepEqual(
    normalizeTokenResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'scope' },
      now,
    ),
    {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: now + 3_600_000,
      scope: 'scope',
    },
  );

  assert.deepEqual(
    normalizeTokenResponse(
      { access_token: 'at-2', expires_in: 14400, scope: 'scope' },
      now,
      { refreshToken: 'old-rt' },
    ),
    {
      accessToken: 'at-2',
      refreshToken: 'old-rt',
      expiresAt: now + 14_400_000,
      scope: 'scope',
    },
  );

  assert.equal(
    normalizeTokenResponse(
      { access_token: 'at-3', refresh_token: 'new-rt', expires_in: 60 },
      now,
      { refreshToken: 'old-rt' },
    ).refreshToken,
    'new-rt',
  );
});

test('normalizeTokenResponse throws on a payload without access_token', () => {
  assert.throws(() => normalizeTokenResponse({ refresh_token: 'rt' }), (error) => {
    assert.ok(error instanceof DropboxAuthError);
    assert.equal(error.code, 'token');
    return true;
  });
});

test('isTokenExpired honours the skew window', () => {
  const now = 1_700_000_000_000;

  assert.equal(isTokenExpired({ expiresAt: now + 120_000 }, now, TOKEN_SKEW_MS), false);
  assert.equal(isTokenExpired({ expiresAt: now + 30_000 }, now, TOKEN_SKEW_MS), true);
  assert.equal(isTokenExpired(null, now, TOKEN_SKEW_MS), true);
});

test('requestToken posts form data and normalizes the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return jsonResponse(200, {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 14400,
      scope: 'files.metadata.read files.content.read',
    });
  };
  const now = 1_700_000_000_000;
  const token = await requestToken(
    { url: DROPBOX_TOKEN_URL, body: 'grant_type=authorization_code' },
    fetchImpl,
    { now: () => now },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], DROPBOX_TOKEN_URL);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0][1].body, 'grant_type=authorization_code');
  assert.deepEqual(token, {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: now + 14_400_000,
    scope: 'files.metadata.read files.content.read',
  });
});

test('requestToken surfaces OAuth error payloads with status and code', async () => {
  const fetchImpl = async () =>
    jsonResponse(400, {
      error: 'invalid_grant',
      error_description: 'refresh token is invalid or revoked',
    });

  await assert.rejects(
    requestToken({ url: DROPBOX_TOKEN_URL, body: '' }, fetchImpl),
    (error) => {
      assert.ok(error instanceof DropboxAuthError);
      assert.equal(error.message, 'refresh token is invalid or revoked');
      assert.equal(error.code, 'invalid_grant');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('requestToken keeps the previous refresh token when the response omits it', async () => {
  const fetchImpl = async () => jsonResponse(200, { access_token: 'fresh', expires_in: 14400 });
  const token = await requestToken(
    { url: DROPBOX_TOKEN_URL, body: 'grant_type=refresh_token' },
    fetchImpl,
    { previous: { refreshToken: 'old-refresh' } },
  );

  assert.equal(token.accessToken, 'fresh');
  assert.equal(token.refreshToken, 'old-refresh');
});
