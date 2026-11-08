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

// Prototype: how much record time one full hand turn of the platter covers.
export const SECONDS_PER_TURN = 10;
// Drag radius (fraction of the disc radius) where a grab turns into a scrub.
// Inside this circle the stage keeps its horizontal swipe for track changes.
export const SCRUB_START_RADIUS = 0.45;
const SCRUB_SLOP = 6;
const INERTIA_MS = 200;
const INERTIA_MIN = 0.04; // deg/ms below which the release has no fling

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
 *   getPlaying?: () => boolean,
 *   onToggle: () => void,
 *   onSeek: (seconds: number) => void,
 *   onPause: () => void,
 *   onResume: () => void,
 *   onSeekPreview?: (seconds: number, delta: number) => void,
 *   onScrubEnd?: () => void,
 *   onRestore?: (seconds: number) => void,
 *   onPress?: () => void,
 * }} options
 */
export function bindTonearm({
  svg,
  rotor,
  handle,
  getProgress,
  getDuration,
  getPosition,
  getPlaying,
  onToggle,
  onSeek,
  onPause,
  onResume,
  onSeekPreview,
  onScrubEnd,
  onRestore,
  onPress,
}) {
  let drag = null;
  let dragging = false;

  const deck = svg.closest?.('.deck') ?? null;

  const setAngle = (angle, immediate) => {
    rotor.style.transform = `rotate(${angle.toFixed(3)}deg)`;
    svg.classList.toggle('is-tracking', Boolean(immediate));
  };

  /** The pivot in screen pixels, so tangential deltas are measured in px. */
  const pivotOnScreen = () => {
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return null;
    return {
      x: ctm.a * PIVOT.x + ctm.c * PIVOT.y + ctm.e,
      y: ctm.b * PIVOT.x + ctm.d * PIVOT.y + ctm.f,
    };
  };

  const resetDrag = () => {
    if (!drag) return;
    drag = null;
    dragging = false;
    svg.classList.remove('grabbing', 'is-seek');
    deck?.classList.remove('is-arm-seek');
    onScrubEnd?.();
    listening = false;
    document.removeEventListener('pointermove', onDocMove);
    document.removeEventListener('pointerup', onDocUp);
    document.removeEventListener('pointercancel', onDocCancel);
    document.removeEventListener('touchmove', onDocTouchMove, { passive: false });
  };

  const start = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    // Any new press clears a drag that never got its pointerup, even when the
    // target is not the arm itself.
    resetDrag();
    const target = event.target.closest?.('.arm-handle');
    if (!target) return;
    event.preventDefault();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      angle: measuredAngle(svg, event),
      progress: getProgress(),
      pivot: pivotOnScreen(),
      radius: 0,
      moved: false,
      fromPlaying: Boolean(getPlaying?.()),
      fromPosition: getPosition(),
    };
    svg.classList.add('grabbing');
    listenDrag(true);
    onPress?.();
  };

  const move = (event) => {
    if (!drag || event.pointerId !== drag.id) return;

    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= DRAG_SLOP) return;
      drag.moved = true;
      dragging = true;
      // Lifting the needle pauses the audio. A record that was actually
      // turning keeps its platter turning while the arm is moved.
      if (drag.fromPlaying) {
        onPause();
        deck?.classList.add('is-arm-seek');
      }
      svg.classList.add('is-seek');
      // Re-seed at the slop boundary so the first stray pixels of the press
      // do not lurch the arm.
      drag.angle = measuredAngle(svg, event);
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.pivot) {
        drag.radius = Math.max(
          48,
          Math.hypot(event.clientX - drag.pivot.x, event.clientY - drag.pivot.y),
        );
      }
      return;
    }

    // Tangential projection: only the part of the finger travel that lies
    // along the arc counts. Moving toward or away from the pivot no longer
    // jumps the progress the way the old direct angle mapping did.
    const theta = (drag.angle * Math.PI) / 180;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const radius = drag.radius || 48;
    const dAngle = (-dx * Math.cos(theta) - dy * Math.sin(theta)) / radius;
    const degrees = (dAngle * 180) / Math.PI;
    drag.angle += degrees;
    drag.progress = clamp(drag.progress + degrees / M_SPAN, 0, 1);

    const seconds = drag.progress * getDuration();
    setAngle(angleForProgress(drag.progress), true);
    if (onSeekPreview) onSeekPreview(seconds, seconds - drag.fromPosition);
    else onSeek(seconds);
  };

  const finish = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.id) return;
    const active = drag;
    drag = null;
    dragging = false;
    listenDrag(false);
    svg.classList.remove('grabbing', 'is-seek');
    deck?.classList.remove('is-arm-seek');
    // Tap or drag, the gesture is over: let the hint re-evaluate.
    onScrubEnd?.();

    if (!active.moved) {
      onToggle();
      return;
    }

    if (cancelled) {
      // Put the needle back and restore whatever the deck was doing.
      if (onRestore) onRestore(active.fromPosition);
      else onSeek(active.fromPosition);
      if (active.fromPlaying) onResume();
      return;
    }

    // Dropping the arm onto the record starts playback, whether the drag
    // began playing or paused. Both calls run inside the pointer task so iOS
    // keeps the user activation that `play()` needs.
    onSeek(active.progress * getDuration());
    onResume();
  };

  // The pointer can leave the SVG path mid-drag; the move/up handlers live on
  // the document while a drag is live, and touchmove stays non-passive so iOS
  // cannot turn the gesture into a scroll.
  const onDocMove = (event) => move(event);
  const onDocUp = (event) => finish(event);
  const onDocCancel = (event) => finish(event, true);
  const onDocTouchMove = (event) => {
    if (drag) event.preventDefault();
  };
  let listening = false;
  function listenDrag(on) {
    if (on === listening) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointermove', onDocMove);
    document[method]('pointerup', onDocUp);
    document[method]('pointercancel', onDocCancel);
    document[method]('touchmove', onDocTouchMove, { passive: false });
  }

  svg.addEventListener('pointerdown', start);

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
      listenDrag(false);
      resetDrag();
      svg.removeEventListener('pointerdown', start);
      handle.removeEventListener('keydown', key);
      hub?.removeEventListener('click', hubClick);
    },
  };
}

/** Wrap a screen-space angle delta into (-180, 180] degrees. */
export function wrapDegrees(delta) {
  const value = (((delta + 180) % 360) + 360) % 360 - 180;
  return value === -180 ? 180 : value;
}

/** Record target for a cumulative platter rotation, clamped to the track. */
export function platterTarget(from, degrees, duration) {
  return clamp(from + (degrees / 360) * SECONDS_PER_TURN, 0, duration);
}

/**
 * Grab-the-record scrubbing. A pointer that lands on the vinyl outside the
 * inner `SCRUB_START_RADIUS` circle claims the gesture (the stage swipe skips
 * any event whose default was prevented); inside that circle the stage keeps
 * its horizontal track change. One full turn covers `SECONDS_PER_TURN`.
 *
 * @param {HTMLElement} vinyl the disc element
 * @param {{
 *   getDuration: () => number,
 *   getPosition: () => number,
 *   getPlaying?: () => boolean,
 *   onResume?: () => void,
 *   onPaint?: (seconds: number, delta: number) => void,
 *   onPreview?: (seconds: number) => void,
 *   onCommit: (seconds: number) => void,
 *   onRotate?: (degrees: number) => void,
 *   readRotation?: () => number,
 *   onEnd?: () => void,
 *   onRestore?: (seconds: number) => void,
 *   onPress?: () => void,
 *   onScrubStart?: () => void,
 *   onScratchMove?: (info: { direction: number, speed: number }) => void,
 *   onScratchEnd?: () => void,
 * }} options
 */
export function bindPlatterScrub(
  vinyl,
  { getDuration, getPosition, getPlaying, onResume, onPaint, onPreview, onCommit, onRotate, readRotation, onEnd, onRestore, onPress, onScrubStart, onScratchMove, onScratchEnd },
) {
  let gesture = null;
  let inertiaFrame = 0;
  let inertia = null;

  const deck = vinyl.closest?.('.deck') ?? null;

  // Past either end of the record the hand keeps turning but only a third of
  // that angle shows, so the platter never snaps at the start or the end.
  const DAMP = 1 / 3;

  /**
   * Raw gesture angle -> damped visual angle -> clamped seconds. `degrees`
   * itself is never rewritten: it is the true accumulated hand rotation, so
   * releasing and grabbing again is continuous.
   */
  const measure = (state, duration) => {
    const min = ((0 - state.from) / SECONDS_PER_TURN) * 360;
    const max = ((duration - state.from) / SECONDS_PER_TURN) * 360;
    let visual = state.degrees;
    if (visual < min) visual = min + (visual - min) * DAMP;
    else if (visual > max) visual = max + (visual - max) * DAMP;
    return { seconds: platterTarget(state.from, visual, duration), visual };
  };

  /** Paint the wrapper at its pre-gesture offset plus the gesture angle. */
  const rotate = (state, duration) => {
    const { seconds, visual } = measure(state, duration);
    onRotate?.(state.rotorOffset + visual);
    return seconds;
  };

  /**
   * Land the needle: commit the target through the store, then (optionally)
   * start playback. `play` runs in the same pointer task as the release, which
   * is what iOS requires for an allowed `audio.play()`.
   */
  const settle = (state, { play, end }) => {
    const seconds = rotate(state, getDuration());
    onPaint?.(seconds, seconds - state.from);
    onCommit(seconds);
    if (play) onResume?.();
    if (end) {
      deck?.classList.remove('is-disc-scrub');
      onEnd?.();
    }
  };

  const finishInertia = () => {
    if (!inertia) return;
    if (inertiaFrame) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = 0;
    }
    const pending = inertia;
    inertia = null;
    settle(pending.state, { play: false, end: true });
  };

  /**
   * Single exit path for every way a grab can end: pointerup, pointercancel,
   * lost capture, a new press, a remount, and the end of a fling. Clearing the
   * gesture class, the prototype flag, the document listeners, the scratch
   * sound and the HUD here means no exit path can strand the platter.
   */
  const resetGesture = ({ commitInertia = false } = {}) => {
    if (commitInertia) finishInertia();
    else if (inertiaFrame) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = 0;
      inertia = null;
    }
    gesture = null;
    deck?.classList.remove('is-disc-scrub');
    deck?.removeAttribute('data-scrub');
    listen(false);
    onScratchEnd?.();
    onEnd?.();
  };

  const start = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    // Any new press wins over a gesture that never got its pointerup, even a
    // press this handler is about to reject (inner circle, button, ...).
    resetGesture({ commitInertia: true });
    if (event.target.closest?.('.tonearm-svg, button, a, input')) return;
    const duration = getDuration();
    if (!(duration > 0)) return;
    const rect = vinyl.getBoundingClientRect();
    if (!rect.width) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const distance = Math.hypot(dx, dy);
    const radius = rect.width / 2;
    if (distance < radius * SCRUB_START_RADIUS || distance > radius * 1.08) return;

    listen(true);
    onPress?.();

    // Claim the event before the stage's swipe listener sees it.
    event.preventDefault();
    gesture = {
      id: event.pointerId,
      cx,
      cy,
      x: event.clientX,
      y: event.clientY,
      angle: Math.atan2(dy, dx),
      lastT: event.timeStamp,
      velocity: 0,
      degrees: 0,
      rotorOffset: Number(readRotation?.()) || 0,
      moved: false,
      from: clamp(getPosition(), 0, duration),
      fromPlaying: Boolean(getPlaying?.()),
    };
    // Prototype hook for the touch self-test: presence means a press is held.
    deck?.setAttribute('data-scrub', '1');
  };

  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!gesture.moved) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= SCRUB_SLOP) return;
      gesture.moved = true;
      deck?.classList.add('is-disc-scrub');
      onScrubStart?.();
    }

    const angle = Math.atan2(event.clientY - gesture.cy, event.clientX - gesture.cx);
    const delta = wrapDegrees(((angle - gesture.angle) * 180) / Math.PI);
    gesture.angle = angle;
    const elapsed = Math.max(1, event.timeStamp - gesture.lastT);
    gesture.lastT = event.timeStamp;
    gesture.velocity = gesture.velocity * 0.6 + (delta / elapsed) * 0.4;
    gesture.degrees += delta;
    onScratchMove?.({
      direction: gesture.degrees === 0 ? Math.sign(delta) : Math.sign(gesture.degrees),
      speed: Math.abs(gesture.velocity),
    });

    const seconds = rotate(gesture, getDuration());
    onPaint?.(seconds, seconds - gesture.from);
    onPreview?.(seconds);
  };

  const finish = (event, cancelled = false) => {
    const active = gesture;
    if (active && event.pointerId !== active.id) return;
    // pointerup / pointercancel / lost capture always run the single reset,
    // even when no gesture is live: a stranded class cannot survive this.
    resetGesture();
    if (!active || !active.moved) return;

    if (cancelled) {
      // Back to the pre-gesture position, rotation and play state.
      onRotate?.(active.rotorOffset);
      if (onRestore) onRestore(active.from);
      else onCommit(active.from);
      if (active.fromPlaying) onResume?.();
      return;
    }

    // Letting go of the record starts playback, whether the grab began while
    // playing or paused. Seek then play, synchronously in the pointerup task.
    settle(active, { play: true, end: false });
    if (Math.abs(active.velocity) < INERTIA_MIN) {
      onEnd?.();
      return;
    }

    // A short fling: the platter keeps turning for 200ms on the release angular
    // velocity. Playback already started; only the final needle drop is
    // committed at the end (a seek needs no user activation).
    const startedAt = performance.now();
    const startDegrees = active.degrees;
    const extra = active.velocity * INERTIA_MS * 0.5;
    const pending = { state: active };
    inertia = pending;
    const step = (now) => {
      if (inertia !== pending) return;
      const progress = Math.min((now - startedAt) / INERTIA_MS, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      active.degrees = startDegrees + extra * eased;
      const seconds = rotate(active, getDuration());
      onPaint?.(seconds, seconds - active.from);
      if (progress < 1) {
        inertiaFrame = requestAnimationFrame(step);
        return;
      }
      inertiaFrame = 0;
      inertia = null;
      settle(active, { play: false, end: true });
    };
    inertiaFrame = requestAnimationFrame(step);
  };

  // A touch pointer can leave the vinyl (or lose capture) mid-gesture, so the
  // move/up handlers live on the document and are attached only while a grab
  // is active. touchmove is non-passive to keep iOS from starting a scroll.
  const onDocMove = (event) => move(event);
  const onDocUp = (event) => finish(event);
  const onDocCancel = (event) => finish(event, true);
  const onDocTouchMove = (event) => {
    if (gesture) event.preventDefault();
  };
  let listening = false;
  function listen(on) {
    if (on === listening) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointermove', onDocMove);
    document[method]('pointerup', onDocUp);
    document[method]('pointercancel', onDocCancel);
    document[method]('lostpointercapture', onDocCancel);
    document[method]('touchmove', onDocTouchMove, { passive: false });
  }

  vinyl.addEventListener('pointerdown', start);

  return {
    isScrubbing: () => Boolean(gesture) || Boolean(inertia),
    destroy() {
      resetGesture({ commitInertia: true });
      vinyl.removeEventListener('pointerdown', start);
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
    // A platter scrub prevented the press; never turn it into a track change.
    if (event.defaultPrevented) return;
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
