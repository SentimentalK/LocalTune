/**
 * Pure queue state machine. Every exported function returns a fresh object;
 * nothing here touches the DOM or storage.
 */

const REPEAT_CYCLE = { off: 'all', all: 'one', one: 'off' };

function identityOrder(length) {
  const order = new Array(length);
  for (let i = 0; i < length; i += 1) order[i] = i;
  return order;
}

function shuffleOrder(length, first) {
  const pool = [];
  for (let i = 0; i < length; i += 1) {
    if (i !== first) pool.push(i);
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return [first, ...pool];
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

export function setQueue(state, tracks, startIndex = 0) {
  const list = Array.from(tracks ?? []);
  const base = state ?? createQueue([]);
  if (!list.length) {
    return { ...base, tracks: [], index: -1, order: [], cursor: 0 };
  }
  const requested = Number.isInteger(startIndex) ? startIndex : 0;
  const index = Math.min(Math.max(requested, 0), list.length - 1);
  const order = base.shuffle ? shuffleOrder(list.length, index) : identityOrder(list.length);
  return { ...base, tracks: list, index, order, cursor: order.indexOf(index) };
}

export function currentTrack(state) {
  const index = state?.index ?? -1;
  if (!state?.tracks || index < 0 || index >= state.tracks.length) return null;
  return state.tracks[index] ?? null;
}

export function advance(state, { auto = false } = {}) {
  if (!state?.tracks?.length || state.index < 0) return { state, ended: true };
  if (auto && state.repeat === 'one') return { state, ended: false };

  const cursor = state.order.indexOf(state.index);
  const nextCursor = cursor + 1;
  if (cursor >= 0 && nextCursor < state.order.length) {
    return { state: { ...state, index: state.order[nextCursor], cursor: nextCursor }, ended: false };
  }
  if (state.repeat === 'all' && state.order.length) {
    return { state: { ...state, index: state.order[0], cursor: 0 }, ended: false };
  }
  return { state, ended: true };
}

export function back(state) {
  if (!state?.tracks?.length || state.index < 0) return { state };
  const cursor = state.order.indexOf(state.index);
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

  const nextIndex = state.index === index ? Math.min(index, tracks.length - 1) : map.get(state.index) ?? 0;
  let cursor = order.indexOf(nextIndex);
  if (cursor < 0) {
    order.unshift(nextIndex);
    cursor = 0;
  }
  return { ...state, tracks, index: nextIndex, order, cursor };
}
