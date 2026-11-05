/**
 * Playlist UI: the playlist library view and the import dialog. Both only talk
 * to the store (and, for URL imports, to the pure source resolvers); they never
 * touch IndexedDB, OPFS or the audio element. `render(state)` patches lists and
 * text; the only async work happens in click handlers.
 */

import { t } from '../i18n/index.js';
import { el, setHidden, setText } from './dom.js';
import { formatTime } from '../core/selectors.js';
import { mostPlayed, neverPlayed, recentlyAdded } from '../core/stats.js';
import { matchPlaylist } from '../core/playlist/match.js';
import { missingText, m3u8Text, playlistCounts, sanitizeFileName } from '../core/playlist/model.js';
import { parsePlaylistText } from '../core/playlist/parse-text.js';
import { platformOfUrl, resolveViaProxy } from '../core/playlist/sources/proxy.js';
import { resolveYouTubePlaylist } from '../core/playlist/sources/youtube.js';

const PROXY_SOURCES = new Set(['spotify', 'netease', 'qq']);
const YOUTUBE_HOST = /(^|\.)youtube\.com$|^youtu\.be$/i;

/** Auto lists in display order; ids double as `autoList.<id>` keys. */
const AUTO_LISTS = ['recent', 'most', 'never'];

function run(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

/** Copy then Fisher-Yates, so the caller's list stays in its display order. */
function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isYouTubeUrl(url) {
  try {
    return YOUTUBE_HOST.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sourceChip(source) {
  return el('span', { class: 'chip', text: t(`playlists.source.${source}`) });
}

function experimentalChip() {
  return el('span', {
    class: 'chip is-experimental',
    'data-testid': 'source-experimental',
    text: t('playlists.experimental'),
  });
}

function itemLabel(item) {
  const artist = typeof item?.artist === 'string' ? item.artist : '';
  const title = typeof item?.title === 'string' ? item.title : '';
  return artist ? `${artist} - ${title}` : title;
}

function trackLabel(track) {
  const artist = typeof track?.artist === 'string' ? track.artist : '';
  return artist ? `${artist} - ${track.title}` : String(track?.title ?? '');
}

function toastFrom(node, text) {
  node.dispatchEvent(new CustomEvent('toast', { bubbles: true, detail: { text } }));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based copy.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportError(node, error) {
  toastFrom(node, error?.message ? String(error.message) : t('common.unknownError'));
}

function reasonChip(reason) {
  return el('span', {
    class: 'chip',
    text: t(reason === 'artist' ? 'import.reasonArtist' : 'import.reasonDuration'),
  });
}

/**
 * Shared three-column renderer for a list of playlist items. Row indices are
 * the original positions, so the confirm/assign callbacks can address the
 * store (or a draft) without a copy.
 */
function renderColumns(items, { tracks, onConfirm, onAssign }) {
  const list = Array.isArray(items) ? items : [];
  const columns = { matched: [], suspect: [], missing: [] };

  list.forEach((item, index) => {
    const status = item?.status === 'matched' || item?.status === 'suspect' ? item.status : 'missing';
    if (status === 'matched') {
      columns.matched.push(
        el('li', { class: 'playlist-item', 'data-testid': 'result-row' }, [
          el('span', { class: 'item-name', text: itemLabel(item) }),
        ]),
      );
      return;
    }
    if (status === 'suspect') {
      const reasons = Array.isArray(item.reasons) ? item.reasons : [];
      columns.suspect.push(
        el('li', { class: 'playlist-item', 'data-testid': 'result-row' }, [
          el('span', { class: 'item-name', text: itemLabel(item) }),
          reasons.map(reasonChip),
          el('button', {
            class: 'btn-pill ghost',
            type: 'button',
            'data-testid': 'confirm-item',
            text: t('import.confirm'),
            onclick: () => onConfirm(index),
          }),
        ]),
      );
      return;
    }
    const select = el(
      'select',
      { 'data-testid': 'assign-select', 'aria-label': t('import.assign') },
      [
        el('option', { value: '', text: '—' }),
        ...(Array.isArray(tracks) ? tracks : []).map((track) =>
          el('option', { value: track.id, text: trackLabel(track) }),
        ),
      ],
    );
    select.value = typeof item?.matchedTrackId === 'string' ? item.matchedTrackId : '';
    columns.missing.push(
      el('li', { class: 'playlist-item', 'data-testid': 'result-row' }, [
        el('span', { class: 'item-name', text: itemLabel(item) }),
        select,
        el('button', {
          class: 'btn-pill ghost',
          type: 'button',
          'data-testid': 'assign-item',
          text: t('import.assign'),
          onclick: () => {
            const value = select.value;
            if (value) onAssign(index, value);
          },
        }),
      ]),
    );
  });

  const column = (testId, labelKey, rows) =>
    el('section', { class: 'playlist-column', 'data-testid': testId }, [
      el('header', {}, [
        el('span', { text: t(labelKey) }),
        el('span', { text: String(rows.length) }),
      ]),
      el('ul', { class: 'playlist-items' }, rows),
    ]);

  return el('div', { class: 'playlist-columns' }, [
    column('result-matched', 'import.matched', columns.matched),
    column('result-suspect', 'import.suspect', columns.suspect),
    column('result-missing', 'import.missing', columns.missing),
  ]);
}

function canWrite(state) {
  const local = (state.sources ?? []).find((row) => row.id === 'local');
  return local?.permission === 'granted';
}

export function createPlaylistView(store, { onImport } = {}) {
  const node = el('section', { class: 'playlist-view', 'data-testid': 'playlist-view' });
  let selectedId = null;
  let selectedList = null;
  let lastState = store.state;

  function select(id) {
    selectedId = selectedId === id ? null : id;
    paint(lastState);
  }

  function selectList(id) {
    selectedList = selectedList === id ? null : id;
    paint(lastState);
  }

  function autoListTracks(state, id) {
    const tracks = Array.isArray(state.tracks) ? state.tracks : [];
    if (id === 'recent') return recentlyAdded(tracks, state.stats, 50);
    if (id === 'most') return mostPlayed(tracks, state.stats, 50);
    return neverPlayed(tracks, state.stats);
  }

  function playList(list) {
    if (!list.length) {
      toastFrom(node, t('autoList.empty'));
      return;
    }
    run(store.playQueue(list, list[0].id));
  }

  function playShuffled(list) {
    if (!list.length) {
      toastFrom(node, t('autoList.empty'));
      return;
    }
    const order = shuffled(list);
    run(store.playQueue(order, order[0].id));
  }

  function playlistSection(state, playlists) {
    const importButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'import-open',
      text: t('playlists.import'),
      onclick: () => onImport?.(),
    });
    const head = el('header', { class: 'playlist-section-head' }, [
      el('span', { text: t('playlists.title') }),
      el('div', { class: 'playlist-section-actions' }, [
        el('span', { text: String(playlists.length) }),
        importButton,
      ]),
    ]);
    const body = playlists.length
      ? el('ul', { class: 'rows' }, playlists.map((playlist) => rowNode(state, playlist)))
      : el('p', { class: 'muted', 'data-testid': 'playlists-empty', text: t('playlists.empty') });
    return el('section', { class: 'list playlist-list' }, [head, body]);
  }

  function autoSection(state) {
    const rows = AUTO_LISTS.map((id) => {
      const list = autoListTracks(state, id);
      return el('li', { class: 'auto-list-row', 'data-testid': `auto-list-row-${id}` }, [
        el('span', { class: 'auto-list-info' }, [
          el('b', { text: t(`autoList.${id}`) }),
          el('span', { class: 'muted', text: t('common.trackCount', { count: list.length }) }),
        ]),
        el('div', { class: 'auto-list-actions' }, [
          el('button', {
            class: 'btn-pill ghost',
            type: 'button',
            'data-testid': `auto-list-play-${id}`,
            text: t('common.playAll'),
            onclick: () => playList(list),
          }),
          el('button', {
            class: 'btn-pill ghost',
            type: 'button',
            'data-testid': `auto-list-shuffle-${id}`,
            text: t('common.shufflePlay'),
            onclick: () => playShuffled(list),
          }),
          el('button', {
            class: 'btn-pill ghost',
            type: 'button',
            'data-testid': `auto-list-open-${id}`,
            text: t('playlists.open'),
            onclick: () => selectList(id),
          }),
        ]),
      ]);
    });

    return el('section', { class: 'list auto-list-section' }, [
      el('header', {}, [
        el('span', { text: t('autoList.title') }),
        el('span', { text: String(AUTO_LISTS.length) }),
      ]),
      el('ul', { class: 'rows' }, rows),
    ]);
  }

  function autoDetailNode(state) {
    const list = autoListTracks(state, selectedList);
    const rows = list.map((track) =>
      el('li', { class: 'row', 'data-testid': 'track-row' }, [
        el(
          'button',
          {
            class: 'row-hit',
            type: 'button',
            onclick: () => run(store.playQueue(list, track.id)),
          },
          [
            el('span', { class: 'art', 'aria-hidden': 'true' }),
            el('span', { class: 't' }, [
              el('b', { text: track.title }),
              el('span', { text: typeof track.artist === 'string' ? track.artist : '' }),
            ]),
            el('time', { text: formatTime(track.duration) }),
          ],
        ),
      ]),
    );

    const children = [
      el('header', {}, [
        el('span', { text: t(`autoList.${selectedList}`) }),
        el('span', { text: t('common.trackCount', { count: list.length }) }),
      ]),
      el('div', { class: 'playlist-actions' }, [
        el('button', {
          class: 'btn-pill',
          type: 'button',
          'data-testid': 'auto-list-detail-play',
          text: t('common.playAll'),
          onclick: () => playList(list),
        }),
        el('button', {
          class: 'btn-pill ghost',
          type: 'button',
          'data-testid': 'auto-list-detail-shuffle',
          text: t('common.shufflePlay'),
          onclick: () => playShuffled(list),
        }),
      ]),
    ];
    if (rows.length) children.push(el('ul', { class: 'rows' }, rows));
    else {
      children.push(
        el('p', { class: 'muted', 'data-testid': 'auto-list-empty', text: t('autoList.empty') }),
      );
    }

    return el(
      'section',
      { class: 'list auto-list-detail', 'data-testid': 'auto-list-detail' },
      children,
    );
  }

  function detailNode(state, playlist) {
    const counts = playlistCounts(playlist);
    const header = el('header', { class: 'playlist-detail-head' }, [
      el('h2', { text: playlist.name }),
      sourceChip(playlist.source),
      PROXY_SOURCES.has(playlist.source) ? experimentalChip() : null,
      el('span', { class: 'muted', text: t('playlists.counts', counts) }),
    ]);

    const columns = renderColumns(playlist.items, {
      tracks: state.tracks,
      onConfirm: (index) => run(store.confirmPlaylistItem(playlist.id, index)),
      onAssign: (index, trackId) => run(store.assignPlaylistItem(playlist.id, index, trackId)),
    });

    const writable = canWrite(state);
    const copyButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'missing-copy',
      text: t('playlists.copyMissing'),
      onclick: async () => {
        try {
          const text = await store.playlistMissingText(playlist.id);
          const copied = await copyText(String(text ?? '').replace(/\n$/, ''));
          if (!copied) toastFrom(node, t('common.unknownError'));
        } catch (error) {
          reportError(node, error);
        }
      },
    });
    const downloadButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'missing-download',
      text: t('playlists.downloadMissing'),
      onclick: async () => {
        try {
          const text = await store.playlistMissingText(playlist.id);
          downloadText(`${sanitizeFileName(playlist.name)}-missing.txt`, String(text ?? ''));
        } catch (error) {
          reportError(node, error);
        }
      },
    });
    const m3u8Button = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': 'm3u8-write',
      text: t('playlists.m3u8Write'),
      disabled: !writable,
      title: writable ? null : t('playlists.m3u8Unsupported'),
      onclick: async () => {
        if (!writable) return;
        try {
          await store.writePlaylistM3u8(playlist.id);
          toastFrom(node, t('playlists.m3u8Written'));
        } catch (error) {
          reportError(node, error);
        }
      },
    });

    const trackOf = async () => {
      const tracks = await store.playlistTracks(playlist.id);
      if (!tracks.length) {
        toastFrom(node, t('playlists.emptyTracks'));
        return [];
      }
      return tracks;
    };
    const detailPlay = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': 'playlist-detail-play',
      text: t('common.playAll'),
      onclick: async () => {
        try {
          const tracks = await trackOf();
          if (tracks.length) await store.playQueue(tracks, tracks[0].id);
        } catch (error) {
          reportError(node, error);
        }
      },
    });
    const detailShuffle = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlist-detail-shuffle',
      text: t('common.shufflePlay'),
      onclick: async () => {
        try {
          const tracks = await trackOf();
          if (!tracks.length) return;
          const order = shuffled(tracks);
          await store.playQueue(order, order[0].id);
        } catch (error) {
          reportError(node, error);
        }
      },
    });

    return el('section', { class: 'playlist-detail', 'data-testid': 'playlist-detail' }, [
      el('div', { class: 'playlist-actions', 'data-testid': 'playlist-detail-actions' }, [
        detailPlay,
        detailShuffle,
      ]),
      header,
      columns,
      el('div', { class: 'playlist-actions' }, [copyButton, downloadButton, m3u8Button]),
    ]);
  }

  function rowNode(state, playlist) {
    const counts = playlistCounts(playlist);
    const info = el('div', { class: 'playlist-info' }, [
      el('b', { text: playlist.name }),
      sourceChip(playlist.source),
      PROXY_SOURCES.has(playlist.source) ? experimentalChip() : null,
      el('span', { class: 'muted', text: t('playlists.counts', counts) }),
      el('time', { text: new Date(playlist.createdAt).toLocaleString() }),
    ]);

    const trackOf = async () => {
      const tracks = await store.playlistTracks(playlist.id);
      if (!tracks.length) {
        toastFrom(node, t('playlists.emptyTracks'));
        return [];
      }
      return tracks;
    };
    const play = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlist-play',
      text: t('common.playAll'),
      onclick: async () => {
        try {
          const tracks = await trackOf();
          if (tracks.length) await store.playQueue(tracks, tracks[0].id);
        } catch (error) {
          reportError(node, error);
        }
      },
    });
    const shuffle = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlist-shuffle',
      text: t('common.shufflePlay'),
      onclick: async () => {
        try {
          const tracks = await trackOf();
          if (!tracks.length) return;
          const order = shuffled(tracks);
          await store.playQueue(order, order[0].id);
        } catch (error) {
          reportError(node, error);
        }
      },
    });
    const open = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlist-open',
      text: t('playlists.open'),
      onclick: () => select(playlist.id),
    });
    const remove = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'playlist-delete',
      text: t('playlists.delete'),
      onclick: async () => {
        if (typeof window !== 'undefined' && !window.confirm(t('playlists.deleteConfirm'))) return;
        try {
          await store.deletePlaylist(playlist.id);
          if (selectedId === playlist.id) selectedId = null;
        } catch (error) {
          reportError(node, error);
        }
      },
    });

    return el(
      'li',
      { class: 'playlist-row', 'data-testid': 'playlist-row' },
      [info, el('div', { class: 'playlist-row-actions' }, [play, shuffle, open, remove])],
    );
  }

  function paint(state) {
    lastState = state;
    const playlists = Array.isArray(state.playlists) ? state.playlists : [];
    if (selectedId && !playlists.some((playlist) => playlist.id === selectedId)) {
      selectedId = null;
    }
    if (selectedList && !AUTO_LISTS.includes(selectedList)) selectedList = null;

    const children = [playlistSection(state, playlists)];
    const selected = playlists.find((playlist) => playlist.id === selectedId);
    if (selected) children.push(detailNode(state, selected));
    children.push(autoSection(state));
    if (selectedList) children.push(autoDetailNode(state));
    node.replaceChildren(...children);
  }

  return {
    node,
    render(state) {
      paint(state);
    },
  };
}

export function createImportDialog(store) {
  let order = 'auto';
  let result = null;
  let busy = false;
  let keydownBound = false;

  const nameInput = el('input', {
    id: 'import-name',
    class: 'text-input',
    type: 'text',
    autocomplete: 'off',
    'data-testid': 'import-name',
    placeholder: t('playlists.untitled'),
  });
  const textInput = el('textarea', {
    id: 'import-text',
    class: 'text-input',
    rows: '6',
    'data-testid': 'import-text',
    'aria-label': t('import.placeholderText'),
    placeholder: t('import.placeholderText'),
  });
  const urlInput = el('input', {
    id: 'import-url',
    class: 'text-input',
    type: 'url',
    autocomplete: 'off',
    'data-testid': 'import-url',
    'aria-label': t('import.placeholderUrl'),
    placeholder: t('import.placeholderUrl'),
  });

  const errorNode = el('p', {
    class: 'import-error',
    role: 'alert',
    'data-testid': 'import-error',
    hidden: true,
  });
  const resultHost = el('div', {
    class: 'import-result',
    'data-testid': 'import-result',
    hidden: true,
  });

  const orderButtons = [
    { value: 'auto', key: 'import.orderAuto' },
    { value: 'artist-title', key: 'import.orderArtistTitle' },
    { value: 'title-artist', key: 'import.orderTitleArtist' },
  ].map(({ value, key }) => {
    const button = el('button', {
      class: 'segment',
      type: 'button',
      'aria-pressed': 'false',
      'data-testid': `import-order-${value}`,
      text: t(key),
      onclick: () => {
        order = value;
        syncOrder();
      },
    });
    button.dataset.value = value;
    return button;
  });

  function syncOrder() {
    for (const button of orderButtons) {
      const active = button.dataset.value === order;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }
  }
  syncOrder();

  const submitButton = el('button', {
    class: 'btn-pill',
    type: 'button',
    'data-testid': 'import-submit',
    text: t('import.submit'),
    onclick: () => run(submit()),
  });
  const closeButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    'data-testid': 'import-close',
    text: t('import.close'),
    onclick: () => close(),
  });

  function showError(message) {
    setText(errorNode, message);
    setHidden(errorNode, false);
  }

  function clearError() {
    setText(errorNode, '');
    setHidden(errorNode, true);
  }

  function confirmDraft(index) {
    if (!result?.items?.[index]) return;
    result.items[index] = { ...result.items[index], status: 'matched', reasons: [] };
    renderResult();
  }

  function assignDraft(index, trackId) {
    if (!result?.items?.[index]) return;
    result.items[index] = {
      ...result.items[index],
      matchedTrackId: trackId,
      status: 'matched',
      reasons: [],
    };
    renderResult();
  }

  function renderResult() {
    if (!result) {
      setHidden(resultHost, true);
      return;
    }
    const counts = playlistCounts(result);
    const head = el('div', { class: 'playlist-detail-head' }, [
      el('h3', { text: result.name }),
      sourceChip(result.source),
      PROXY_SOURCES.has(result.source) ? experimentalChip() : null,
      el('span', { class: 'muted', text: t('playlists.counts', counts) }),
    ]);

    const truncated =
      result.source === 'spotify' && (result.truncated === true || result.items.length >= 100);
    const note = truncated
      ? el('p', {
          class: 'muted',
          'data-testid': 'import-truncated',
          text: t('import.spotifyTruncated'),
        })
      : null;

    const columns = renderColumns(result.items, {
      tracks: store.state.tracks,
      onConfirm: confirmDraft,
      onAssign: assignDraft,
    });

    const copyButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'missing-copy',
      text: t('playlists.copyMissing'),
      onclick: async () => {
        const copied = await copyText(missingText(result).replace(/\n$/, ''));
        if (!copied) toastFrom(node, t('common.unknownError'));
      },
    });
    const downloadButton = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'missing-download',
      text: t('playlists.downloadMissing'),
      onclick: () => {
        downloadText(`${sanitizeFileName(result.name)}-missing.txt`, missingText(result));
      },
    });
    const m3u8Button = el('button', {
      class: 'btn-pill ghost',
      type: 'button',
      'data-testid': 'm3u8-download',
      text: t('import.m3u8Download'),
      onclick: () => {
        downloadText(
          `${sanitizeFileName(result.name)}.m3u8`,
          m3u8Text({ ...result, id: result.id ?? 'draft' }, store.state.tracks),
        );
      },
    });
    const createButton = el('button', {
      class: 'btn-pill',
      type: 'button',
      'data-testid': 'playlist-create',
      text: t('import.create'),
      onclick: () => run(create()),
    });

    const children = [head];
    if (note) children.push(note);
    children.push(columns);
    children.push(
      el('div', { class: 'import-actions' }, [
        copyButton,
        downloadButton,
        m3u8Button,
        createButton,
      ]),
    );
    resultHost.replaceChildren(...children);
    setHidden(resultHost, false);
  }

  async function create() {
    if (!result) return;
    try {
      await store.createPlaylist({
        name: result.name,
        source: result.source,
        sourceUrl: result.sourceUrl,
        items: result.items,
      });
      close();
      store.setView('playlists');
      toastFrom(node, t('playlists.created'));
    } catch (error) {
      showError(error?.message ? String(error.message) : t('common.unknownError'));
    }
  }

  function normalizeItems(items, matches) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
      const match = matches[index] ?? { status: 'missing', trackId: null, reasons: [] };
      const duration = Number(item?.durationMs);
      return {
        title: typeof item?.title === 'string' ? item.title : '',
        artist: typeof item?.artist === 'string' ? item.artist : '',
        durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
        matchedTrackId: typeof match.trackId === 'string' ? match.trackId : null,
        status: match.status === 'matched' || match.status === 'suspect' ? match.status : 'missing',
        reasons: Array.isArray(match.reasons) ? match.reasons : [],
        coverUrl: typeof item?.coverUrl === 'string' && item.coverUrl !== '' ? item.coverUrl : null,
      };
    });
  }

  async function submit() {
    if (busy) return;
    busy = true;
    submitButton.disabled = true;
    clearError();
    try {
      const url = urlInput.value.trim();
      const fallbackName = nameInput.value.trim();
      let name = fallbackName;
      let source = 'text';
      let sourceUrl = null;
      let items = [];
      let truncated = false;

      if (url !== '') {
        if (isYouTubeUrl(url)) {
          const data = await resolveYouTubePlaylist({
            url,
            apiKey: store.state.settings.youtubeApiKey,
          });
          source = 'youtube';
          sourceUrl = url;
          items = data.items;
          truncated = data.truncated === true;
          if (name === '') name = data.name;
        } else {
          const platform = platformOfUrl(url);
          if (!platform) throw new Error(t('playlists.error.unsupportedUrl'));
          const data = await resolveViaProxy({
            url,
            proxyBase: store.state.settings.playlistProxyUrl,
          });
          source = platform;
          sourceUrl = url;
          items = data.items;
          truncated = data.truncated === true;
          if (name === '') name = data.name;
        }
      } else {
        const parsed = parsePlaylistText(textInput.value, {
          order: order === 'auto' ? undefined : order,
          knownArtists: store.state.tracks.map((track) => track.artist).filter(Boolean),
        });
        items = parsed.items;
        if (!items.length) throw new Error(t('playlists.error.emptyText'));
      }

      const matches = await matchPlaylist(items, store.state.tracks);
      result = {
        name: name === '' ? t('playlists.untitled') : name,
        source,
        sourceUrl,
        truncated,
        items: normalizeItems(items, matches),
      };
      renderResult();
    } catch (error) {
      showError(error?.message ? String(error.message) : t('common.unknownError'));
    } finally {
      busy = false;
      submitButton.disabled = false;
    }
  }

  const orderRow = el('div', { class: 'segmented', role: 'group', 'aria-label': t('import.order') }, orderButtons);

  const panel = el('div', { class: 'import-dialog' }, [
    el('header', { class: 'modal-head' }, [
      el('h2', { text: t('import.title') }),
      closeButton,
    ]),
    el('div', { class: 'import-grid' }, [
      el('label', { for: 'import-name', text: t('import.name') }),
      nameInput,
      textInput,
      urlInput,
      el('span', { class: 'import-order-label', text: t('import.order') }),
      orderRow,
    ]),
    errorNode,
    el('div', { class: 'import-actions' }, [submitButton]),
    resultHost,
  ]);

  const node = el(
    'div',
    {
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('import.title'),
      'data-testid': 'import-dialog',
      hidden: true,
    },
    panel,
  );

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  function open() {
    setHidden(node, false);
    if (!keydownBound) {
      document.addEventListener('keydown', onKeydown);
      keydownBound = true;
    }
    nameInput.focus();
  }

  function close() {
    setHidden(node, true);
    if (keydownBound) {
      document.removeEventListener('keydown', onKeydown);
      keydownBound = false;
    }
    result = null;
    setHidden(resultHost, true);
    resultHost.replaceChildren();
    nameInput.value = '';
    textInput.value = '';
    urlInput.value = '';
    clearError();
  }

  node.addEventListener('click', (event) => {
    if (event.target === node) close();
  });

  return { node, open, close };
}
