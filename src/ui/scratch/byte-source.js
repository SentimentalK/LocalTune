/**
 * Byte-range access for the scratch decoder. It answers the two questions the
 * range path needs — how large the media is, where the audio payload starts,
 * and how to read a byte slice — without decoding the whole track.
 *
 * - HTTP(S): `HEAD` (or a 2-byte Range probe) for the size, then real Range
 *   requests. Servers that answer 200 instead of 206 are reported as having no
 *   range support, and the caller falls back to whole-file decoding.
 * - Everything else (local FSA/OPFS files, blob-backed cache entries): the
 *   store reads the File metadata and slices it with `Blob.slice`.
 *
 * MP3 files often carry a 2 MB embedded cover inside the ID3v2 tag. Mapping
 * time to bytes from offset 0 would land inside that tag, so the first bytes
 * are inspected and the tag length is skipped before the bitrate is computed.
 */

const HEAD_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;

function audioStartFromHead(bytes) {
  if (!bytes || bytes.byteLength < HEAD_BYTES) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0; // "ID3"
  const size =
    (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const footer = (bytes[5] & ID3_FOOTER_FLAG) !== 0 ? 10 : 0;
  return Math.max(size + 10 + footer, 0);
}

/**
 * @param {{
 *   audio?: HTMLAudioElement | null,
 *   track?: object | null,
 *   store?: { trackFile?: Function } | null,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createByteSource({
  audio = null,
  track = null,
  store = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = audio?.currentSrc || audio?.src || '';
  const http = /^https?:/i.test(url);
  let infoPromise = null;
  let file = null;

  async function fileInfo() {
    if (!store || typeof store.trackFile !== 'function') return null;
    file = await store.trackFile(track);
    const size = Number(file?.size) || 0;
    return size > 0 ? { size, kind: 'file' } : null;
  }

  async function describe() {
    infoPromise ??= (async () => {
      let info = null;
      if (http) {
        const probe = await fetchImpl(url, { headers: { Range: 'bytes=0-1' } });
        let size = 0;
        if (probe.status === 206) {
          const match = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') ?? '');
          size = match ? Number(match[1]) : 0;
        } else {
          size = Number(probe.headers.get('content-length')) || 0;
        }
        try {
          await probe.body?.cancel();
        } catch {
          // no body to cancel
        }
        if (size > 0) info = { size, kind: 'http' };
      } else {
        info = await fileInfo();
      }
      if (!info) return null;
      let audioStart = 0;
      try {
        let head;
        if (info.kind === 'file') {
          head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
        } else {
          const response = await fetchImpl(url, {
            headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
          });
          if (response.status === 206) head = new Uint8Array(await response.arrayBuffer());
        }
        if (head) audioStart = Math.min(audioStartFromHead(head), info.size);
      } catch {
        audioStart = 0;
      }
      return { ...info, audioStart };
    })().catch(() => null);
    return infoPromise;
  }

  /**
   * Raw bytes `[start, end)`. `full` allows a server that ignores Range to
   * return the whole body instead of failing.
   */
  async function read(start, end, full = false) {
    const info = await describe();
    if (!info) throw new Error('no-source');
    const from = Math.max(Math.floor(Number(start) || 0), 0);
    const to = Math.min(Math.ceil(Number(end) || info.size), info.size);
    if (!(to > from)) return new ArrayBuffer(0);
    if (info.kind === 'file') return file.slice(from, to).arrayBuffer();
    const response = await fetchImpl(url, { headers: { Range: `bytes=${from}-${to - 1}` } });
    if (response.status === 206 || (full && response.ok)) return response.arrayBuffer();
    try {
      await response.body?.cancel();
    } catch {
      // already gone
    }
    throw new Error('no-range');
  }

  return { describe, read };
}
