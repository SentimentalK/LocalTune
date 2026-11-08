/**
 * Background chalk notes. Three hand-drawn captions sit over the deck: "tap to
 * play" curls into the arm base, the two-line "put it where you want" caption
 * hooks up to the arm head, and a short "scratch" label sits outside a
 * concentric arc that hugs the record's lower-left rim. The layer is decoration
 * only: it takes no pointer events, is hidden from assistive tech, and never
 * tracks input or playback.
 *
 * Every coordinate is a deck user unit (640 x 550), so the drawing follows the
 * deck's CSS size on its own. The two anchors that depend on layout (the arm
 * base and the arm head) are measured from the live DOM, which keeps each
 * arrow tip exactly 8 px off its target at any window size. The scratch arc is
 * built from the record's own box: its radius is 1.06 x the record radius and
 * its label is right-aligned against the arc's left branch.
 *
 * The handwriting faces are bundled instead of fetched: esbuild copies the
 * per-script subsets under `src/assets/fonts/` (all SIL OFL 1.1) into
 * `assets/`, and styles.css picks one by `[lang]`. The captions themselves
 * follow the app locale like every other string.
 */

import { t } from '../i18n/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 640;
const VIEW_H = 550;
const GAP_PX = 8;
const TIP_R = 0.5;
const INK = '#F2F5F3';

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

/** A filled hand-drawn arrow head pointing along `direction`. */
function arrowHeadPath(tip, direction, { length = 15, half = 6.4 } = {}) {
  const unit = normalize(direction);
  const normal = { x: -unit.y, y: unit.x };
  const back = { x: tip.x - unit.x * length, y: tip.y - unit.y * length };
  const notch = { x: tip.x - unit.x * length * 0.78, y: tip.y - unit.y * length * 0.78 };
  return [
    `M${pt(tip)}`,
    `L${pt({ x: back.x + normal.x * half, y: back.y + normal.y * half })}`,
    `Q${pt(notch)} ${pt({ x: back.x - normal.x * half, y: back.y - normal.y * half })}`,
    'Z',
  ].join(' ');
}

/**
 * Hand-wobbled arc concentric with the record, in deck units. `from`/`to` are
 * screen angles (y grows down), so 95° is straight down and 165° is left: the
 * lower-left quadrant. The radius jitters by a fraction of a unit, which keeps
 * the stroke chalky without moving it off the record's edge.
 */
function arcPath({ cx, cy, radius, from, to, steps = 72, seed = 13, wobble = 0.45 }) {
  const rand = seeded(seed);
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const at = index / steps;
    const angle = rad(from + (to - from) * at);
    const jitter = index === 0 || index === steps ? 0 : (rand() * 2 - 1) * wobble;
    const r = radius + jitter;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points.map((spot, index) => `${index === 0 ? 'M' : 'L'}${pt(spot)}`).join('');
}

/** Hand-wobbled wave: the caption underline. */
function wavePath({ from, to, y, amplitude = 2.2, turns = 3.5, seed = 3 }) {
  const rand = seeded(seed);
  const steps = 80;
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const at = index / steps;
    const wobble = index === 0 || index === steps ? 0 : (rand() * 2 - 1) * 0.5;
    points.push({
      x: from + (to - from) * at,
      y: y + amplitude * Math.sin(at * Math.PI * 2 * turns) + wobble,
    });
  }
  return points.map((spot, index) => `${index === 0 ? 'M' : 'L'}${pt(spot)}`).join('');
}

/**
 * The chalk captions are a first-run hint: they exist while the queue still
 * holds demo tracks, and they give the stage back while music plays.
 */
export function shouldShowChalk({ hasDemo, playing, gesture = false }) {
  return Boolean(hasDemo) && !playing && !gesture;
}

/**
 * Mounts the chalk layer into a deck and returns its handle. `layout()` forces
 * a remeasure; `setVisible()` shows or hides the hint; `destroy()` drops the
 * observer and the nodes.
 */
export function mountChalkLayer(deck) {
  if (!deck || typeof deck.getBoundingClientRect !== 'function') {
    return { layout() {}, setVisible() {}, destroy() {} };
  }

  const label = (key) => t(key);

  const layer = make('svg', {
    class: 'chalk-layer is-hidden',
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });

  // ── play / pause: a pigtail that curls into the arm base ────────────────
  const playAnno = make('g', { class: 'chalk-anno', 'data-anno': 'play', 'data-phase': '0' });
  const playSlashes = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const playLoop = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const playSpring = make('g', { class: 'chalk-spring' }, [playLoop]);
  const playTail = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const playHead = make('path', { class: 'chalk-head', fill: INK });
  const playTip = make('circle', { 'data-tip': 'hub', r: TIP_R, cx: 0, cy: 0, fill: 'none' });
  const playArrow = make('g', { class: 'chalk-arrow' }, [playTail, playHead]);
  const playTitle = make('text', {
    class: 'chalk-label',
    'text-anchor': 'end',
    'font-size': 30,
    fill: INK,
  });
  playAnno.append(playSlashes, playSpring, playArrow, playTitle, playTip);
  layer.append(playAnno);

  // ── drag the arm: two lines that hook up to the moving head ─────────────
  const seekAnno = make('g', { class: 'chalk-anno', 'data-anno': 'seek', 'data-phase': '1' });
  const seekArrows = make('g', { class: 'chalk-arrow' });
  const seekTail = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const seekHead = make('path', { class: 'chalk-head', fill: INK });
  const seekTip = make('circle', { 'data-tip': 'head', r: TIP_R, cx: 0, cy: 0, fill: 'none' });
  seekArrows.append(seekTail, seekHead, seekTip);

  const seekCaption = make('g', { class: 'chalk-caption' });
  const seekTextTop = make('text', {
    class: 'chalk-label',
    'text-anchor': 'end',
    'font-size': 24,
    fill: INK,
  });
  const seekTextBottom = make('text', {
    class: 'chalk-label',
    'text-anchor': 'end',
    'font-size': 24,
    fill: INK,
  });
  const seekUnderline = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const seekSlashes = make('path', {
    class: 'chalk-ink',
    d: 'M600 522l5 13M607 516l5 13M614 522l5 13',
    'vector-effect': 'non-scaling-stroke',
  });
  // The whole caption leans like the reference sheet; the arrow does not.
  seekCaption.setAttribute('transform', 'rotate(-5 594 515)');
  seekCaption.append(seekTextTop, seekTextBottom, seekUnderline, seekSlashes);
  seekAnno.append(seekArrows, seekCaption);
  layer.append(seekAnno);

  // ── scratch: a concentric arc on the record's lower-left, with a label ──
  const scratchAnno = make('g', { class: 'chalk-anno', 'data-anno': 'scratch', 'data-phase': '2' });
  const scratchMotion = make('g', { class: 'chalk-arrow' });
  const scratchArc = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  const scratchHeadStart = make('path', { class: 'chalk-head', fill: INK });
  const scratchHeadEnd = make('path', { class: 'chalk-head', fill: INK });
  const scratchSlashes = make('path', {
    class: 'chalk-ink',
    'vector-effect': 'non-scaling-stroke',
  });
  scratchMotion.append(scratchArc, scratchHeadStart, scratchHeadEnd);

  const scratchCaption = make('g', { class: 'chalk-caption' });
  const scratchTitle = make('text', {
    class: 'chalk-label',
    'text-anchor': 'end',
    'font-size': 30,
    fill: INK,
  });
  scratchCaption.append(scratchSlashes, scratchTitle);
  scratchAnno.append(scratchMotion, scratchCaption);
  layer.append(scratchAnno);

  deck.append(layer);

  playTitle.textContent = label('chalk.play');
  seekTextTop.textContent = label('chalk.seekPlace');
  seekTextBottom.textContent = label('chalk.seekMove');
  scratchTitle.textContent = label('chalk.scratch');

  let visible = false;

  /** Show or hide the hint. Only the class changes: no layout, no rAF. */
  function setVisible(next) {
    const show = Boolean(next);
    if (show === visible) return;
    visible = show;
    layer.classList.toggle('is-hidden', !show);
  }

  let measuring = false;

  /**
   * Places a right-aligned line, shrinking long translations until they fit
   * `max` user units. Returns the width in user units.
   */
  function placeLabel(node, { x, y, rotate = 0, size, max = Infinity, min = 15 }) {
    node.setAttribute('x', fmt(x));
    node.setAttribute('y', fmt(y));
    if (size) node.setAttribute('font-size', fmt(size));
    let width = node.getComputedTextLength();
    if (width > max) {
      const base = Number(node.getAttribute('font-size'));
      const scaled = Math.max(min, (base * max) / width);
      node.setAttribute('font-size', fmt(scaled));
      width = node.getComputedTextLength();
    }
    if (rotate) {
      const cx = x - width / 2;
      node.setAttribute('transform', `rotate(${rotate} ${fmt(cx)} ${fmt(y)})`);
    } else {
      node.removeAttribute('transform');
    }
    return width;
  }

  function layout() {
    if (!deck.isConnected || measuring) return;
    const deckRect = deck.getBoundingClientRect();
    const scale = deckRect.width / VIEW_W;
    if (!scale) return;
    measuring = true;
    try {
      const toUnits = (node) => {
        const rect = node?.getBoundingClientRect();
        if (!rect || !rect.width) return null;
        return {
          x0: (rect.left - deckRect.left) / scale,
          x1: (rect.right - deckRect.left) / scale,
          y0: (rect.top - deckRect.top) / scale,
          y1: (rect.bottom - deckRect.top) / scale,
          cx: (rect.left + rect.width / 2 - deckRect.left) / scale,
          cy: (rect.top + rect.height / 2 - deckRect.top) / scale,
        };
      };
      const gap = GAP_PX / scale;
      const hub = toUnits(deck.querySelector('.hub-hit'));
      const head = toUnits(deck.querySelector('.arm-head-hit'));

      // 1. play: caption right of the record, pigtail into the arm base.
      // The size is identical for every locale; when a script's ascender would
      // reach into the toolbar band, the whole caption drops instead of
      // shrinking (a smaller Russian line reads as a bug).
      const playWidth = placeLabel(playTitle, { x: 376, y: 46, rotate: -3, size: 30 });
      // The three ticks sit just left of the caption's own left edge, so a long
      // translation never runs into them.
      const slashX = 376 - playWidth - 46;
      playSlashes.setAttribute(
        'd',
        `M${fmt(slashX)} 10l6 13M${fmt(slashX + 14)} 5l6 13M${fmt(slashX + 28)} 10l6 13`,
      );
      if (hub) {
        const tip = { x: hub.x0 - gap, y: hub.cy };
        playLoop.setAttribute(
          'd',
          'M388 54C384 36 396 24 406 33C415 41 408 54 397 51C391 49 390 43 395 38',
        );
        const tail = { x: 395, y: 38 };
        const c1 = { x: 430, y: 8 };
        const c2 = { x: tip.x - 26, y: tip.y - 26 };
        playTail.setAttribute('d', `M${pt(tail)}C${pt(c1)} ${pt(c2)} ${pt(tip)}`);
        playHead.setAttribute('d', arrowHeadPath(tip, { x: tip.x - c2.x, y: tip.y - c2.y }));
        playTip.setAttribute('cx', fmt(tip.x));
        playTip.setAttribute('cy', fmt(tip.y));
      }

      // 2. seek: two lines under the arm, hooking up to the head. One size for
      // every locale; the caption sits low enough for the longest line to clear
      // the record instead of shrinking to fit.
      const SEEK_SIZE = 28;
      const bottomWidth = placeLabel(seekTextBottom, { x: 594, y: 522, size: SEEK_SIZE });
      placeLabel(seekTextTop, { x: 594, y: 490, size: SEEK_SIZE });
      seekUnderline.setAttribute(
        'd',
        wavePath({ from: 594 - bottomWidth - 6, to: 600, y: 536, seed: 7 }),
      );
      if (head) {
        const tip = { x: head.cx, y: head.y1 + gap };
        const tail = { x: 446, y: 452 };
        const c1 = { x: 452, y: 402 };
        const c2 = { x: tip.x - 26, y: tip.y + 30 };
        seekTail.setAttribute('d', `M${pt(tail)}C${pt(c1)} ${pt(c2)} ${pt(tip)}`);
        seekHead.setAttribute('d', arrowHeadPath(tip, { x: tip.x - c2.x, y: tip.y - c2.y }));
        seekTip.setAttribute('cx', fmt(tip.x));
        seekTip.setAttribute('cy', fmt(tip.y));
      }

      // 3. scratch: a short arc concentric with the record, 0.13 R outside the
      // rim, sweeping 46° across the lower-left with a hand-drawn head at each
      // end. The caption sits in the whitespace outside the arc, at least 18
      // units off the stroke, never on the artwork.
      const art = toUnits(deck.querySelector('.vinyl'));
      if (art) {
        const artCx = (art.x0 + art.x1) / 2;
        const artCy = (art.y0 + art.y1) / 2;
        const artR = (art.x1 - art.x0) / 2;
        const arcR = artR * 1.1;
        const START = 108;
        const END = 154;
        scratchArc.setAttribute(
          'd',
          arcPath({ cx: artCx, cy: artCy, radius: arcR, from: START, to: END }),
        );
        const at = (deg) => ({
          x: artCx + arcR * Math.cos(rad(deg)),
          y: artCy + arcR * Math.sin(rad(deg)),
        });
        scratchHeadStart.setAttribute(
          'd',
          arrowHeadPath(at(START), { x: Math.sin(rad(START)), y: -Math.cos(rad(START)) }, {
            length: 14,
            half: 6,
          }),
        );
        scratchHeadEnd.setAttribute(
          'd',
          arrowHeadPath(at(END), { x: -Math.sin(rad(END)), y: Math.cos(rad(END)) }, {
            length: 14,
            half: 6,
          }),
        );

        // The label sits in the whitespace outside the arc's left branch. It
        // is pinned above the 33⅓ plate (9 CSS px of clearance), sized like the
        // other two captions, and never shrunk. Its right edge is pulled back
        // until the nearest corner of the box is 18 units off the stroke; wide
        // translations may start left of the deck, which is transparent.
        const plate = toUnits(deck.querySelector('.rpm-tag'));
        const limitBottom = (plate ? plate.y0 : VIEW_H) - 9 / scale;
        const SIZE = 30;
        placeLabel(scratchTitle, { x: 320, y: limitBottom, size: SIZE });
        const probe = toUnits(scratchTitle);
        const descent = probe ? Math.max(0, probe.y1 - limitBottom) : 0;
        const labelY = limitBottom - descent;
        // The box top does not depend on x, so measuring it once gives the
        // exact right edge that keeps the nearest corner 18 units off the arc.
        const boxTop = probe ? probe.y0 - descent : labelY - SIZE * 0.72;
        const clearX =
          artCx - Math.sqrt(Math.max(0, (arcR + 19) ** 2 - (boxTop - artCy) ** 2));
        let labelRight = clearX;
        let labelWidth = placeLabel(scratchTitle, { x: labelRight, y: labelY, size: SIZE });
        // The ink may overhang the end anchor by a side bearing, which would
        // eat into the 18-unit gap; pull the anchor back by that overhang.
        const placed = toUnits(scratchTitle);
        if (placed && placed.x1 > labelRight) {
          labelRight -= placed.x1 - labelRight;
          labelWidth = placeLabel(scratchTitle, { x: labelRight, y: labelY, size: SIZE });
        }
        // Never let the block run off the screen: keep 8 px to the viewport.
        const screenFloor = (8 - deckRect.left) / scale;
        if (labelRight - labelWidth < screenFloor) {
          labelRight = screenFloor + labelWidth;
          placeLabel(scratchTitle, { x: labelRight, y: labelY, size: SIZE });
        }
        // Three slashes above the word, kept at least 10 units off the ink.
        const slashX = labelRight - labelWidth + 2;
        const slashY = labelY - SIZE * 0.72 - 30;
        scratchSlashes.setAttribute(
          'd',
          `M${fmt(slashX)} ${fmt(slashY)}l5 12M${fmt(slashX + 12)} ${fmt(slashY - 4)}l5 12M${fmt(
            slashX + 24,
          )} ${fmt(slashY)}l5 12`,
        );
      }
    } finally {
      measuring = false;
    }
  }

  layout();
  const observer = new ResizeObserver(() => layout());
  observer.observe(deck);
  // The caption metrics depend on the bundled face; remeasure once it swaps in
  // so the height fit and the rotations are not computed on fallback metrics.
  document.fonts?.ready?.then(() => layout()).catch(() => {});
  document.fonts?.addEventListener?.('loadingdone', () => layout());

  return {
    layout,
    setVisible,
    destroy() {
      observer.disconnect();
      layer.remove();
    },
  };
}
