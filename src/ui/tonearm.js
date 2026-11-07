/**
 * Tonearm geometry and gestures. The arm is both the play/pause control and
 * the seek rail: a tap toggles playback, a vertical drag maps the arm angle to
 * a position in the track. Pure geometry lives here so the mapping can be
 * unit-tested without a DOM.
 */

export const ARM_PARK = -32;
export const ARM_START = -20;
export const ARM_END = 15;
export const PIVOT = { x: 560, y: 75 };
// Measured pointer angle at the outer groove (p=0) and the angular span to the
// label (p=1). These are the angles the user actually points at, not the arm's
// rendered rotation range above.
export const M_START = 13.44;
export const M_SPAN = 35;

const DRAG_SLOP = 7;
const SWIPE_MIN = 48;
const SWIPE_RATIO = 1.4;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function angleForProgress(progress) {
  return ARM_START + (ARM_END - ARM_START) * clamp(progress, 0, 1);
}

export function progressFromAngle(angle) {
  return clamp((angle - M_START) / M_SPAN, 0, 1);
}

function svgPoint(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  return matrix ? point.matrixTransform(matrix.inverse()) : { x: PIVOT.x, y: PIVOT.y + 220 };
}

function measuredAngle(svg, event) {
  const point = svgPoint(svg, event);
  return (-Math.atan2(point.x - PIVOT.x, point.y - PIVOT.y) * 180) / Math.PI;
}

/**
 * @param {{
 *   svg: SVGSVGElement,
 *   rotor: SVGGElement,
 *   handle: SVGGElement,
 *   getProgress: () => number,
 *   getDuration: () => number,
 *   getPosition: () => number,
 *   onToggle: () => void,
 *   onSeek: (seconds: number) => void,
 *   onPause: () => void,
 *   onResume: () => void,
 *   onSeekPreview?: (seconds: number) => void,
 * }} options
 */
export function bindTonearm({
  svg,
  rotor,
  handle,
  getProgress,
  getDuration,
  getPosition,
  onToggle,
  onSeek,
  onPause,
  onResume,
  onSeekPreview,
}) {
  let drag = null;
  let dragging = false;

  const setAngle = (angle, immediate) => {
    rotor.style.transform = `rotate(${angle.toFixed(3)}deg)`;
    svg.classList.toggle('is-tracking', Boolean(immediate));
  };

  const start = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const target = event.target.closest?.('.arm-handle');
    if (!target) return;
    event.preventDefault();

    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Older Safari without pointer capture on SVG.
    }
    const pointed = progressFromAngle(measuredAngle(svg, event));
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      fromPlaying: false,
      fromPosition: getPosition(),
      offset: pointed - getProgress(),
    };
    svg.classList.add('grabbing');
  };

  const move = (event) => {
    if (!drag || event.pointerId !== drag.id) return;

    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > DRAG_SLOP) {
      drag.moved = true;
      dragging = true;
      drag.fromPlaying = false;
      svg.classList.add('is-seek');
      onPause();
    }
    if (!drag.moved) return;

    const progress = clamp(
      progressFromAngle(measuredAngle(svg, event)) - drag.offset,
      0,
      1,
    );
    const seconds = progress * getDuration();
    setAngle(angleForProgress(progress), true);
    if (onSeekPreview) onSeekPreview(seconds);
    else onSeek(seconds);
  };

  const finish = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.id) return;
    const active = drag;
    drag = null;
    dragging = false;
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {
      // Nothing captured.
    }
    svg.classList.remove('grabbing', 'is-seek');

    if (!active.moved) {
      onToggle();
      return;
    }

    if (cancelled) {
      onSeek(active.fromPosition);
      return;
    }

    onSeek(getPosition());
    // Releasing a drag starts playback, matching the design's arm behaviour.
    onResume();
  };

  svg.addEventListener('pointerdown', start);
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', (event) => finish(event));
  svg.addEventListener('pointercancel', (event) => finish(event, true));

  const hub = svg.querySelector('.hub-hit');
  const hubClick = (event) => {
    event.preventDefault();
    onToggle();
  };
  hub?.addEventListener('click', hubClick);

  const key = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const duration = getDuration();
    if (duration <= 0) return;
    const step = Math.max(2, duration * 0.02);
    const next = clamp(getPosition() + (event.key === 'ArrowRight' ? step : -step), 0, duration);
    onSeek(next);
    setAngle(angleForProgress(next / duration), true);
  };
  handle.addEventListener('keydown', key);

  return {
    isDragging: () => dragging,
    setAngle,
    destroy() {
      svg.removeEventListener('pointerdown', start);
      svg.removeEventListener('pointermove', move);
      handle.removeEventListener('keydown', key);
      hub?.removeEventListener('click', hubClick);
    },
  };
}

/**
 * Horizontal swipe on the stage: right = previous, left = next. Starts outside
 * the tonearm so an arm drag never turns into a track change. Vertical motion
 * is left to the page scroller.
 */
export function bindStageSwipe(stage, { onPrev, onNext }) {
  let gesture = null;

  const start = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest?.('.tonearm-svg, .panel, button, input, a')) return;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      axis: null,
    };
  };

  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(dx, dy) > 12) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO ? 'x' : 'y';
    }
    if (gesture.axis === 'x' && Math.abs(dx) > SWIPE_MIN) {
      const direction = dx > 0 ? -1 : 1;
      gesture = null;
      if (direction < 0) onPrev();
      else onNext();
    }
  };

  const end = () => {
    gesture = null;
  };

  stage.addEventListener('pointerdown', start);
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  return {
    destroy() {
      stage.removeEventListener('pointerdown', start);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', end);
      stage.removeEventListener('pointercancel', end);
    },
  };
}
