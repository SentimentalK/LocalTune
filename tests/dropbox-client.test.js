import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROPBOX_CONTENT_URL,
  DROPBOX_RPC_URL,
} from '../src/core/sources/dropbox/config.js';
import {
  DROPBOX_AUDIO_EXTENSIONS,
  DropboxError,
  apiPath,
  audioEntries,
  cleanPath,
  createDropboxClient,
  extensionOf,
  isAudioName,
  relativeToRoot,
} from '../src/core/sources/dropbox/client.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function jsonErrorResponse(status, body) {
  return {
    status,
    ok: false,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('listFolder merges pages and continues from the cursor', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/files/list_folder')) {
      return jsonResponse(200, {
        entries: [
          { '.tag': 'file', name: 'a.mp3', path_display: '/Music/a.mp3' },
          { '.tag': 'file', name: 'b.mp3', path_display: '/Music/b.mp3' },
        ],
        has_more: true,
        cursor: 'c1',
      });
    }
    return jsonResponse(200, {
      entries: [{ '.tag': 'file', name: 'c.mp3', path_display: '/Music/c.mp3' }],
      has_more: false,
    });
  };
  const client = createDropboxClient({ fetchImpl, getToken: () => 'token' });

  const names = [];
  for await (const entry of client.listFolder({ path: '/Music' })) names.push(entry.name);

  assert.deepEqual(names, ['a.mp3', 'b.mp3', 'c.mp3']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${DROPBOX_RPC_URL}/files/list_folder`);
  assert.equal(calls[1].url, `${DROPBOX_RPC_URL}/files/list_folder/continue`);
  assert.deepEqual(calls[1].body, { cursor: 'c1' });
});

test('listFolder sends the listing options in the first request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(200, { entries: [], has_more: false });
  };
  const client = createDropboxClient({ fetchImpl, getToken: () => 'token' });

  for await (const entry of client.listFolder({ path: 'Music', recursive: true, limit: 25 })) {
    assert.fail(`unexpected entry ${entry.name}`);
  }

  assert.deepEqual(calls[0].body, {
    path: 'Music',
    recursive: true,
    limit: 25,
    include_deleted: false,
    include_non_downloadable_files: false,
  });
});

test('rpc authorizes, sends JSON and maps errors to DropboxError', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return jsonResponse(200, { entries: [] });
    }
    return jsonErrorResponse(401, {
      error_summary: 'expired_access_token/...',
      error: { '.tag': 'expired_access_token' },
    });
  };
  const client = createDropboxClient({ fetchImpl, getToken: () => 'the-token' });

  assert.deepEqual(await client.rpc('/files/list_folder', { path: '' }), { entries: [] });

  assert.equal(calls[0].url, `${DROPBOX_RPC_URL}/files/list_folder`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer the-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, JSON.stringify({ path: '' }));

  await assert.rejects(client.rpc('/files/list_folder', {}), (error) => {
    assert.ok(error instanceof DropboxError);
    assert.equal(error.name, 'DropboxError');
    assert.equal(error.status, 401);
    assert.equal(error.code, 'expired_access_token');
    return true;
  });
});

test('download sends the API arg header and parses the result metadata', async () => {
  const calls = [];
  const blob = { type: 'audio/mpeg' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      ok: true,
      async blob() {
        return blob;
      },
      headers: {
        get(name) {
          return name === 'Dropbox-API-Result'
            ? JSON.stringify({ name: 'a.mp3', path_display: '/Music/a.mp3', size: 1234 })
            : null;
        },
      },
    };
  };
  const client = createDropboxClient({ fetchImpl, getToken: () => 'the-token' });

  const result = await client.download('/Music/a.mp3');

  assert.equal(calls[0].url, `${DROPBOX_CONTENT_URL}/files/download`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer the-token');
  assert.deepEqual(JSON.parse(calls[0].init.headers['Dropbox-API-Arg']), {
    path: '/Music/a.mp3',
  });
  assert.equal(new Headers(calls[0].init.headers).has('Content-Type'), false);
  assert.equal(result.blob, blob);
  assert.deepEqual(result.metadata, {
    name: 'a.mp3',
    path_display: '/Music/a.mp3',
    size: 1234,
  });
});

test('audioEntries keeps supported audio files and drops the rest', () => {
  const entries = [
    { '.tag': 'file', name: 'one.mp3' },
    { '.tag': 'file', name: 'two.M4A' },
    { '.tag': 'file', name: 'three.aac' },
    { '.tag': 'file', name: 'four.opus' },
    { '.tag': 'folder', name: 'folder.mp3' },
    { '.tag': 'file', name: '.hidden.mp3' },
    { '.tag': 'file', name: 'notes.txt' },
    { '.tag': 'file', name: 42 },
  ];

  assert.deepEqual(
    audioEntries(entries).map((entry) => entry.name),
    ['one.mp3', 'two.M4A', 'three.aac', 'four.opus'],
  );
  assert.equal(DROPBOX_AUDIO_EXTENSIONS.has('flac'), true);
  assert.equal(isAudioName('track.FLAC'), true);
  assert.equal(extensionOf('no-extension'), '');
  assert.equal(cleanPath('/Music//Albums/'), 'Music/Albums');
});

test('relativeToRoot resolves case-insensitive app paths', () => {
  assert.equal(relativeToRoot('Music', '/Music/a/b.mp3'), 'a/b.mp3');
  assert.equal(relativeToRoot('Music', '/Music'), '');
  assert.equal(relativeToRoot('music', '/Music/a.mp3'), 'a.mp3');
  assert.equal(relativeToRoot('Music', '/Other/a.mp3'), 'Other/a.mp3');
  assert.equal(relativeToRoot('', '/a.mp3'), 'a.mp3');
});

test('apiPath keeps the Dropbox root as the empty string', () => {
  assert.equal(apiPath(''), '');
  assert.equal(apiPath('Music'), '/Music');
  assert.equal(apiPath('/Music/'), '/Music');
});
