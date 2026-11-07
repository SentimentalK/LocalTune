/**
 * Pure queue state machine. Every exported function returns a fresh object;
 * nothing here touches the DOM or storage.
 *
 * Model: `tracks` keeps the authoritative (original) order. `order` is a
 * permutation of track indices — the playback order — and `cursor` is the
 * position of the current track inside `order`, so `order[cursor] === index`
 * always holds. One round is `order` from `cursor` onwards. Functions that need
 * a position read `cursor`; nothing guesses a position from `tracks`.
 */

const REPEAT_CYCLE = { off: 'all', all: 'one', one: 'off' };

function identityOrder(length) {
  const order = new Array(length);
  for (let i = 0; i < length; i += 1) order[i] = i;
  return order;
}

function shuffledSlice(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** `first` opens the round; the rest are shuffled behind it. */
function shuffleOrder(length, first) {
  if (!(length > 0)) return [];
  const start = Number.isInteger(first) && first >= 0 && first < length ? first : 0;
  const pool = [];
  for (let i = 0; i < length; i += 1) {
    if (i !== start) pool.push(i);
  }
  return [start, ...shuffledSlice(pool)];
}

/** A random index other than `index`; a one-track queue has to reuse it. */
function differentIndex(length, index) {
  if (length <= 1) return 0;
  const pick = Math.floor(Math.random() * (length - 1));
  return pick >= index ? pick + 1 : pick;
}

function clampIndex(index, length) {
  const value = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(value, 0), length - 1);
}

/**
 * Position of `index` inside `order`. `cursor` is authoritative and is not
 * recomputed from scratch; the `indexOf` branch only repairs a state that was
 * built outside this module. A miss returns -1 and callers stop instead of
 * silently jumping to `order[0]`.
 */
function positionOf(state) {
  if (state.order[state.cursor] === state.index) return state.cursor;
  return state.order.indexOf(state.index);
}

export function createQueue(tracks = []) {
  const list = Array.from(tracks ?? []);
  return {
    tracks: list,
    index: list.length ? 0 : -1,
    shuffle: false,
    repeat: 'off',
    order: identityOrder(list.length),
    cursor: 0,
  };
}

/** Start a fresh round over `tracks`; the requested track opens it. */
export function setQueue(state, tracks, startIndex = 0) {
  const list = Array.from(tracks ?? []);
  const base = state ?? createQueue([]);
  if (!list.length) {
    return { ...base, tracks: [], index: -1, order: [], cursor: 0 };
  }
  const index = clampIndex(startIndex, list.length);
  const order = base.shuffle ? shuffleOrder(list.length, index) : identityOrder(list.length);
  return { ...base, tracks: list, index, order, cursor: order.indexOf(index) };
}

/**
 * Keep the running round while `tracks` changes shape: order entries are
 * remapped by track id (never by raw position), so a reordered library or a
 * metadata refill cannot point `order` at the wrong song. Returns null when
 * the id set changed — the caller then starts a fresh round.
 *
 * The playhead moves to `startIndex`: tapping a row is "play it now", even if
 * that track was already played. Automatic `advance` never repeats a track
 * inside one forward pass; only an explicit tap can re-enter it.
 */
export function alignQueue(state, tracks, startIndex = 0) {
  const list = Array.from(tracks ?? []);
  const current = state?.tracks ?? [];
  if (!list.length || list.length !== current.length) return null;
  const positionById = new Map(list.map((track, i) => [track.id, i]));
  if (positionById.size !== list.length) return null;
  const order = [];
  for (const oldIndex of state.order) {
    const mapped = positionById.get(current[oldIndex]?.id);
    if (mapped === undefined) return null;
    order.push(mapped);
  }
  if (order.length !== list.length) return null;
  const index = clampIndex(startIndex, list.length);
  const cursor = order.indexOf(index);
  if (cursor < 0) return null;
  return { ...state, tracks: list, index, order, cursor };
}

/**
 * Extend the queue without rewinding the round: new tracks join the tail of
 * `order` (shuffled among themselves when shuffle is on). The current track
 * and everything already played stay where they are.
 */
export function appendQueue(state, tracks) {
  const list = Array.from(tracks ?? []).filter(Boolean);
  const base = state ?? createQueue([]);
  if (!list.length) return base;
  if (!base.tracks.length) return setQueue(base, list, 0);
  const offset = base.tracks.length;
  const added = [];
  for (let i = 0; i < list.length; i += 1) added.push(offset + i);
  const order = [...base.order, ...(base.shuffle ? shuffledSlice(added) : added)];
  return { ...base, tracks: [...base.tracks, ...list], order };
}

/** Play the track at `index` now. Only an explicit tap can revisit a track. */
export function moveTo(state, index) {
  if (!state?.tracks?.length || !Number.isInteger(index)) return state;
  if (index < 0 || index >= state.tracks.length) return state;
  const cursor = state.order.indexOf(index);
  if (cursor < 0) return state;
  return { ...state, index, cursor };
}

/**
 * Re-apply a session round (playback order by id) to a freshly restored queue.
 * Surviving ids keep their relative order, ids that appeared after the round
 * started join the tail, and the cursor follows the saved current track. A
 * missing current track returns null: the caller reshuffles once.
 */
export function restoreRound(state, stored) {
  const list = state?.tracks ?? [];
  if (!list.length || !stored || !Array.isArray(stored.ids)) return null;
  const positionById = new Map(list.map((track, i) => [track.id, i]));
  const seen = new Set();
  const order = [];
  for (const id of stored.ids) {
    const index = positionById.get(id);
    if (index === undefined || seen.has(index)) continue;
    seen.add(index);
    order.push(index);
  }
  const rest = [];
  for (let i = 0; i < list.length; i += 1) {
    if (!seen.has(i)) rest.push(i);
  }
  order.push(...(state.shuffle ? shuffledSlice(rest) : rest));
  if (stored.indexId == null) return null;
  const index = positionById.get(stored.indexId);
  if (index === undefined) return null;
  return { ...state, order, index, cursor: order.indexOf(index) };
}

export function currentTrack(state) {
  const index = state?.index ?? -1;
  if (!state?.tracks || index < 0 || index >= state.tracks.length) return null;
  return state.tracks[index] ?? null;
}

export function advance(state, { auto = false } = {}) {
  if (!state?.tracks?.length || state.index < 0) return { state, ended: true };
  if (auto && state.repeat === 'one') return { state, ended: false };

  const cursor = positionOf(state);
  if (cursor < 0) return { state, ended: true };
  const nextCursor = cursor + 1;
  if (nextCursor < state.order.length) {
    return { state: { ...state, index: state.order[nextCursor], cursor: nextCursor }, ended: false };
  }
  if (state.repeat === 'all' && state.order.length) {
    // A new round reshuffles and never opens with the track that just ended.
    const first = differentIndex(state.order.length, state.index);
    const order = shuffleOrder(state.order.length, first);
    return { state: { ...state, order, index: first, cursor: 0 }, ended: false };
  }
  return { state, ended: true };
}

export function back(state) {
  if (!state?.tracks?.length || state.index < 0) return { state };
  const cursor = positionOf(state);
  if (cursor < 0) return { state };
  if (cursor > 0) {
    const target = cursor - 1;
    return { state: { ...state, index: state.order[target], cursor: target } };
  }
  if (state.repeat === 'all' && state.order.length) {
    const target = state.order.length - 1;
    return { state: { ...state, index: state.order[target], cursor: target } };
  }
  return { state };
}

export function toggleShuffle(state) {
  const shuffle = !state.shuffle;
  const list = state.tracks ?? [];
  if (!list.length || state.index < 0) {
    return { ...state, shuffle, order: [], cursor: 0 };
  }
  const order = shuffle ? shuffleOrder(list.length, state.index) : identityOrder(list.length);
  return { ...state, shuffle, order, cursor: order.indexOf(state.index) };
}

export function cycleRepeat(state) {
  return { ...state, repeat: REPEAT_CYCLE[state.repeat] ?? 'off' };
}

export function removeAt(state, index) {
  const list = Array.from(state?.tracks ?? []);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return state;

  const tracks = [];
  const map = new Map();
  list.forEach((track, i) => {
    if (i === index) return;
    map.set(i, tracks.length);
    tracks.push(track);
  });

  if (!tracks.length) {
    return { ...state, tracks, index: -1, order: [], cursor: 0 };
  }

  const order = (state.order ?? identityOrder(list.length))
    .filter((i) => map.has(i))
    .map((i) => map.get(i));

  let index2;
  let cursor;
  if (state.index === index) {
    // The successor in playback order moves into the freed slot; removing the
    // last track falls back to the new end. Never jump back to the round start.
    cursor = Math.min(state.cursor, order.length - 1);
    index2 = order[cursor];
  } else {
    const mapped = map.get(state.index);
    if (mapped === undefined) return state;
    index2 = mapped;
    cursor = order.indexOf(index2);
    if (cursor < 0) {
      // Only reachable for a hand-built state; never jump to `order[0]`.
      order.push(index2);
      cursor = order.length - 1;
    }
  }
  return { ...state, tracks, index: index2, order, cursor };
}
