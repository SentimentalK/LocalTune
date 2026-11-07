/**
 * Low-power playback gate. Pure bookkeeping: the UI feeds long-task, frame-gap
 * and audio-stall signals, then asks `verdict` whether to enter or leave the
 * reduced-motion playback mode. No DOM, no timers, no store.
 */

export const LOW_POWER_WINDOW_MS = 10_000;
export const LOW_POWER_TASK_MS = 100;
export const LOW_POWER_HITS = 2;
export const LOW_POWER_FRAME_GAP_MS = 80;
export const LOW_POWER_FRAME_STREAK = 5;
export const LOW_POWER_MIN_ACTIVE_MS = 30_000;

export function createLowPowerGate({
  windowMs = LOW_POWER_WINDOW_MS,
  thresholdMs = LOW_POWER_TASK_MS,
  hits = LOW_POWER_HITS,
  frameGapMs = LOW_POWER_FRAME_GAP_MS,
  frameStreak = LOW_POWER_FRAME_STREAK,
  minActiveMs = LOW_POWER_MIN_ACTIVE_MS,
} = {}) {
  let longTasks = [];
  let events = [];
  let streak = 0;

  function prune(now) {
    const floor = now - windowMs;
    longTasks = longTasks.filter((at) => at >= floor);
    events = events.filter((at) => at >= floor);
  }

  /** Record a long task; true when the window has seen enough of them. */
  function noteLongTask(duration, now) {
    if (duration > thresholdMs) {
      longTasks.push(now);
      prune(now);
      if (longTasks.length >= hits) {
        longTasks = [];
        events.push(now);
        return true;
      }
    }
    return false;
  }

  /** Record a rAF gap; true once the gap streak reaches the threshold. */
  function noteFrameGap(gap, now) {
    if (gap > frameGapMs) streak += 1;
    else streak = 0;
    if (streak >= frameStreak) {
      streak = 0;
      events.push(now);
      return true;
    }
    return false;
  }

  /** Record an audio stall (waiting / stalled); always a trigger. */
  function noteAudio(now) {
    events.push(now);
    return true;
  }

  /** Live trigger count inside the window, after dropping expired records. */
  function count(now) {
    prune(now);
    return events.length;
  }

  /**
   * 'enter' while inactive with a live trigger, 'exit' once the window is empty
   * and the mode has been on for the minimum stretch, otherwise null.
   */
  function verdict(now, active, activeSince) {
    const live = count(now);
    if (live === 0 && active && now - activeSince >= minActiveMs) return 'exit';
    if (!active && live > 0) return 'enter';
    return null;
  }

  function clear() {
    longTasks = [];
    events = [];
    streak = 0;
  }

  return { noteLongTask, noteFrameGap, noteAudio, count, verdict, clear };
}
