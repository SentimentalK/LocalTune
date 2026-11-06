import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_SCOPE,
  TOKEN_SKEW_MS,
  googleClientId,
  isConfigured,
} from '../src/core/sources/googledrive/config.js';
import {
  GdriveAuthError,
  isTokenExpired,
  normalizeTokenResponse,
  requestToken,
} from '../src/core/sources/googledrive/auth.js';

function tokenClient(callbackResponse, calls) {
  return {
    initTokenClient(options) {
      calls.push(options);
      return {
        requestAccessToken() {
          options.callback(callbackResponse);
        },
      };
    },
  };
}

test('googleClientId prefers the runtime override, including an empty string', () => {
  delete globalThis.__LT_GOOGLE_CLIENT_ID__;

  assert.equal(googleClientId(), '');

  globalThis.__LT_GOOGLE_CLIENT_ID__ = 'runtime-client-id';
  assert.equal(googleClientId(), 'runtime-client-id');

  globalThis.__LT_GOOGLE_CLIENT_ID__ = '';
  assert.equal(googleClientId(), '');

  delete globalThis.__LT_GOOGLE_CLIENT_ID__;
  assert.equal(googleClientId(), '');
});

test('isConfigured rejects blank client IDs and accepts trimmed ones', () => {
  assert.equal(isConfigured(''), false);
  assert.equal(isConfigured('   '), false);
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured('client-1'), true);
});

test('normalizeTokenResponse computes expiry from expires_in and keeps the scope', () => {
  const token = normalizeTokenResponse(
    { access_token: 'token-1', expires_in: 3600, scope: 'drive.readonly' },
    1_000,
  );

  assert.deepEqual(token, {
    accessToken: 'token-1',
    expiresAt: 1_000 + 3_600_000,
    scope: 'drive.readonly',
  });

  const numeric = normalizeTokenResponse({ access_token: 'token-2', expires_in: '60' }, 5_000);
  assert.equal(numeric.expiresAt, 65_000);
  assert.equal(numeric.scope, '');
});

test('normalizeTokenResponse rejects a response without an access token', () => {
  assert.throws(
    () => normalizeTokenResponse({ expires_in: 60 }, 0),
    (error) => error instanceof GdriveAuthError && error.code === 'no_token',
  );
  assert.throws(
    () => normalizeTokenResponse({ access_token: '', expires_in: 60 }, 0),
    (error) => error instanceof GdriveAuthError && error.code === 'no_token',
  );
});

test('isTokenExpired honours the skew boundary and non-finite expiries', () => {
  const now = 10_000;

  assert.equal(isTokenExpired(null, now), true);
  assert.equal(isTokenExpired({}, now), true);
  assert.equal(isTokenExpired({ expiresAt: Number.NaN }, now), true);
  assert.equal(isTokenExpired({ expiresAt: Number.POSITIVE_INFINITY }, now), true);
  assert.equal(isTokenExpired({ expiresAt: now + TOKEN_SKEW_MS }, now), true);
  assert.equal(isTokenExpired({ expiresAt: now + TOKEN_SKEW_MS + 1 }, now), false);
  assert.equal(isTokenExpired({ expiresAt: now + 1_000 }, now, 0), false);
  assert.equal(isTokenExpired({ expiresAt: now }, now, 0), true);
});

test('requestToken configures GIS with the client ID and read-only scope', async () => {
  const calls = [];
  const token = await requestToken({
    clientId: 'client-1',
    getGis: async () => tokenClient({ access_token: 'tok', expires_in: 120, scope: 'drive' }, calls),
    now: () => 5_000,
  });

  assert.deepEqual(token, { accessToken: 'tok', expiresAt: 125_000, scope: 'drive' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].client_id, 'client-1');
  assert.equal(calls[0].scope, DRIVE_SCOPE);
});

test('requestToken rejects with the GIS callback error code', async () => {
  const calls = [];
  const pending = requestToken({
    clientId: 'client-1',
    getGis: async () => tokenClient({ error: 'access_denied' }, calls),
  });

  await assert.rejects(
    pending,
    (error) => error instanceof GdriveAuthError && error.code === 'access_denied',
  );
});

test('requestToken rejects blank configuration without loading GIS', async () => {
  let gisCalls = 0;
  const getGis = async () => {
    gisCalls += 1;
    return tokenClient({ access_token: 'tok', expires_in: 60 }, []);
  };

  await assert.rejects(
    requestToken({ clientId: '   ', getGis }),
    (error) => error instanceof GdriveAuthError && error.code === 'not_configured',
  );
  assert.equal(gisCalls, 0);
});
