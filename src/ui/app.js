/**
 * Full page UI for LocalTune. Renders once, then patches the persistent shell
 * on every store change (coalesced into one requestAnimationFrame). Only the
 * active view is rebuilt, and only when its inputs change, so a 4 Hz
 * timeupdate does not recreate a thousand-row library.
 */

import { groupByAlbum, groupByArtist, formatTime } from '../core/selectors.js';
import { groupByFolder } from '../core/folders.js';
import { el, icon, coverUrl, syncCoverCache, setText, setHidden } from './dom.js';

const TABS = [
  { id: 'tracks', label: '歌曲' },
  { id: 'albums', label: '专辑' },
  { id: 'artists', label: '歌手' },
  { id: 'folders', label: '文件夹' },
  { id: 'queue', label: '队列' },
];

const REPEAT_LABEL = { off: '循环：关闭', all: '循环：列表', one: '循环：单曲' };
const REPEAT_BADGE = { off: '', all: '∞', one: '1' };
const SEEK_STEP = 5;

function run(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function subtitleOf(track) {
  const parts = [track.artist, track.album];
  if (Number.isFinite(track.year) && track.year > 0) parts.push(String(track.year));
  return parts.filter(Boolean).join(' · ');
}

function artNode(cover, className = 'art') {
  const node = el('span', { class: className, 'aria-hidden': 'true' });
  const url = coverUrl(cover);
  if (url) node.style.backgroundImage = `url("${url}")`;
  return node;
}

function emptyState({ title, text, actionLabel, onAction }) {
  const children = [el('h2', { text: title }), el('p', { text })];
  if (actionLabel) {
    children.push(
      el('button', { class: 'btn-pill', type: 'button', text: actionLabel, onclick: onAction }),
    );
  }
  return el('section', { class: 'card empty' }, children);
}

function trackRow(track, { now, onActivate }) {
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': `播放 ${track.title}`,
      onclick: onActivate,
    },
    [
      artNode(track.cover),
      el('span', { class: 't' }, [
        el('b', { text: track.title }),
        el('span', { text: subtitleOf(track) }),
      ]),
      el('time', { text: formatTime(track.duration) }),
    ],
  );
  return el('li', { class: now ? 'row now' : 'row' }, hit);
}

function queueRow(track, index, { now, onActivate, onRemove }) {
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': `播放队列第 ${index + 1} 首 ${track.title}`,
      onclick: onActivate,
    },
    [
      el('span', { class: 'n', text: String(index + 1).padStart(2, '0') }),
      artNode(track.cover),
      el('span', { class: 't' }, [
        el('b', { text: track.title }),
        el('span', { text: subtitleOf(track) }),
      ]),
      el('time', { text: formatTime(track.duration) }),
    ],
  );
  const remove = el('button', {
    class: 'row-x',
    type: 'button',
    text: '×',
    'aria-label': `从队列移除 ${track.title}`,
    onclick: onRemove,
  });
  return el('li', { class: now ? 'row queue now' : 'row queue' }, [hit, remove]);
}

function folderRow(group, { onPlay, onEnqueue }) {
  const label = group.dir || '根目录';
  const hit = el(
    'button',
    {
      class: 'row-hit',
      type: 'button',
      'aria-label': `播放文件夹 ${label}`,
      onclick: onPlay,
    },
    [
      artNode(null),
      el('span', { class: 't' }, [
        el('b', { text: label }),
        el('span', { text: `${group.count} 首` }),
      ]),
    ],
  );
  const add = el('button', {
    class: 'row-add',
    type: 'button',
    text: '加入队列',
    'aria-label': `把文件夹 ${label} 加入队列`,
    onclick: onEnqueue,
  });
  return el('li', { class: 'row' }, [hit, add]);
}

function listSection(headerLabel, countLabel, rows) {
  return el('section', { class: 'list' }, [
    el('header', {}, [
      el('span', { text: headerLabel }),
      el('span', { text: countLabel }),
    ]),
    el('ul', { class: 'rows' }, rows),
  ]);
}

function cardItem({ title, meta, cover, label, onPlay }) {
  return el('li', {}, [
    el(
      'button',
      { class: 'card-item', type: 'button', 'aria-label': label, onclick: onPlay },
      [
        artNode(cover, 'art'),
        el('b', { text: title }),
        el('span', { class: 'card-meta', text: meta }),
      ],
    ),
  ]);
}

function createShell(store) {
  const status = el('span', { class: 'status', id: 'status', text: '准备就绪' });
  const count = el('span', { class: 'count', text: '0 首' });
  const sourceName = el('span', { class: 'source-name', text: '未连接' });
  const authButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    text: '选择音乐文件夹',
    onclick: () => run(store.connectSource()),
  });
  const deniedHint = el('p', {
    class: 'alert',
    role: 'status',
    text: '浏览器已阻止目录访问，请在浏览器设置的网站权限中恢复后再试。',
  });
  const scanBar = el('i');
  const scan = el('div', { class: 'scan', role: 'status' }, [
    el('span', { class: 'scan-label', text: '扫描中' }),
    el('div', { class: 'bar' }, scanBar),
  ]);
  const errorBox = el('p', { class: 'alert', role: 'alert' });

  const header = el('header', { class: 'top' }, [
    el('div', { class: 'brand' }, [el('h1', { text: 'LocalTune' }), status]),
    el('div', { class: 'top-right' }, [count, sourceName, authButton]),
  ]);

  // ---- player card ----
  const label = el('div', { class: 'label' });
  const vinyl = el('div', { class: 'vinyl', 'aria-hidden': 'true' }, label);
  const tonearm = el('div', { class: 'tonearm', 'aria-hidden': 'true' }, [
    el('span', { class: 'head' }),
  ]);
  const deck = el('div', { class: 'deck' }, [vinyl, tonearm]);
  const stage = el('div', { class: 'stage' }, deck);

  const title = el('h2', { text: '未选择曲目' });
  const subtitle = el('p', { text: '从下方列表选一首开始' });
  const meta = el('div', { class: 'meta' }, [title, subtitle]);

  const elapsed = el('time', { text: '0:00' });
  const total = el('time', { text: '0:00' });
  const barFill = el('i');
  const bar = el('div', {
    class: 'bar',
    role: 'slider',
    tabindex: '0',
    'aria-label': '播放进度',
    'aria-valuemin': '0',
    'aria-valuemax': '0',
    'aria-valuenow': '0',
    'aria-valuetext': '0:00',
    'aria-disabled': 'true',
  }, barFill);
  const progress = el('div', { class: 'progress' }, [elapsed, bar, total]);

  const playIcon = icon('play');
  const pauseIcon = icon('pause');
  setHidden(pauseIcon, true);
  const shuffleButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': '随机播放', 'aria-pressed': 'false', onclick: () => store.toggleShuffle() },
    icon('shuffle'),
  );
  const prevButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': '上一首', onclick: () => run(store.prev()) },
    icon('prev'),
  );
  const playButton = el(
    'button',
    { class: 'btn main', type: 'button', 'aria-label': '播放', onclick: () => store.toggle() },
    [playIcon, pauseIcon],
  );
  const nextButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': '下一首', onclick: () => run(store.next()) },
    icon('next'),
  );
  const repeatBadge = el('span', { class: 'badge', 'aria-hidden': 'true' });
  const repeatButton = el(
    'button',
    { class: 'btn', type: 'button', 'aria-label': '循环：关闭', onclick: () => store.cycleRepeat() },
    [icon('repeat'), repeatBadge],
  );
  const controls = el('div', { class: 'controls' }, [
    shuffleButton,
    prevButton,
    playButton,
    nextButton,
    repeatButton,
  ]);

  const player = el('section', { class: 'card player', 'aria-label': '正在播放' }, [
    stage,
    meta,
    progress,
    controls,
  ]);

  // ---- settings ----
  const spinToggle = el('input', {
    class: 'toggle',
    type: 'checkbox',
    id: 'vinyl-spin',
    checked: true,
    onchange: () => store.setSetting('vinylSpin', spinToggle.checked),
  });
  const rescanButton = el('button', {
    class: 'btn-pill ghost',
    type: 'button',
    text: '重新扫描',
    onclick: () => run(store.rescan()),
  });
  const settings = el('section', { class: 'card settings', 'aria-label': '设置' }, [
    el('label', { class: 'option', for: 'vinyl-spin' }, [
      spinToggle,
      el('span', { text: '唱片旋转' }),
    ]),
    rescanButton,
  ]);

  // ---- library ----
  const tabButtons = TABS.map(({ id, label: text }) =>
    el('button', {
      id: `tab-${id}`,
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      'aria-controls': 'view-panel',
      text,
      onclick: () => store.setView(id),
    }),
  );
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': '资料库视图' }, tabButtons);
  const panel = el('div', { id: 'view-panel', role: 'tabpanel', tabindex: '-1' });
  const library = el('section', { class: 'library', 'aria-label': '资料库' }, [tabs, panel]);

  const updateBanner = el('div', { class: 'update-banner', role: 'status', hidden: true }, [
    el('span', { text: '有新版本，刷新以更新。' }),
    el('button', {
      class: 'btn-pill',
      type: 'button',
      text: '刷新',
      onclick: () => location.reload(),
    }),
  ]);

  const app = el('div', { class: 'app' }, [
    header,
    errorBox,
    scan,
    deniedHint,
    el('main', { class: 'layout' }, [
      el('div', { class: 'player-col' }, [player, settings]),
      library,
    ]),
    updateBanner,
  ]);

  return {
    app,
    status,
    count,
    sourceName,
    authButton,
    deniedHint,
    scan,
    scanBar,
    errorBox,
    player,
    label,
    title,
    subtitle,
    elapsed,
    total,
    bar,
    barFill,
    playIcon,
    pauseIcon,
    playButton,
    shuffleButton,
    repeatButton,
    repeatBadge,
    spinToggle,
    rescanButton,
    tabButtons,
    panel,
    updateBanner,
  };
}

export function mountUi(root, store) {
  const ui = createShell(store);

  const last = {
    view: null,
    tracks: null,
    currentId: null,
    queueTracks: null,
    queueIndex: -1,
    cover: undefined,
  };

  function renderHeader(state) {
    const { source } = state;
    if (source.scanning) {
      const { done, total } = source.progress ?? { done: 0, total: 0 };
      setText(ui.status, total > 0 ? `扫描中 ${done} / ${total}` : `扫描中 ${done}`);
    } else {
      setText(ui.status, state.ready ? '准备就绪' : '正在载入…');
    }

    setText(ui.count, `${state.tracks.length} 首`);
    const permission = source.permission;
    setText(
      ui.sourceName,
      permission === 'granted'
        ? source.name || '已连接'
        : permission === 'prompt'
          ? '等待授权'
          : permission === 'denied'
            ? '权限被拒绝'
            : '未连接',
    );
    setHidden(ui.authButton, permission === 'granted');
    setText(ui.authButton, permission === 'none' ? '选择音乐文件夹' : '重新授权');
    setHidden(ui.deniedHint, permission !== 'denied');

    setHidden(ui.scan, !source.scanning);
    if (source.scanning) {
      const { done, total } = source.progress ?? { done: 0, total: 0 };
      const ratio = total > 0 ? Math.min(done / total, 1) : 0.12;
      ui.scanBar.style.width = `${Math.round(ratio * 100)}%`;
    }

    const error = source.error;
    setHidden(ui.errorBox, !error);
    if (error) setText(ui.errorBox, typeof error === 'string' ? error : error.message ?? String(error));
  }

  function renderPlayer(state) {
    const { current, queue } = state;
    const track = current.track;
    const duration = current.duration || track?.duration || 0;
    const position = Math.min(Math.max(current.position || 0, 0), duration || 0);
    const playing = Boolean(track) && current.playing;

    ui.player.classList.toggle('playing', playing);
    ui.player.classList.toggle('no-spin', state.settings.vinylSpin === false);

    const cover = track?.cover ?? null;
    if (cover !== last.cover) {
      const url = coverUrl(cover);
      ui.label.style.backgroundImage = url ? `url("${url}")` : '';
      last.cover = cover;
    }

    setText(ui.title, track ? track.title : '未选择曲目');
    setText(ui.subtitle, track ? subtitleOf(track) : '从下方列表选一首开始');

    setText(ui.elapsed, formatTime(position));
    setText(ui.total, formatTime(duration));
    const ratio = duration > 0 ? Math.min(position / duration, 1) : 0;
    ui.barFill.style.width = `${(ratio * 100).toFixed(2)}%`;

    ui.bar.setAttribute('aria-valuemax', String(Math.round(duration)));
    ui.bar.setAttribute('aria-valuenow', String(Math.round(position)));
    ui.bar.setAttribute('aria-valuetext', `${formatTime(position)} / ${formatTime(duration)}`);
    ui.bar.setAttribute('aria-disabled', String(!track || duration <= 0));

    const label = playing ? '暂停' : '播放';
    if (ui.playButton.getAttribute('aria-label') !== label) {
      ui.playButton.setAttribute('aria-label', label);
    }
    setHidden(ui.playIcon, playing);
    setHidden(ui.pauseIcon, !playing);
    ui.playButton.disabled = !track || state.source.permission !== 'granted';

    ui.shuffleButton.classList.toggle('is-on', queue.shuffle);
    ui.shuffleButton.setAttribute('aria-pressed', String(queue.shuffle));

    ui.repeatButton.classList.toggle('is-on', queue.repeat !== 'off');
    ui.repeatButton.setAttribute('aria-label', REPEAT_LABEL[queue.repeat] ?? REPEAT_LABEL.off);
    setText(ui.repeatBadge, REPEAT_BADGE[queue.repeat] ?? '');
  }

  function renderSettings(state) {
    ui.spinToggle.checked = state.settings.vinylSpin !== false;
    ui.rescanButton.disabled = state.source.scanning || state.source.permission === 'none';
  }

  function renderTabs(state) {
    ui.tabButtons.forEach((button, index) => {
      const selected = TABS[index].id === state.view;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('is-active', selected);
    });
    ui.panel.setAttribute('aria-labelledby', `tab-${state.view}`);
  }

  function renderEmpty(state) {
    const permission = state.source.permission;
    if (permission !== 'granted') {
      if (permission === 'denied') {
        return emptyState({
          title: '无法访问音乐文件夹',
          text: '浏览器已阻止访问。请在浏览器设置的网站权限中恢复文件夹读取权限，然后重新授权。',
          actionLabel: '重新授权',
          onAction: () => run(store.connectSource()),
        });
      }
      return emptyState({
        title: '先选择你的音乐文件夹',
        text: 'LocalTune 只在本机读取你授权的文件夹，不上传、不联网。支持 mp3、m4a、flac、ogg、wav、webm。',
        actionLabel: permission === 'none' ? '选择音乐文件夹' : '重新授权',
        onAction: () => run(store.connectSource()),
      });
    }
    return emptyState({
      title: '这个文件夹里还没有音乐',
      text: '确认文件夹里包含音频文件后重新扫描。',
      actionLabel: '重新扫描',
      onAction: () => run(store.rescan()),
    });
  }

  function renderView(state) {
    const currentId = state.current.track?.id ?? null;
    const queueView = state.view === 'queue';
    const rebuild =
      state.view !== last.view ||
      state.tracks !== last.tracks ||
      currentId !== last.currentId ||
      (queueView &&
        (state.queue.tracks !== last.queueTracks || state.queue.index !== last.queueIndex));

    if (!rebuild) return;

    last.view = state.view;
    last.tracks = state.tracks;
    last.currentId = currentId;
    last.queueTracks = state.queue.tracks;
    last.queueIndex = state.queue.index;

    syncCoverCache(state.tracks.map((track) => track.cover).filter(Boolean));

    if (state.source.permission !== 'granted') {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    if (!state.tracks.length) {
      ui.panel.replaceChildren(renderEmpty(state));
      return;
    }

    if (state.view === 'albums') {
      const groups = groupByAlbum(state.tracks);
      const cards = groups.map((group) =>
        cardItem({
          title: group.name || '未知专辑',
          meta: `${group.artist || '未知歌手'} · ${group.tracks.length} 首`,
          cover: group.cover,
          label: `播放专辑 ${group.name || '未知专辑'}`,
          onPlay: () => run(store.playQueue(group.tracks, group.tracks[0]?.id)),
        }),
      );
      ui.panel.replaceChildren(
        el('section', { class: 'list' }, [
          el('header', {}, [
            el('span', { text: '专辑' }),
            el('span', { text: `${groups.length} 张` }),
          ]),
          el('ul', { class: 'grid' }, cards),
        ]),
      );
      return;
    }

    if (state.view === 'artists') {
      const groups = groupByArtist(state.tracks);
      const cards = groups.map((group) =>
        cardItem({
          title: group.name || '未知歌手',
          meta: `${group.tracks.length} 首`,
          cover: group.cover,
          label: `播放歌手 ${group.name || '未知歌手'}`,
          onPlay: () => run(store.playQueue(group.tracks, group.tracks[0]?.id)),
        }),
      );
      ui.panel.replaceChildren(
        el('section', { class: 'list' }, [
          el('header', {}, [
            el('span', { text: '歌手' }),
            el('span', { text: `${groups.length} 位` }),
          ]),
          el('ul', { class: 'grid' }, cards),
        ]),
      );
      return;
    }

    if (state.view === 'folders') {
      const groups = groupByFolder(state.tracks);
      const byId = new Map(state.tracks.map((track) => [track.id, track]));
      const rows = groups.map((group) => {
        const list = group.trackIds.map((id) => byId.get(id)).filter(Boolean);
        return folderRow(group, {
          onPlay: () => run(store.playQueue(list, list[0]?.id)),
          onEnqueue: () => store.appendQueue(list),
        });
      });
      ui.panel.replaceChildren(listSection('文件夹', `${groups.length} 个`, rows));
      return;
    }

    if (queueView) {
      const tracks = state.queue.tracks;
      if (!tracks.length) {
        ui.panel.replaceChildren(
          emptyState({
            title: '队列是空的',
            text: '在「歌曲」里点一首，或者从专辑、歌手开始播放。',
            actionLabel: '去歌曲',
            onAction: () => store.setView('tracks'),
          }),
        );
        return;
      }
      const rows = tracks.map((track, index) =>
        queueRow(track, index, {
          now: index === state.queue.index,
          onActivate: () => run(store.jumpTo(index)),
          onRemove: () => store.removeQueueAt(index),
        }),
      );
      ui.panel.replaceChildren(listSection('播放队列', `${tracks.length} 首`, rows));
      return;
    }

    const rows = state.tracks.map((track) =>
      trackRow(track, {
        now: track.id === currentId,
        onActivate: () => run(store.playTrack(track.id)),
      }),
    );
    ui.panel.replaceChildren(listSection('全部歌曲', `${state.tracks.length} 首`, rows));
  }

  function render(state) {
    renderHeader(state);
    renderPlayer(state);
    renderSettings(state);
    renderTabs(state);
    renderView(state);
    setHidden(ui.updateBanner, !state.updateReady);
  }

  // Seeking: pointer position → seconds; keyboard for the slider role.
  function seekFromPointer(event) {
    const duration = store.state.current.duration || store.state.current.track?.duration || 0;
    if (duration <= 0) return;
    const rect = ui.bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    run(store.seek(ratio * duration));
  }

  ui.bar.addEventListener('click', seekFromPointer);
  ui.bar.addEventListener('keydown', (event) => {
    const duration = store.state.current.duration || store.state.current.track?.duration || 0;
    if (duration <= 0) return;
    const position = store.state.current.position || 0;
    let target = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = position + SEEK_STEP;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = position - SEEK_STEP;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = duration;
    if (target == null) return;
    event.preventDefault();
    run(store.seek(Math.min(Math.max(target, 0), duration)));
  });

  root.replaceChildren(ui.app);
  render(store.state);

  let frame = 0;
  store.addEventListener('change', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render(store.state);
    });
  });
}
