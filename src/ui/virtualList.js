/**
 * Windowed rendering for the track lists. List rows are equal-height, so the
 * visible slice is arithmetic: a window of rows plus top/bottom padding that
 * keeps the scrollable height stable. The pure helpers below never touch the
 * DOM; `createVirtualizer` is the thin controller the UI mounts per list.
 */

/** Clamp `value` into `[low, high]`. */
function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

const EMPTY_WINDOW = { start: 0, end: 0, padTop: 0, padBottom: 0 };

/**
 * Rows that fit in the viewport plus its overscan, rounded up so a partially
 * visible row still counts. Invalid inputs yield 0.
 */
export function windowCapacity({ viewportHeight, stride, overscanScreens = 1 } = {}) {
  if (!Number.isFinite(viewportHeight) || viewportHeight < 0) return 0;
  if (!Number.isFinite(stride) || stride <= 0) return 0;
  if (!Number.isFinite(overscanScreens) || overscanScreens < 0) return 0;
  return Math.ceil((viewportHeight * (1 + 2 * overscanScreens)) / stride);
}

/**
 * Small lists are cheaper to render whole; only window once the list is at
 * least twice the capacity (so a full screen of scrolling stays allocated).
 */
export function shouldVirtualize({ count, viewportHeight, stride, overscanScreens = 1 } = {}) {
  if (!Number.isFinite(count) || count <= 0) return false;
  const capacity = windowCapacity({ viewportHeight, stride, overscanScreens });
  if (capacity <= 0) return false;
  return count > 2 * capacity;
}

/**
 * Visible row range for a list scrolled to `viewportTop`, plus the padding that
 * stands in for the rows outside it. Always satisfies
 * `padTop + (end - start) * stride + padBottom === count * stride`.
 */
export function computeWindow({
  count,
  stride,
  viewportTop,
  viewportHeight,
  overscanScreens = 1,
} = {}) {
  const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (total <= 0) return { ...EMPTY_WINDOW };
  if (!Number.isFinite(stride) || stride <= 0) return { ...EMPTY_WINDOW };
  if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportHeight)) {
    return { ...EMPTY_WINDOW };
  }
  const overscan = Number.isFinite(overscanScreens) && overscanScreens > 0 ? overscanScreens : 0;
  const pad = viewportHeight * overscan;
  const top = viewportTop - pad;
  const bottom = viewportTop + viewportHeight + pad;
  const start = clamp(Math.floor(top / stride), 0, total);
  const end = clamp(Math.ceil(bottom / stride), start, total);
  return { start, end, padTop: start * stride, padBottom: (total - end) * stride };
}

/**
 * Mount a virtualizer on an already-attached `.track-list`.
 *
 * `renderRow(index, coverIds)` builds one row and pushes any cover id it takes
 * from the store into `coverIds`, so this controller can hand them back through
 * `releaseCover` when the window moves. `getViewport()` returns the visible
 * slice in the list's own content coordinates, which lets the same controller
 * serve a scrolling panel (desktop) and the page (mobile).
 */
export function createVirtualizer({
  container,
  count,
  estimateStride,
  getViewport,
  renderRow,
  releaseCover = () => {},
}) {
  const strideEstimate = Number.isFinite(estimateStride) && estimateStride > 0 ? estimateStride : 0;
  const rowGap = () => {
    const gap = parseFloat(getComputedStyle(container).rowGap);
    return Number.isFinite(gap) ? gap : 2;
  };

  const gap = rowGap();
  let stride = strideEstimate > 0 ? strideEstimate + gap : 0;
  let virtual = false;
  let hidden = false;
  let coverIds = [];
  let range = { start: 0, end: 0 };
  let measured = false;
  let disposed = false;

  function releaseCoverIds() {
    // Swap the array out first: a release that throws must not leave the same
    // ids queued up for a second release.
    const ids = coverIds;
    coverIds = [];
    for (const id of ids) {
      try {
        releaseCover(id);
      } catch {
        // A cover that fails to release must not break list rendering.
      }
    }
  }

  function paint(window) {
    // Build the new window first: the old rows stay alive (and their cover
    // URLs unrevoked) until the new nodes are in the document, so a window
    // swap can never leave an <img> pointing at a revoked object URL.
    const oldIds = coverIds;
    coverIds = [];
    const ids = [];
    // Track ids as they are produced, so a throwing `renderRow` still leaves
    // them owned by this window (released exactly once, later).
    coverIds = ids;
    const nodes = [];
    for (let index = window.start; index < window.end; index += 1) {
      nodes.push(renderRow(index, ids));
    }
    container.replaceChildren(...nodes);
    container.style.paddingTop = window.padTop ? `${window.padTop}px` : '';
    container.style.paddingBottom = window.padBottom ? `${window.padBottom}px` : '';
    range = { start: window.start, end: window.end };
    // Each old id is handed back exactly once, from the local list.
    for (const id of oldIds) {
      try {
        releaseCover(id);
      } catch {
        // A cover that fails to release must not break list rendering.
      }
    }
  }

  function paintAll() {
    virtual = false;
    hidden = false;
    paint({ start: 0, end: count, padTop: 0, padBottom: 0 });
  }

  function paintWindow(viewport) {
    virtual = true;
    hidden = false;
    paint(
      computeWindow({
        count,
        stride,
        viewportTop: viewport.top,
        viewportHeight: viewport.height,
      }),
    );
  }

  /**
   * The list is inside a hidden panel (desktop settings view, closed mobile
   * overlay): it has no measurable viewport, so render no rows at all and let
   * padding hold the scroll height until a resize brings a real height back.
   */
  function paintHidden() {
    virtual = true;
    hidden = true;
    paint({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: stride > 0 ? count * stride : 0,
    });
  }

  /** Adopt the real row height when it differs from the estimate. */
  function measureStride() {
    const first = container.firstElementChild;
    if (!first) return false;
    const height = first.getBoundingClientRect().height;
    if (!(height > 0)) return false;
    const next = height + gap;
    if (Math.abs(next - stride) <= 0.5) return false;
    stride = next;
    return true;
  }

  function wantsWindow(viewport) {
    return shouldVirtualize({ count, viewportHeight: viewport.height, stride });
  }

  // ---- initial paint -------------------------------------------------------
  const initialViewport = getViewport();
  if (!(initialViewport.height > 0)) {
    // Hidden panel: nothing may be measured or rendered whole.
    paintHidden();
  } else if (wantsWindow(initialViewport) && stride > 0) {
    paintWindow(initialViewport);
    if (!measured) {
      measured = true;
      // One corrective pass only; `measured` keeps a re-measure loop out.
      if (measureStride()) paintWindow(initialViewport);
    }
  } else {
    paintAll();
  }

  return {
    /**
     * Re-read the viewport. Returns true only when the DOM was rebuilt.
     */
    refresh() {
      if (disposed) return false;
      if (stride <= 0) return false;
      const viewport = getViewport();
      if (!(viewport.height > 0)) {
        if (hidden) return false;
        paintHidden();
        return true;
      }
      hidden = false;
      if (!virtual) {
        if (!wantsWindow(viewport)) return false;
        paintWindow(viewport);
        if (measureStride()) paintWindow(viewport);
        return true;
      }
      if (!wantsWindow(viewport)) {
        paintAll();
        return true;
      }
      const remeasured = measureStride();
      const window = computeWindow({
        count,
        stride,
        viewportTop: viewport.top,
        viewportHeight: viewport.height,
      });
      if (!remeasured && window.start === range.start && window.end === range.end) {
        return false;
      }
      paint(window);
      return true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      releaseCoverIds();
      container.style.paddingTop = '';
      container.style.paddingBottom = '';
      virtual = false;
      hidden = false;
      range = { start: 0, end: 0 };
    },

    get range() {
      return { start: range.start, end: range.end };
    },
  };
}
