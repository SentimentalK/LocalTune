/**
 * First-run guide. Four steps, each a hand-drawn chalk arrow pointing at a real
 * control plus one short caption. Nothing is duplicated from the shell: the
 * arrow is measured from the live element, so a resize or a remount only needs
 * a fresh measurement.
 *
 * The overlay lives on <body>, not inside the app tree, because the shell is
 * rebuilt on a language change. Automation stays out of the way: Playwright and
 * other drivers set `navigator.webdriver`, and an unattended run must not be
 * covered by a modal, so the automatic pass is gated on that flag (`?onboarding=force`
 * bypasses it for the guide's own tests; the completion mark still wins, and the
 * About replay never consults the gate).
 */

import { t } from '../i18n/index.js';
import { el } from './dom.js';

export const ONBOARDING_KEY = 'localtune:onboarded';
export const ONBOARDING_VERSION = 'v1';

export const ONBOARDING_STEPS = [
  { id: 'play', target: '.hub-hit', side: 'below', textKey: 'onboarding.step.play' },
  { id: 'seek', target: '.arm-head-hit', side: 'left', textKey: 'onboarding.step.seek' },
  { id: 'tabs', target: '.tabs', side: 'below', textKey: 'onboarding.step.tabs' },
  {
    id: 'search',
    target: '[data-testid="search-input"]',
    side: 'above',
    textKey: 'onboarding.step.search',
  },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE = 24;
const CAPTION_EDGE = 12;
const CAPTION_LEAD = 14;
const CAPTION_MAX = 240;
const LAYOUT_WATCH_MS = 1200;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const round2 = (value) => Number(value.toFixed(2));

export function isOnboarded(storage) {
  return storage?.getItem?.(ONBOARDING_KEY) === ONBOARDING_VERSION;
}

export function markOnboarded(storage) {
  storage?.setItem?.(ONBOARDING_KEY, ONBOARDING_VERSION);
}

export function clearOnboarded(storage) {
  storage?.removeItem?.(ONBOARDING_KEY);
}

export function shouldShowOnboarding({ storage, hasTracks, automated, force }) {
  return !isOnboarded(storage) && Boolean(hasTracks) && (!automated || Boolean(force));
}

/**
 * Start, control point and end of the chalk arrow. The tip lands exactly on the
 * target centre; the tail sits `gap` away on the requested side and never
 * leaves the viewport's 24px margin.
 */
export function arrowGeometry({ target, viewport, side, gap = 96 }) {
  const end = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const raw =
    side === 'above'
      ? { x: end.x, y: end.y - gap }
      : side === 'left'
        ? { x: end.x - gap, y: end.y }
        : side === 'right'
          ? { x: end.x + gap, y: end.y }
          : { x: end.x, y: end.y + gap };
  const start = {
    x: clamp(raw.x, EDGE, Math.max(EDGE, viewport.width - EDGE)),
    y: clamp(raw.y, EDGE, Math.max(EDGE, viewport.height - EDGE)),
  };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const control = {
    x: (start.x + end.x) / 2 + (-dy / length) * 16,
    y: (start.y + end.y) / 2 + (dx / length) * 16,
  };
  return { start, control, end };
}

/** Linear congruential generator: same seed, same chalk wobble. */
function seeded(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Quadratic curve sampled into four straight segments, wobbled by up to 2px at
 * the joints, then two short wing strokes that both end on the tip. The final
 * coordinate of the `d` string is exactly `end`.
 */
export function chalkArrowPath({ start, control, end }, seed) {
  const rand = seeded(seed);
  const base = (t) => ({
    x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
    y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
  });
  const point = (t) => {
    const spot = base(t);
    return { x: spot.x + (rand() * 2 - 1) * 2, y: spot.y + (rand() * 2 - 1) * 2 };
  };
  const settle = (spot) => `${round2(spot.x)} ${round2(spot.y)}`;
  const tip = `${end.x} ${end.y}`;

  const parts = [`M${settle(start)}`];
  for (const t of [0.25, 0.5, 0.75]) parts.push(`L${settle(point(t))}`);
  parts.push(`L${tip}`);

  const dx = end.x - control.x;
  const dy = end.y - control.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const back = { x: end.x - ux * 10, y: end.y - uy * 10 };
  for (const sign of [1, -1]) {
    const wing = { x: back.x - uy * 6.5 * sign, y: back.y + ux * 6.5 * sign };
    parts.push(`M${settle(wing)}L${tip}`);
  }
  return parts.join(' ');
}

function svgNode(tag, props = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Mounts the overlay on demand and owns every listener it adds. `step()`
 * reports the visible step index, or -1 when nothing is showing.
 */
export function createOnboarding({ onFinish = () => {} } = {}) {
  let overlay = null;
  let layer = null;
  let arrow = null;
  let tip = null;
  let caption = null;
  let nextButton = null;
  let index = -1;
  let marked = null;
  let previousFocus = null;
  let measureFrame = 0;
  let scrolled = false;
  let watchFrame = 0;
  let watchSince = 0;
  let watchSignature = '';

  const currentStep = () => (index >= 0 ? ONBOARDING_STEPS[index] : null);

  function svgEl() {
    arrow = svgNode('path', { class: 'onboarding-arrow', 'data-testid': 'onboarding-arrow' });
    arrow.setAttribute('pathLength', '1');
    tip = svgNode('circle', {
      class: 'onboarding-tip',
      'data-testid': 'onboarding-arrow-tip',
      r: '2.5',
    });
    layer = svgNode('svg', { class: 'onboarding-layer', 'aria-hidden': 'true' });
    layer.append(arrow, tip);
    return layer;
  }

  function build() {
    const skipButton = el('button', {
      class: 'btn-pill ghost onboarding-skip',
      type: 'button',
      'data-testid': 'onboarding-skip',
      text: t('onboarding.skip'),
    });
    nextButton = el('button', {
      class: 'btn-pill onboarding-next',
      type: 'button',
      'data-testid': 'onboarding-next',
    });
    caption = el('p', {
      class: 'onboarding-caption',
      'data-testid': 'onboarding-caption',
      'aria-live': 'polite',
    });
    overlay = el(
      'div',
      {
        class: 'onboarding',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('onboarding.title'),
        'data-testid': 'onboarding',
      },
      [svgEl(), caption, el('div', { class: 'onboarding-actions' }, [skipButton, nextButton])],
    );
    overlay.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    document.body.append(overlay);
  }

  function restartDraw() {
    // Re-assigning the animation replays the stroke from zero on every step.
    arrow.style.animation = 'none';
    void arrow.getBoundingClientRect();
    arrow.style.animation = '';
  }

  function placeCaption(spot, viewport) {
    const width = Math.min(caption.offsetWidth || CAPTION_MAX, CAPTION_MAX);
    const height = caption.offsetHeight || 0;
    caption.style.left = `${clamp(
      spot.x - width / 2,
      CAPTION_EDGE,
      Math.max(CAPTION_EDGE, viewport.width - width - CAPTION_EDGE),
    )}px`;
    caption.style.top = `${clamp(
      spot.y,
      CAPTION_EDGE,
      Math.max(CAPTION_EDGE, viewport.height - height - CAPTION_EDGE),
    )}px`;
  }

  function paint(step, box, viewport, animate = true) {
    if (!box) {
      overlay.classList.add('is-blind');
      arrow.removeAttribute('d');
      tip.removeAttribute('cx');
      tip.removeAttribute('cy');
      caption.classList.add('is-centered');
      caption.style.left = `${Math.round((viewport.width - caption.offsetWidth) / 2)}px`;
      caption.style.top = `${Math.round((viewport.height - caption.offsetHeight) / 2)}px`;
      return;
    }
    overlay.classList.remove('is-blind');
    caption.classList.remove('is-centered');
    const geometry = arrowGeometry({ target: box.rect, viewport, side: step.side });
    layer.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    arrow.setAttribute('d', chalkArrowPath(geometry, index + 1));
    tip.setAttribute('cx', String(geometry.end.x));
    tip.setAttribute('cy', String(geometry.end.y));
    const dx = geometry.end.x - geometry.start.x;
    const dy = geometry.end.y - geometry.start.y;
    const length = Math.hypot(dx, dy) || 1;
    placeCaption(
      {
        x: geometry.start.x + (dx / length) * CAPTION_LEAD,
        y: geometry.start.y + (dy / length) * CAPTION_LEAD,
      },
      viewport,
    );
    if (animate) restartDraw();
  }

  function measure(animate = true) {
    const step = currentStep();
    if (!step || !overlay) return;
    // The overlay is `inset: 0`, so its own box is the coordinate space of the
    // arrow: one SVG user unit is one CSS pixel, exactly like the target rects.
    const canvas = overlay.getBoundingClientRect();
    const viewport = {
      width: canvas.width || window.innerWidth,
      height: canvas.height || window.innerHeight,
    };
    const target = document.querySelector(step.target);
    const rect = target?.getBoundingClientRect() ?? null;
    const blind = !rect || rect.width <= 0 || rect.height <= 0;
    if (!blind) {
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const outside =
        center.x < 0 ||
        center.y < 0 ||
        center.x > viewport.width ||
        center.y > viewport.height;
      if (outside && !scrolled) {
        scrolled = true;
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        cancelAnimationFrame(measureFrame);
        measureFrame = requestAnimationFrame(() => {
          measureFrame = 0;
          measure(animate);
        });
        return;
      }
    }
    paint(step, blind ? null : { rect }, viewport, animate);
  }

  function markTarget(selector) {
    if (marked?.isConnected) marked.removeAttribute('data-onboarding-target');
    marked = selector ? document.querySelector(selector) : null;
    if (marked) marked.setAttribute('data-onboarding-target', '');
  }

  function stopWatch() {
    cancelAnimationFrame(watchFrame);
    watchFrame = 0;
  }

  /**
   * The shell can still be settling when the first step appears (the library
   * panel animates its width open, which slides the deck). Follow the target's
   * box for a moment and repaint when it moves; the stroke animation only runs
   * on the step change, so following a moving control looks like one drawing.
   */
  function watchLayout() {
    watchFrame = 0;
    const step = currentStep();
    if (!step || !overlay) return;
    const rect = document.querySelector(step.target)?.getBoundingClientRect() ?? null;
    const signature = rect
      ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`
      : 'none';
    if (signature !== watchSignature) {
      watchSignature = signature;
      measure(false);
    }
    if (performance.now() - watchSince < LAYOUT_WATCH_MS) {
      watchFrame = requestAnimationFrame(watchLayout);
    }
  }

  function startWatch() {
    stopWatch();
    watchSince = performance.now();
    watchSignature = '';
    watchFrame = requestAnimationFrame(watchLayout);
  }

  function show(next) {
    const step = ONBOARDING_STEPS[next];
    if (!step) {
      finish();
      return;
    }
    if (!overlay) build();
    index = next;
    scrolled = false;
    markTarget(step.target);
    caption.textContent = t(step.textKey);
    nextButton.textContent = t(
      next === ONBOARDING_STEPS.length - 1 ? 'onboarding.start' : 'onboarding.next',
    );
    measure();
    startWatch();
    nextButton.focus({ preventScroll: true });
  }

  function advance() {
    if (index < 0) return;
    if (index >= ONBOARDING_STEPS.length - 1) finish();
    else show(index + 1);
  }

  function unmount() {
    if (!overlay) return;
    markTarget(null);
    stopWatch();
    cancelAnimationFrame(measureFrame);
    measureFrame = 0;
    index = -1;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    overlay.remove();
    overlay = null;
    layer = null;
    arrow = null;
    tip = null;
    caption = null;
    nextButton = null;
    const restore = previousFocus;
    previousFocus = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  function finish() {
    if (!overlay) return;
    unmount();
    markOnboarded(globalThis.localStorage);
    onFinish();
  }

  function onClick(event) {
    if (event.target instanceof Element && event.target.closest('.onboarding-skip')) {
      finish();
      return;
    }
    advance();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }

  function onResize() {
    if (!overlay) return;
    scrolled = false;
    measure();
    startWatch();
  }

  return {
    start() {
      if (overlay) return;
      previousFocus = document.activeElement;
      show(0);
    },
    replay() {
      unmount();
      previousFocus = document.activeElement;
      show(0);
    },
    refresh() {
      const step = currentStep();
      if (!step || !overlay) return;
      scrolled = false;
      markTarget(step.target);
      measure();
      startWatch();
    },
    destroy() {
      unmount();
    },
    step() {
      return index;
    },
  };
}
