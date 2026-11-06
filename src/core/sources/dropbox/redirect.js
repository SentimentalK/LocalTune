/**
 * Dropbox authorization-code exchange. Loaded lazily, only when the URL
 * carries an OAuth response, so plain startup never pays for it.
 *
 * Unlike OneDrive there is no cross-document claim machinery: the Dropbox
 * redirect is a full-page navigation back to the app, so a single document
 * owns the exchange. The `dropboxAuth` record still guards against exchanging
 * the same code twice in that document. Never throws: failures land in the
 * source's `authError` / `authStage` and return false.
 */

import {
  PKCE_KEY,
  PKCE_TTL_MS,
  TOKEN_KEY,
  buildTokenRequest,
  requestToken,
} from './auth.js';

/**
 * @param {import('./source.js').DropboxSource} source
 * @param {{ code?: string|null, state?: string|null, error?: string|null, errorDescription?: string|null }} params
 * @returns {Promise<boolean>} true when a token is available
 */
export async function handleRedirect(source, params) {
  try {
    const { code, state, error, errorDescription } = params;

    if (error && !code) {
      const pkce = await source._getMeta(PKCE_KEY);
      if (!pkce || pkce.state !== state) return false;
      return abort(source, errorDescription || error);
    }

    if (!code) return false;

    const pkce = await source._getMeta(PKCE_KEY);
    if (!pkce) return false;

    if (!state || pkce.state !== state) {
      return abort(source, 'state mismatch');
    }

    const at = Number(pkce.at);
    if (!Number.isFinite(at) || source.now() - at > PKCE_TTL_MS) {
      return abort(source, 'expired');
    }

    const record = await source._getMeta('dropboxAuth');
    if (record?.state === state) {
      if (record.status === 'done') {
        const token = await source._getMeta(TOKEN_KEY);
        return token ? finishAuth(source, token) : failAuth(source, 'token', 'token missing');
      }
      if (record.status === 'error') {
        return failAuth(source, record.stage ?? 'token', record.error ?? 'token exchange failed');
      }
      if (record.status === 'posting') {
        return failAuth(source, 'pending', 'auth exchange still in progress');
      }
    }

    await source._setMeta('dropboxAuth', { state, at: source.now(), status: 'posting' });

    try {
      const token = await requestToken(
        buildTokenRequest({
          appKey: source.appKey,
          code,
          codeVerifier: pkce.verifier,
          redirectUri: pkce.redirectUri ?? source.redirectUri,
        }),
        source.fetchImpl,
      );
      await source.meta.set(TOKEN_KEY, token);
      await source.meta.set('dropboxAuthAt', source.now());
      await source._setMeta('dropboxAuth', { state, at: source.now(), status: 'done' });
      await source._clearPkce();
      return finishAuth(source, token);
    } catch (failure) {
      const message = String(failure?.message ?? failure);
      await source._setMeta('dropboxAuth', {
        state,
        at: source.now(),
        status: 'error',
        stage: 'token',
        error: message,
      });
      await source._clearPkce();
      return failAuth(source, 'token', message);
    }
  } catch {
    return false;
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
