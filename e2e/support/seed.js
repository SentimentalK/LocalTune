import { expect } from '@playwright/test';

/** Two 8-second silent WAVs and their local library rows. */
export async function seedLocalLibrary(page, { files = null } = {}) {
  await page.evaluate(async (customFiles) => {
    const wav = (name) => {
      const sampleRate = 8000;
      const samples = sampleRate * 60;
      const bytes = 44 + samples * 2;
      const buffer = new ArrayBuffer(bytes);
      const view = new DataView(buffer);
      const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, bytes - 8, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, 'data');
      view.setUint32(40, samples * 2, true);
      return new File([buffer], name, { type: 'audio/wav', lastModified: Date.now() });
    };

    const fromBytes = (entry) => {
      const bytes = Uint8Array.from(atob(entry.bytesBase64), (char) => char.charCodeAt(0));
      return new File([bytes], entry.path.split('/').pop(), {
        type: entry.type ?? 'audio/mpeg',
        lastModified: Date.now(),
      });
    };

    const rows = customFiles
      ? customFiles.map((entry) => ({ path: entry.path, file: fromBytes(entry) }))
      : ['Music/a.wav', 'Music/b.wav'].map((path) => ({
          path,
          file: wav(path.split('/').pop()),
        }));

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks'], 'readwrite');
        tx.objectStore('meta').put({
          key: 'fileList',
          value: rows.map(({ path, file }) => ({ path, file })),
        });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        const store = tx.objectStore('tracks');
        for (const { path, file } of rows) {
          store.put({
            id: `fsa:${path}`,
            path,
            title: path.split('/').pop().replace(/\.[^.]+$/, ''),
            artist: '',
            album: '',
            year: null,
            trackNo: null,
            duration: 60,
            mtime: file.lastModified,
            size: file.size,
            cover: null,
            source: 'fsa',
            externalIds: {},
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, files);
}

export async function openSeededLibrary(page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });
  await seedLocalLibrary(page);
  await page.reload();
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
}
