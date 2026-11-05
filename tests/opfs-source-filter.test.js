import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpfsSource } from '../src/core/sources/opfs/source.js';
import { t } from '../src/i18n/index.js';

function textFile(name = 'note.txt') {
  return new File(['hello'], name);
}

test('opfs importFiles: a non-audio-only selection aborts with noAudio', async () => {
  const source = new OpfsSource({ db: null, storage: null, document: null });
  await assert.rejects(
    () => source.importFiles([textFile(), new File(['x'], 'cover.jpg')]),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.message, t('error.source.noAudio'));
      return true;
    },
  );
});

test('opfs importHandle: a directory with only non-audio files aborts with noAudio', async () => {
  const source = new OpfsSource({ db: null, storage: null, document: null });
  const dir = {
    kind: 'directory',
    name: 'Album',
    async *entries() {
      yield ['note.txt', { kind: 'file', getFile: async () => textFile() }];
    },
  };
  await assert.rejects(() => source.importHandle(dir), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, t('error.source.noAudio'));
    return true;
  });
});
