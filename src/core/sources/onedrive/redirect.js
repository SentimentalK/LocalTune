/**
 * OneDrive authorization-code exchange state machine. Loaded lazily, only when
 * the URL carries an OAuth response, so plain startup never pays for it.
 *
 * The same redirect URL can be loaded by two documents (installed PWA and the
 * Custom Tab that caught the redirect), so the code is claimed in IndexedDB
 * and POSTed at most once: the other document reuses the stored token or waits
 * for the in-flight exchange. Never throws: failures land in the source's
 * `authError` / `authStage` and return false.
 */

import { PKCE_KEY, PKCE_TTL_MS, buildTokenRequest, requestToken } from './auth.js';

const AUTH_KEY = 'onedriveAuth';
const AUTH_WAIT_MS = 5000;
const AUTH_POLL_MS = 200;

/**
 * @param {import('./source.js').OneDriveSource} source
 * @param {{ code?: string, state?: string, error?: string, errorDescription?: string }} params
 * @returns {Promise<boolean>} true when a token is available
 */
export async function handleRedirect(source, params) {
  const { code, state, error, errorDescription } = params;

  if (error && !code) {
    return abort(source, errorDescription || error);
  }

  if (!code) return false;

  if (!state) {
    return abort(source, 'state mismatch');
  }

  const now = source.now();
  const record = await source._getMeta(AUTH_KEY);
  if (record && record.state === state && now - Number(record.at) <= PKCE_TTL_MS) {
    if (record.status === 'done') {
      const token = await source._getMeta('onedriveToken');
      return token ? finishAuth(source, token) : failAuth(source, 'token', 'token missing');
    }
    if (record.status === 'error') {
      return failAuth(source, record.stage ?? 'token', record.error ?? 'token exchange failed');
    }
    if (record.status === 'claimed' && record.code === code) {
      const pkce = await source._getMeta(PKCE_KEY);
      if (!pkce || pkce.state !== state) return failAuth(source, 'token', 'token missing');
      if (await claimPosting(source, record, code, state)) {
        return exchange(source, state, code, pkce);
      }
    }
    if (record.status === 'claimed' || record.status === 'posting') {
      return awaitAuth(source, state);
    }
  }

  const pkce = await source._getMeta(PKCE_KEY);
  if (!pkce || pkce.state !== state) {
    return abort(source, 'state mismatch');
  }

  const at = Number(pkce.at);
  if (!Number.isFinite(at) || source.now() - at > PKCE_TTL_MS) {
    return abort(source, 'expired');
  }

  // The PKCE entry stays in `meta` until the exchange settles: whoever claims
  // the code needs the verifier, and the claim (not the deletion) is what
  // makes the code single use.
  const claim = await source.meta.update(AUTH_KEY, (current) => {
    if (current && current.state === state && now - Number(current.at) <= PKCE_TTL_MS) {
      return undefined;
    }
    return { state, code, at: now, status: 'claimed' };
  });

  if (!claim.changed) return resumeAuth(source, state, code);
  if (!(await claimPosting(source, claim.value, code, state))) return awaitAuth(source, state);
  return exchange(source, state, code, pkce);
}

/** Promote a `claimed` record to `posting` atomically. Only the winner of the
 * CAS race may send the token request. */
async function claimPosting(source, record, code, state) {
  const at = Number(record?.at);
  const result = await source.meta.update(AUTH_KEY, (current) => {
    if (
      !current ||
      current.state !== state ||
      current.status !== 'claimed' ||
      current.code !== code ||
      Number(current.at) !== at
    ) {
      return undefined;
    }
    return { ...current, status: 'posting', at: source.now() };
  });
  return result.changed;
}

/** Another document owns the record: follow its state or take over a
 * `claimed` record whose document never started POSTing. */
async function resumeAuth(source, state, code) {
  const record = await source._getMeta(AUTH_KEY);
  if (!record || record.state !== state) return abort(source, 'state mismatch');
  if (record.status === 'done') {
    const token = await source._getMeta('onedriveToken');
    return token ? finishAuth(source, token) : failAuth(source, 'token', 'token missing');
  }
  if (record.status === 'error') {
    return failAuth(source, record.stage ?? 'token', record.error ?? 'token exchange failed');
  }
  if (record.status === 'claimed' && record.code === code) {
    const pkce = await source._getMeta(PKCE_KEY);
    if (!pkce || pkce.state !== state) return failAuth(source, 'token', 'token missing');
    if (await claimPosting(source, record, code, state)) {
      return exchange(source, state, code, pkce);
    }
  }
  return awaitAuth(source, state);
}

/** Poll the shared record while another document may hold the POST. A timeout
 * is reported as `pending`; it never starts a second exchange. */
async function awaitAuth(source, state) {
  const deadline = source.now() + AUTH_WAIT_MS;
  let waited = 0;
  for (;;) {
    const record = await source._getMeta(AUTH_KEY);
    if (record && record.state === state) {
      if (record.status === 'done') {
        const token = await source._getMeta('onedriveToken');
        return token ? finishAuth(source, token) : failAuth(source, 'token', 'token missing');
      }
      if (record.status === 'error') {
        return failAuth(source, record.stage ?? 'token', record.error ?? 'token exchange failed');
      }
      if (record.status === 'claimed') {
        const pkce = await source._getMeta(PKCE_KEY);
        if (
          pkce &&
          pkce.state === state &&
          (await claimPosting(source, record, record.code, state))
        ) {
          return exchange(source, state, record.code, pkce);
        }
      }
    }
    if (waited >= AUTH_WAIT_MS || source.now() > deadline) break;
    await source.wait(AUTH_POLL_MS);
    waited += AUTH_POLL_MS;
  }
  return failAuth(source, 'pending', 'auth exchange still in progress');
}

async function exchange(source, state, code, pkce) {
  try {
    const token = await requestToken(
      buildTokenRequest({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: pkce.redirectUri ?? source.redirectUri,
      }),
      source.fetchImpl,
    );
    await source.meta.set('onedriveToken', token);
    await source.meta.set('onedriveAuthAt', source.now());
    await source._setMeta(AUTH_KEY, { state, code, at: source.now(), status: 'done' });
    await source._clearPkce();
    return finishAuth(source, token);
  } catch (failure) {
    const message = failure?.message ? String(failure.message) : String(failure);
    await source._setMeta(AUTH_KEY, {
      state,
      code,
      at: source.now(),
      status: 'error',
      stage: 'token',
      error: message,
    });
    await source._clearPkce();
    return failAuth(source, 'token', message);
  }
}

function finishAuth(source, token) {
  source._token = token;
  source._permission = 'granted';
  source._clearQuery();
  source.authError = null;
  source.authStage = null;
  return true;
}

function failAuth(source, stage, message) {
  source._clearQuery();
  source.authError = message;
  source.authStage = stage;
  return false;
}

async function abort(source, message) {
  await source._clearPkce();
  source._clearQuery();
  source.authError = message;
  source.authStage = 'redirect';
  return false;
}
