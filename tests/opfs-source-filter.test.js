import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpfsSource } from '../src/core/sources/opfs/source.js';
import { t } from '../src/i18n/index.js';

function lrcFile(name = 'a.lrc') {
  return new File(['[00:01]hello'], name);
}

test('opfs importFiles: a lyrics-only selection aborts with noAudio', async () => {
  const source = new OpfsSource({ db: null, storage: null, document: null });
  await assert.rejects(
    () => source.importFiles([lrcFile(), new File(['x'], 'cover.jpg')]),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.message, t('error.source.noAudio'));
      return true;
    },
  );
});

test('opfs importHandle: a directory with only lyrics aborts with noAudio', async () => {
  const source = new OpfsSource({ db: null, storage: null, document: null });
  const dir = {
    kind: 'directory',
    name: 'Album',
    async *entries() {
      yield ['a.lrc', { kind: 'file', getFile: async () => lrcFile() }];
    },
  };
  await assert.rejects(() => source.importHandle(dir), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, t('error.source.noAudio'));
    return true;
  });
});
