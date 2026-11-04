/**
 * File-like view over a remote download URL. Exposes only what
 * `src/core/metadata/index.js` needs: `name`, `size` and
 * `slice(start, end).arrayBuffer()`.
 *
 * The first slice prefetches the head (and the tail of a large file) so ID3
 * parsing does not turn into one request per tag field. Slices outside those
 * buffers are fetched on demand. A `200` response means the server ignored
 * `Range`; small files are then kept whole, large ones fail loudly.
 */

export function createRemoteFile({
  name,
  size,
  fetchRange,
  headBytes = 262144,
  tailBytes = 128,
  maxRangeBytes = 32 * 1024 * 1024,
}) {
  const total = Number.isFinite(size) && size > 0 ? size : 0;
  let head = null;
  let tail = null;
  let whole = null;
  let preload = null;

  const asBytes = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  function absorb(result) {
    const bytes = asBytes(result.bytes);
    if (result.status !== 200) return false;
    if (bytes.length > maxRangeBytes) throw new Error('range ignored for large file');
    whole = bytes;
    return true;
  }

  async function prefetch() {
    if (total === 0) return;
    const first = await fetchRange(0, Math.min(total - 1, headBytes - 1));
    if (absorb(first)) return;
    head = asBytes(first.bytes);
    if (total > headBytes) {
      const last = await fetchRange(Math.max(total - tailBytes, 0), total - 1);
      if (absorb(last)) return;
      tail = asBytes(last.bytes);
    }
  }

  function ensurePrefetch() {
    if (!preload) preload = prefetch();
    return preload;
  }

  async function read(start, end) {
    await ensurePrefetch();
    if (whole) return whole.slice(start, end);
    if (head && end <= head.length) return head.slice(start, end);
    const tailStart = total - (tail?.length ?? 0);
    if (tail && start >= tailStart) return tail.slice(start - tailStart, end - tailStart);

    const result = await fetchRange(start, end - 1);
    const bytes = asBytes(result.bytes);
    if (result.status === 200) {
      if (bytes.length > maxRangeBytes) throw new Error('range ignored for large file');
      whole = bytes;
      return whole.slice(start, end);
    }
    return bytes;
  }

  return {
    name,
    size: total,
    slice(start = 0, end = total) {
      const from = Math.min(Math.max(Number(start) || 0, 0), total);
      const to = Math.min(Math.max(Number(end) || 0, from), total);
      return {
        size: to - from,
        async arrayBuffer() {
          if (total === 0 || to === from) {
            await ensurePrefetch();
            return new ArrayBuffer(0);
          }
          const bytes = await read(from, to);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  };
}
