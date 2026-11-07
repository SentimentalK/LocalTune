/**
 * Background chalk annotations. Three hand-drawn notes on the deck point at the
 * three gestures the player has: tap the arm base to play or pause, drag the
 * arm head to seek, swipe the stage sideways to skip.
 *
 * The layer is decoration only. It paints above the tonearm, but it is
 * `pointer-events: none` and `aria-hidden`, so every tap, drag and swipe still
 * reaches the control underneath. Nothing here reacts to input or to playback.
 *
 * Every coordinate is a deck user unit (640 x 550), so the drawing follows the
 * deck's CSS size on its own. The anchors that depend on layout (the arm base,
 * the arm head, the record, the title widths) are measured from the live DOM,
 * which keeps an arrow tip exactly 8 px off its target at any window size.
 * Resizing only updates `d`/`cx`/`cy`; the nodes are built once.
 */

import en from '../i18n/en.js';
import zhCN from '../i18n/zh-CN.js';
import { t } from '../i18n/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 640;
const VIEW_H = 550;
const GAP_PX = 8;
const TIP_R = 0.5;
const INK = '#F2F5F3';
const TITLE_INK = '#F2D9A0';
const BODY_INK = '#EDF2EF';

const VARIANTS = ['A', 'B', 'C'];

/** `?chalk=A|B|C`, defaulting to A. */
export function chalkVariant(search = globalThis.location?.search ?? '') {
  const picked = (new URLSearchParams(search).get('chalk') ?? '').toUpperCase();
  return VARIANTS.includes(picked) ? picked : 'A';
}

const rad = (deg) => (deg * Math.PI) / 180;
const round2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(round2(value));
const pt = (spot) => `${fmt(spot.x)} ${fmt(spot.y)}`;
const normalize = (vector) => {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
};

function make(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** Deterministic wobble, so the same pass draws the same chalk every time. */
function seeded(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * One spring lead-in: `turns` laps of `radius` around a centre travelling
 * `advance` along `angle` (screen degrees, y down). The pen starts on the far
 * side of the centre and leaves along `angle`, so the arrow can pick it up.
 */
export function coilPath({ x, y, radius = 10, advance = 40, turns = 1.5, angle = -25, seed = 1 }) {
  const rand = seeded(seed);
  const direction = { x: Math.cos(rad(angle)), y: Math.sin(rad(angle)) };
  const normal = { x: direction.y, y: -direction.x };
  const center = { x: x - radius * normal.x, y: y - radius * normal.y };
  const total = turns * Math.PI * 2;
  const steps = Math.max(16, Math.ceil(turns * 20));
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const at = index / steps;
    const phi = Math.PI / 2 + total * at;
    const travel = advance * at;
    const wobble = index === 0 || index === steps ? 0 : (rand() * 2 - 1) * 0.4;
    const turn = radius * Math.cos(phi);
    const lift = radius * Math.sin(phi);
    points.push({
      x: center.x + direction.x * travel + direction.x * turn + normal.x * lift + wobble,
      y: center.y + direction.y * travel + direction.y * turn + normal.y * lift + wobble * 0.5,
    });
  }
  const d = points.map((spot, index) => `${index === 0 ? 'M' : 'L'}${pt(spot)}`).join('');
  const bbox = points.reduce(
    (box, spot) => ({
      x0: Math.min(box.x0, spot.x),
      y0: Math.min(box.y0, spot.y),
      x1: Math.max(box.x1, spot.x),
      y1: Math.max(box.y1, spot.y),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  return { d, end: points[points.length - 1], direction, bbox };
}

const cubicAt = (p0, c1, c2, p3, at) => {
  const m = 1 - at;
  return {
    x: m ** 3 * p0.x + 3 * m * m * at * c1.x + 3 * m * at * at * c2.x + at ** 3 * p3.x,
    y: m ** 3 * p0.y + 3 * m * m * at * c1.y + 3 * m * at * at * c2.y + at ** 3 * p3.y,
  };
};

/** Lowest point of a cubic: keeps the arrow off the deck's top edge. */
function cubicMinY(p0, c1, c2, p3) {
  let min = Infinity;
  for (let index = 0; index <= 80; index += 1) {
    min = Math.min(min, cubicAt(p0, c1, c2, p3, index / 80).y);
  }
  return min;
}

/** Tip plus two bowed wings trailing behind `direction`. */
function arrowHead(tip, direction, { length = 11, spread = 26, bow = 1.3 } = {}) {
  const unit = normalize(direction);
  return [1, -1]
    .map((sign) => {
      const angle = rad(spread * sign);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const wing = {
        x: tip.x - length * (unit.x * cos - unit.y * sin),
        y: tip.y - length * (unit.x * sin + unit.y * cos),
      };
      const middle = { x: (wing.x + tip.x) / 2, y: (wing.y + tip.y) / 2 };
      const control = { x: middle.x - unit.y * bow * sign, y: middle.y + unit.x * bow * sign };
      return `M${pt(wing)}Q${pt(control)} ${pt(tip)}`;
    })
    .join(' ');
}

/** Hand-wobbled wave under a title: three periods, two units of amplitude. */
function wavePath({ from, to, y, amplitude = 2, turns = 3, seed = 3 }) {
  const rand = seeded(seed);
  const steps = 90;
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const at = index / steps;
    const wobble = index === 0 || index === steps ? 0 : (rand() * 2 - 1) * 0.6;
    points.push({
      x: from + (to - from) * at,
      y: y + amplitude * Math.sin(at * Math.PI * 2 * turns) + wobble,
    });
  }
  return points.map((spot, index) => `${index === 0 ? 'M' : 'L'}${pt(spot)}`).join('');
}

/**
 * Mounts the chalk layer into a deck and returns its handle. `layout()` forces
 * a remeasure; `destroy()` drops the observer and the nodes.
 */
export function mountChalkLayer(deck) {
  if (!deck || typeof deck.getBoundingClientRect !== 'function') return { layout() {}, destroy() {} };

  const variant = chalkVariant();
  // A is the English sheet, C the Simplified Chinese one; B follows the UI
  // locale, like every other caption in the shell.
  const copy = variant === 'A' ? en : variant === 'C' ? zhCN : null;
  const label = (key) => (copy ? copy[key] : t(key));

  let ids = 0;
  const nextId = (prefix) => `chalk-${prefix}-${(ids += 1)}`;

  /** A stroked line plus its offset chalk ghost. Returns the live path. */
  function stroke(parent, { width = 2.4, dash = null } = {}) {
    const inkId = nextId('ink');
    const shared = {
      fill: 'none',
      stroke: INK,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    };
    if (dash) shared['stroke-dasharray'] = dash;
    const ghost = make(
      'g',
      { class: 'chalk-ghost', opacity: 0.35, transform: 'translate(1.5 1.5)', 'stroke-width': 1.2 },
      [make('use', { href: `#${inkId}` })],
    );
    const path = make('path', { id: inkId, 'vector-effect': 'non-scaling-stroke' });
    parent.append(ghost, make('g', { ...shared, 'stroke-width': width }, [path]));
    return path;
  }

  function createTitle({ size, words, rotations = [] }) {
    const groupId = nextId('title');
    const main = make('g', { class: 'chalk-title', id: groupId, 'font-size': size });
    const texts = words.map((word) => {
      const node = make('text', { x: 0, y: 0, fill: TITLE_INK });
      node.textContent = word;
      main.append(node);
      return node;
    });
    const shadow = make('g', { class: 'chalk-shadow', opacity: 0.18, transform: 'translate(.8 .8)' }, [
      make('use', { href: `#${groupId}` }),
    ]);
    return { wrap: make('g', {}, [shadow, main]), main, texts, rotations };
  }

  /** Places a title's words and returns its measured extent. */
  function placeTitle(block, { x, y, anchor = 'start', gap = 9 }) {
    if (anchor === 'end') {
      block.main.setAttribute('text-anchor', 'end');
      const node = block.texts[0];
      node.setAttribute('x', fmt(x));
      node.setAttribute('y', fmt(y));
      const width = node.getComputedTextLength();
      const angle = block.rotations[0] ?? 0;
      if (angle) node.setAttribute('transform', `rotate(${angle} ${fmt(x - width / 2)} ${fmt(y)})`);
      return { left: x - width, right: x, width };
    }
    let cursor = x;
    block.texts.forEach((node, index) => {
      node.setAttribute('x', fmt(cursor));
      node.setAttribute('y', fmt(y));
      const width = node.getComputedTextLength();
      const angle = block.rotations[index] ?? 0;
      if (angle) {
        node.setAttribute('transform', `rotate(${angle} ${fmt(cursor + width / 2)} ${fmt(y)})`);
      } else {
        node.removeAttribute('transform');
      }
      cursor += width + (index < block.texts.length - 1 ? gap : 0);
    });
    return { left: x, right: cursor, width: cursor - x };
  }

  function createBody(entries, { x, anchor = 'start' }) {
    const wrap = make('g', { class: 'chalk-body' });
    const nodes = entries.map(({ key, baseline }) => {
      const node = make('text', {
        x: fmt(x),
        y: fmt(baseline),
        fill: BODY_INK,
        'font-size': 17,
        'text-anchor': anchor,
      });
      node.textContent = label(key);
      wrap.append(node);
      return { node, baseline };
    });
    return { wrap, nodes, x };
  }

  const layer = make('svg', {
    class: 'chalk-layer',
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  // ── 1. play / pause, anchored on the arm base ──────────────
  const playAnno = make('g', { class: 'chalk-anno', 'data-anno': 'play', 'data-phase': '0' });
  const playTitle = createTitle({
    size: variant === 'B' ? 34 : 32,
    words: variant === 'A' ? label('chalk.playTitle').split(/\s+/) : [label('chalk.playTitle')],
    rotations: variant === 'A' ? [2, -2, 2] : [variant === 'C' ? -1.5 : 0],
  });
  const playBody =
    variant === 'B'
      ? null
      : createBody(
          [
            { key: 'chalk.playBody1', baseline: 66 },
            { key: 'chalk.playBody2', baseline: 86 },
          ],
          { x: 16 },
        );

  const playSpring = make('g', { class: 'chalk-spring' });
  const playCoil = stroke(playSpring);
  playAnno.append(playSpring);

  const playArrows = make('g', { class: 'chalk-arrow' });
  const playArrow = stroke(playArrows);
  const playTip = make('circle', { 'data-tip': 'hub', r: TIP_R, cx: 0, cy: 0, fill: 'none' });
  playArrows.append(playTip);
  playAnno.append(playArrows);

  const playDeco = make('g', {});
  let playUnderline = null;
  if (variant !== 'B') {
    playUnderline = stroke(playDeco);
    stroke(playDeco).setAttribute('d', 'M18 4L30 14M30 2L42 12M42 4L54 14');
  }
  playAnno.append(playDeco, playTitle.wrap);
  if (playBody) playAnno.append(playBody.wrap);
  layer.append(playAnno);

  // ── 2. drag the arm, anchored on the arm head ──────────────
  const seekAnno = make('g', { class: 'chalk-anno', 'data-anno': 'seek', 'data-phase': '1' });
  const seekTitle = createTitle({
    size: variant === 'B' ? 30 : 28,
    words: [label(variant === 'B' ? 'chalk.seek' : 'chalk.seekTitle')],
  });
  const seekBody =
    variant === 'B'
      ? null
      : createBody(
          [
            { key: 'chalk.seekBody1', baseline: 424 },
            { key: 'chalk.seekBody2', baseline: 442 },
          ],
          { x: 600, anchor: 'end' },
        );

  const seekSpring = make('g', { class: 'chalk-spring' });
  const seekCoil = stroke(seekSpring);
  seekAnno.append(seekSpring);

  const seekArrows = make('g', { class: 'chalk-arrow' });
  const seekArc = stroke(seekArrows, { width: 2.2, dash: '4 6' });
  const seekArrow = stroke(seekArrows);
  const seekTip = make('circle', { 'data-tip': 'head', r: TIP_R, cx: 0, cy: 0, fill: 'none' });
  seekArrows.append(seekTip);
  seekAnno.append(seekArrows);

  seekAnno.append(seekTitle.wrap);
  if (seekBody) seekAnno.append(seekBody.wrap);

  // Right-hand doodle: a small record and a note below the caption, kept clear
  // of the caption above and the swipe arc below.
  if (variant !== 'B') {
    const doodle = make('g', {});
    stroke(doodle).setAttribute(
      'd',
      [
        'M511 488a16 15.5 0 1 0 32 0a16 15.5 0 1 0-32 0',
        'M515 488a12 11.6 0 1 0 24 0a12 11.6 0 1 0-24 0',
        'M519.5 488a7.5 7.1 0 1 0 15 0a7.5 7.1 0 1 0-15 0',
        'M525.5 489.4a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
        'M553.4 472.4L553.4 458',
        'M553.4 458c4.6 1.6 6.6 5.4 3.4 9.4',
        'M546.8 474.4a4.2 3.2-22 1 0 8.4 0a4.2 3.2-22 1 0-8.4 0',
      ].join(''),
    );
    seekAnno.append(doodle);
  }
  layer.append(seekAnno);

  // ── 3. swipe to skip, anchored on the stage ────────────────
  const swipeAnno = make('g', { class: 'chalk-anno', 'data-anno': 'swipe', 'data-phase': '2' });
  const swipeTitle = createTitle({
    size: variant === 'B' ? 20 : 26,
    words: [label(variant === 'B' ? 'chalk.swipe' : 'chalk.swipeTitle')],
  });
  const swipeBody =
    variant === 'B'
      ? null
      : createBody(
          [
            { key: 'chalk.swipeBody1', baseline: 476 },
            { key: 'chalk.swipeBody2', baseline: 494 },
          ],
          { x: 10 },
        );

  const swipeArrows = make('g', { class: 'chalk-arrow' });
  const swipeArc = stroke(swipeArrows, { width: 2.2, dash: '4 6' });
  {
    const start = { x: 120, y: 528 };
    const control = { x: 250, y: 542 };
    const third = { x: 390, y: 542 };
    const end = { x: 520, y: 528 };
    const base = `M${pt(start)}C${pt(control)} ${pt(third)} ${pt(end)}`;
    const left = arrowHead(start, { x: start.x - control.x, y: start.y - control.y }, { length: 9 });
    const right = arrowHead(end, { x: end.x - third.x, y: end.y - third.y }, { length: 9 });
    swipeArc.setAttribute('d', `${base} ${left} ${right}`);
  }
  // Vertical arc hugging the arm: drawn here because it belongs to the seek
  // caption, but it is static and never remeasured.
  {
    const start = { x: 602, y: 180 };
    const control = { x: 628, y: 240 };
    const end = { x: 602, y: 300 };
    const base = `M${pt(start)}C${pt(control)} ${pt(control)} ${pt(end)}`;
    const top = arrowHead(start, { x: 0, y: -1 }, { length: 9 });
    const bottom = arrowHead(end, { x: 0, y: 1 }, { length: 9 });
    seekArc.setAttribute('d', `${base} ${top} ${bottom}`);
  }
  swipeAnno.append(swipeArrows, swipeTitle.wrap);
  if (swipeBody) swipeAnno.append(swipeBody.wrap);
  layer.append(swipeAnno);

  deck.append(layer);

  /** Left edge of the record at height `y`; Infinity once the line clears it. */
  function recordEdge(disc, y) {
    const cx = (disc.x0 + disc.x1) / 2;
    const cy = (disc.y0 + disc.y1) / 2;
    const rx = (disc.x1 - disc.x0) / 2;
    const ry = (disc.y1 - disc.y0) / 2;
    if (!rx || !ry) return Infinity;
    const reach = Math.abs(y - cy) / ry;
    if (reach >= 1) return Infinity;
    return cx - rx * Math.sqrt(1 - reach * reach);
  }

  let frame = 0;
  let observer = null;

  function layout() {
    if (!deck.isConnected) return;
    const deckRect = deck.getBoundingClientRect();
    const scale = deckRect.width / VIEW_W;
    if (!scale) return;
    const toUnits = (target) => {
      const rect = target?.getBoundingClientRect();
      if (!rect || !rect.width) return null;
      const x0 = (rect.left - deckRect.left) / scale;
      const x1 = (rect.right - deckRect.left) / scale;
      const y0 = (rect.top - deckRect.top) / scale;
      const y1 = (rect.bottom - deckRect.top) / scale;
      return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    };
    const gap = GAP_PX / scale;
    const hub = toUnits(deck.querySelector('.hub-hit'));
    const head = toUnits(deck.querySelector('.arm-head-hit'));
    const disc = toUnits(deck.querySelector('.disc-wrap'));

    // 1. play / pause
    const playText = placeTitle(playTitle, { x: 16, y: 40 });
    if (playUnderline) {
      playUnderline.setAttribute('d', wavePath({ from: 16, to: 16 + playText.width, y: 48, seed: 11 }));
    }
    if (hub) {
      // The spring starts 20 units past the caption and is nudged right until
      // its own box keeps a full 12 units of air from the text.
      const copyRight = Math.max(
        playText.right,
        ...(playBody ? playBody.nodes.map(({ node }) => 16 + node.getComputedTextLength()) : [0]),
      );
      let startX = playText.right + 24;
      let coil = coilPath({ x: startX, y: 48, seed: 5, angle: -22 });
      if (coil.bbox.x0 < copyRight + 16) {
        startX += copyRight + 16 - coil.bbox.x0;
        coil = coilPath({ x: startX, y: 48, seed: 5, angle: -22 });
      }
      playCoil.setAttribute('d', coil.d);
      const tip = { x: hub.x0 - gap, y: hub.cy };
      const tail = { x: tip.x - 36, y: tip.y - 16 };
      // The arch may not cross the top-bar buttons, which on a phone sit over
      // the deck's top edge: the whole high point drops below them instead of
      // squeezing past. On a desktop deck they are far above the deck, so the
      // arch keeps its normal height.
      const buttons = [...document.querySelectorAll('.icon-btn')]
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => (rect.bottom - deckRect.top) / scale);
      const apex = Math.max(9, ...buttons.map((bottom) => bottom + 6));
      const first = { x: coil.end.x + (tip.x - coil.end.x) * 0.55, y: coil.end.y - 40 };
      for (let solve = 0; solve < 8; solve += 1) {
        const min = cubicMinY(coil.end, first, tail, tip);
        if (Math.abs(min - apex) < 0.3) break;
        first.y += (apex - min) / 0.44;
      }
      playArrow.setAttribute(
        'd',
        `M${pt(coil.end)}C${pt(first)} ${pt(tail)} ${pt(tip)} ${arrowHead(tip, {
          x: tip.x - tail.x,
          y: tip.y - tail.y,
        })}`,
      );
      playTip.setAttribute('cx', fmt(tip.x));
      playTip.setAttribute('cy', fmt(tip.y));
    }

    // 2. drag the arm
    placeTitle(seekTitle, { x: 600, y: 400, anchor: 'end' });
    if (head) {
      const start = { x: 604, y: 500 };
      const coil = coilPath({
        x: start.x,
        y: start.y,
        radius: 7,
        advance: 40,
        turns: 1.5,
        angle: -90,
        seed: 7,
      });
      // Box x 604..618, y 460..500: right of the caption and clear of it.
      seekCoil.setAttribute('d', coil.d);
      const tip = { x: head.x1 + gap, y: head.cy };
      const tail = { x: tip.x + 24, y: tip.y + 18 };
      const first = { x: coil.end.x + 2, y: coil.end.y - (coil.end.y - tip.y) * 0.55 };
      seekArrow.setAttribute(
        'd',
        `M${pt(coil.end)}C${pt(first)} ${pt(tail)} ${pt(tip)} ${arrowHead(tip, {
          x: tip.x - tail.x,
          y: tip.y - tail.y,
        })}`,
      );
      seekTip.setAttribute('cx', fmt(tip.x));
      seekTip.setAttribute('cy', fmt(tip.y));
    }

    // 3. swipe to skip
    placeTitle(swipeTitle, { x: 10, y: variant === 'B' ? 470 : 452 });
    if (swipeBody && disc) {
      for (const { node, baseline } of swipeBody.nodes) {
        node.removeAttribute('textLength');
        node.removeAttribute('lengthAdjust');
        const allowed = recordEdge(disc, baseline - 13) - 4 - swipeBody.x;
        const width = node.getComputedTextLength();
        if (Number.isFinite(allowed) && width > allowed) {
          node.setAttribute('textLength', fmt(Math.max(12, allowed)));
          node.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      }
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  }

  schedule();
  observer = new ResizeObserver(() => {
    if (!deck.isConnected) {
      observer?.disconnect();
      return;
    }
    schedule();
  });
  observer.observe(deck);

  return {
    layout,
    destroy() {
      observer?.disconnect();
      observer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      layer.remove();
    },
  };
}
