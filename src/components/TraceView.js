import * as d3 from 'd3';
import {
  schemeTableau10,
  formatSize,
  formatAddr,
  formatFrames,
  formatForwardFrames,
  formatUserMetadata,
  frameFilter,
  isPythonFrame,
  isUnknownFrame,
  isCppFrame,
} from '../core/index.js';

/**
 * Process allocation data for trace view
 */
function processAllocData(snapshot, device, plotSegments, maxEntries) {
  const elements = [];
  const initiallyAllocated = [];
  const actions = [];
  const addrToAlloc = {};

  const alloc = plotSegments ? 'segment_alloc' : 'alloc';
  const [free, freeCompleted] = plotSegments
    ? ['segment_free', 'segment_free']
    : ['free', 'free_completed'];

  for (const e of snapshot.device_traces[device]) {
    switch (e.action) {
      case alloc:
        elements.push(e);
        addrToAlloc[e.addr] = elements.length - 1;
        actions.push(elements.length - 1);
        break;
      case free:
      case freeCompleted:
        if (e.addr in addrToAlloc) {
          actions.push(addrToAlloc[e.addr]);
          delete addrToAlloc[e.addr];
        } else {
          elements.push(e);
          initiallyAllocated.push(elements.length - 1);
          actions.push(elements.length - 1);
        }
        break;
      default:
        break;
    }
  }

  for (const seg of snapshot.segments) {
    if (seg.device !== device) {
      continue;
    }
    if (plotSegments) {
      if (!(seg.address in addrToAlloc)) {
        const element = {
          action: 'alloc',
          addr: seg.address,
          size: seg.total_size,
          frames: [],
          stream: seg.stream,
          version: seg.version,
        };
        elements.push(element);
        initiallyAllocated.push(elements.length - 1);
      }
    } else {
      for (const b of seg.blocks) {
        if (b.state === 'active_allocated' && !(b.addr in addrToAlloc)) {
          const element = {
            action: 'alloc',
            addr: b.addr,
            size: b.requested_size,
            frames: b.frames,
            stream: seg.stream,
            version: b.version,
          };
          elements.push(element);
          initiallyAllocated.push(elements.length - 1);
        }
      }
    }
  }

  initiallyAllocated.reverse();

  if (actions.length === 0 && initiallyAllocated.length > 0) {
    actions.push(initiallyAllocated.pop());
  }

  const current = [];
  const currentData = [];
  const data = [];
  let maxSize = 0;

  let totalMem = 0;
  let totalSummarizedMem = 0;
  let timestep = 0;

  const maxAtTime = [];

  const summarizedMem = {
    elem: 'summarized',
    timesteps: [],
    offsets: [totalMem],
    size: [],
    color: 0,
  };
  const summarizedElems = {};

  function advance(n) {
    summarizedMem.timesteps.push(timestep);
    summarizedMem.offsets.push(totalMem);
    summarizedMem.size.push(totalSummarizedMem);
    timestep += n;
    for (let i = 0; i < n; i++) {
      maxAtTime.push(totalMem + totalSummarizedMem);
    }
  }

  const sizes = elements
    .map((x, i) => [x.size, i])
    .sort(([x], [y]) => y - x);

  const drawElem = {};
  for (const [, e] of sizes.slice(0, maxEntries)) {
    drawElem[e] = true;
  }

  function addAllocation(elem) {
    const elementObj = elements[elem];
    const size = elementObj.size;
    current.push(elem);
    let color = elem;
    if (snapshot.categories.length > 0) {
      color = snapshot.categories.indexOf(elementObj.category || 'unknown');
    }
    const e = {
      elem,
      timesteps: [timestep],
      offsets: [totalMem],
      size,
      color,
    };
    currentData.push(e);
    data.push(e);
    totalMem += size;
    elementObj.max_allocated_mem = totalMem + totalSummarizedMem;
  }

  for (const elem of initiallyAllocated) {
    if (elem in drawElem) {
      addAllocation(elem);
    } else {
      totalSummarizedMem += elements[elem].size;
      summarizedElems[elem] = true;
    }
  }

  for (const elem of actions) {
    const size = elements[elem].size;
    if (!(elem in drawElem)) {
      if (elem in summarizedElems) {
        advance(1);
        totalSummarizedMem -= size;
        summarizedElems[elem] = null;
      } else {
        totalSummarizedMem += size;
        summarizedElems[elem] = true;
        advance(1);
      }
      continue;
    }
    const idx = current.findLastIndex((x) => x === elem);
    if (idx === -1) {
      addAllocation(elem);
      advance(1);
    } else {
      advance(1);
      const removed = currentData[idx];
      removed.timesteps.push(timestep);
      removed.offsets.push(removed.offsets.at(-1));
      current.splice(idx, 1);
      currentData.splice(idx, 1);

      if (idx < current.length) {
        for (let j = idx; j < current.length; j++) {
          const e = currentData[j];
          e.timesteps.push(timestep);
          e.offsets.push(e.offsets.at(-1));
          e.timesteps.push(timestep + 3);
          e.offsets.push(e.offsets.at(-1) - size);
        }
        advance(3);
      }
      totalMem -= size;
    }
    maxSize = Math.max(totalMem + totalSummarizedMem, maxSize);
  }

  for (const elem of currentData) {
    elem.timesteps.push(timestep);
    elem.offsets.push(elem.offsets.at(-1));
  }
  data.push(summarizedMem);

  return {
    max_size: maxSize,
    allocations_over_time: data,
    max_at_time: maxAtTime,
    summarized_mem: summarizedMem,
    elements_length: elements.length,
    /**
     * Return structured context data for a given allocation element ID.
     * The returned object has the following shape:
     * {
     *   metadata: Array<{label, value}>,   // key-value metadata rows
     *   isFreeOnly: boolean,               // true when alloc was not recorded
     *   hasFrames: boolean,                 // false when frames is empty
     *   noFramesText: string|null,          // explanation text when no frames
     *   frames: Array<{filename, line, name, type, fxInfo, originalTrace}>,
     *   userMetadata: string|null,          // formatted user metadata
     *   forwardFrames: string|null,         // formatted forward frames text
     * }
     */
    context_for_id: (id) => {
      const elem = elements[id];

      // -- Build metadata rows --
      const metadata = [];
      metadata.push({ label: 'Address', value: formatAddr(elem) });
      metadata.push({ label: 'Size', value: formatSize(elem.size) });
      metadata.push({ label: 'Total mem after alloc', value: formatSize(elem.max_allocated_mem) });
      metadata.push({ label: 'Compile context', value: elem?.compile_context ?? 'None' });
      if (elem.stream !== null) {
        metadata.push({ label: 'Stream', value: String(elem.stream) });
      }
      if (elem.timestamp !== null) {
        const d = new Date(elem.time_us / 1000);
        metadata.push({ label: 'Timestamp', value: d.toString() });
      }

      const isFreeOnly = !elem.action.includes('alloc');
      const hasFrames = elem.frames.length > 0;

      // -- Classify frames --
      let classifiedFrames = [];
      let noFramesText = null;
      if (!hasFrames) {
        noFramesText = formatFrames([]);
      } else {
        classifiedFrames = elem.frames
          .filter(frameFilter)
          .map(f => {
            let type = 'cpp';
            if (isPythonFrame(f)) type = 'python';
            else if (isUnknownFrame(f)) type = 'unknown';

            let fxInfo = null;
            if (f.fx_node_op || f.fx_node_name || f.fx_node_target) {
              const parts = [];
              if (f.fx_node_name) parts.push(`node=${f.fx_node_name}`);
              if (f.fx_node_op) parts.push(`op=${f.fx_node_op}`);
              if (f.fx_node_target) parts.push(`target=${f.fx_node_target}`);
              fxInfo = parts.join(', ');
            }
            let originalTrace = null;
            if (f.fx_original_trace) {
              originalTrace = f.fx_original_trace.trim();
            }

            return {
              filename: f.filename,
              line: f.line,
              name: f.name,
              type,
              fxInfo,
              originalTrace,
            };
          });
      }

      // -- User metadata --
      const userMetadataStr = formatUserMetadata(elem.user_metadata) || null;

      // -- Forward frames --
      const forwardFramesStr = (elem.forward_frames && elem.forward_frames.length > 0)
        ? elem.forward_frames.join('').trimEnd()
        : null;

      return {
        metadata,
        isFreeOnly,
        hasFrames,
        noFramesText,
        frames: classifiedFrames,
        userMetadata: userMetadataStr,
        forwardFrames: forwardFramesStr,
      };
    },
  };
}

/**
 * MemoryPlot — Canvas 2D implementation (replaces SVG).
 *
 * Architecture:
 *   - Main canvas: renders allocation polygons
 *   - Hit canvas: off-screen, each polygon painted with a unique RGB color for O(1) pick
 *   - Highlight canvas: on-screen overlay for selection highlight stroke
 *   - SVG overlay: Y-axis + Legend (cheap DOM, reuses d3.axisLeft)
 *
 * @returns {{ redraw, select_window, set_delegate, resize, getDataAtPixel }}
 */
function MemoryPlot(container, data, leftPad, colors = schemeTableau10) {
  const allocations = data.allocations_over_time;
  const maxTimestep = data.max_at_time.length;
  const maxSize = data.max_size;

  // Vertical padding (px) so top/bottom Y-axis tick labels are not clipped
  const yPad = 8;

  // ---- Scales (pixel ranges updated on resize) ----
  const xScale = d3.scaleLinear().domain([0, maxTimestep]);
  const yScale = d3.scaleLinear().domain([0, maxSize]);

  // ---- DOM setup ----
  // Wrapper that holds all layers
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  container.appendChild(wrapper);

  // Main canvas (data polygons)
  const mainCanvas = document.createElement('canvas');
  mainCanvas.style.cssText = `position:absolute;top:${yPad}px;left:${leftPad}px;`;
  wrapper.appendChild(mainCanvas);
  const mainCtx = mainCanvas.getContext('2d');

  // Highlight canvas (selection overlay)
  const hlCanvas = document.createElement('canvas');
  hlCanvas.style.cssText = `position:absolute;top:${yPad}px;left:${leftPad}px;pointer-events:none;`;
  wrapper.appendChild(hlCanvas);
  const hlCtx = hlCanvas.getContext('2d');

  // SVG overlay for Y-axis (positioned at left:0)
  const axisSvg = d3
    .select(wrapper)
    .append('svg')
    .style('position', 'absolute')
    .style('top', '0')
    .style('left', '0')
    .style('pointer-events', 'none')
    .style('overflow', 'visible');

  const axisGroup = axisSvg.append('g').attr('transform', `translate(${leftPad}, 0)`);
  const yAxis = d3.axisLeft(yScale).tickFormat((d) => formatSize(d, false));

  // ---- Precompute polygon path data for each allocation ----
  // Each allocation has { xs: number[], bottomYs: number[], topYs: number[] }
  // in data-space coordinates. We transform to pixel space during draw.
  function buildPathForAlloc(d) {
    const size = d.size;
    const xs = d.timesteps;
    const bottomYs = d.offsets;
    const topYs = Array.isArray(size)
      ? d.offsets.map((o, i) => o + size[i])
      : d.offsets.map((o) => o + size);
    return { xs, bottomYs, topYs };
  }

  const pathCache = allocations.map(buildPathForAlloc);

  // ---- Offscreen canvases for O(1) zoom (pre-rendered bitmaps) ----
  const offMainCanvas = document.createElement('canvas');
  const offMainCtx = offMainCanvas.getContext('2d');
  const offHitCanvas = document.createElement('canvas');
  const offHitCtx = offHitCanvas.getContext('2d', { willReadFrequently: true });
  offHitCtx.imageSmoothingEnabled = false;

  // ---- Current transform state (from d3.zoom and minimap brush) ----
  let currentTransform = d3.zoomIdentity;
  // Minimap scrub state: [xBegin, xEnd] in data-space and the max Y for that range
  let scrubXBegin = 0;
  let scrubXEnd = maxTimestep;
  let scrubYMax = maxSize;

  // Dirty flag: true when offscreen bitmaps are stale (need vector redraw)
  let offscreenDirty = true;
  // Debounce timer for deferred vector re-render after zoom
  let vectorRedrawTimer = null;
  // rAF handle for zoom throttling
  let zoomRafId = null;

  // ---- Effective scales (incorporating zoom + scrub) ----
  function effectiveXScale() {
    // Scrub selects a data-space x range; zoom further transforms it
    const scrubScale = d3
      .scaleLinear()
      .domain([scrubXBegin, scrubXEnd])
      .range(xScale.range());
    return currentTransform.rescaleX(scrubScale);
  }

  function effectiveYScale() {
    const s = d3.scaleLinear().domain([0, scrubYMax]).range(yScale.range());
    return currentTransform.rescaleY(s);
  }

  // ---- Drawing ----
  function drawPolygon(ctx, pathData, ex, ey) {
    const { xs, bottomYs, topYs } = pathData;
    const n = xs.length;
    if (n === 0) return;

    ctx.beginPath();
    // Bottom edge (left to right)
    ctx.moveTo(ex(xs[0]), ey(bottomYs[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(ex(xs[i]), ey(bottomYs[i]));
    }
    // Top edge (right to left)
    for (let i = n - 1; i >= 0; i--) {
      ctx.lineTo(ex(xs[i]), ey(topYs[i]));
    }
    ctx.closePath();
  }

  /**
   * Full vector redraw onto offscreen canvases, then blit to on-screen.
   * Called on init, resize, select_window, and after debounced zoom.
   */
  function vectorRedraw() {
    const w = mainCanvas.width;
    const h = mainCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    const ex = effectiveXScale();
    const ey = effectiveYScale();

    // Sync offscreen canvas sizes
    offMainCanvas.width = w;
    offMainCanvas.height = h;
    offMainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Hit canvas uses 1x resolution (no DPR scaling) so that thin polygons
    // still occupy at least 1 pixel tall. This drastically reduces
    // anti-aliasing artifacts that corrupt the color-coded index picking.
    const hitW = Math.round(w / dpr);
    const hitH = Math.round(h / dpr);
    offHitCanvas.width = hitW;
    offHitCanvas.height = hitH;
    offHitCtx.setTransform(1, 0, 0, 1, 0, 0);

    // --- Offscreen main canvas ---
    offMainCtx.clearRect(0, 0, w, h);
    for (let i = 0; i < allocations.length; i++) {
      const d = allocations[i];
      const color = colors[d.color % colors.length];
      drawPolygon(offMainCtx, pathCache[i], ex, ey);
      offMainCtx.fillStyle = color;
      offMainCtx.fill();
    }

    offscreenDirty = false;

    // Blit offscreen → on-screen
    blitToScreen();

    // --- Y-axis SVG ---
    const axisScale = d3
      .scaleLinear()
      .domain(ey.domain())
      .range([h / dpr + yPad, yPad]);
    axisGroup.call(yAxis.scale(axisScale));

    // --- Clear highlight ---
    hlCtx.clearRect(0, 0, w, h);
  }

  /**
   * Blit the pre-rendered offscreen main canvas onto the visible canvas.
   * Uses identity transform (1:1 pixel copy) — no scaling artifacts.
   */
  function blitToScreen() {
    const w = mainCanvas.width;
    const h = mainCanvas.height;
    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.clearRect(0, 0, w, h);
    mainCtx.drawImage(offMainCanvas, 0, 0);
    mainCtx.restore();
  }

  /**
   * Fast zoom blit: apply d3.zoom's relative transform to the pre-rendered
   * offscreen bitmap. This is O(1) — no polygon iteration.
   *
   * The key insight: the offscreen bitmap was rendered at a specific
   * "base transform" (zoomTransformAtRender). The current zoom is
   * currentTransform. The delta between them gives us the CSS-like
   * translate+scale to apply via drawImage.
   */
  let zoomTransformAtRender = d3.zoomIdentity;

  function zoomBlit() {
    const w = mainCanvas.width;
    const h = mainCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    // Compute relative transform: current vs. the transform when offscreen was rendered
    const base = zoomTransformAtRender;
    const cur = currentTransform;
    const relScale = cur.k / base.k;
    const relX = (cur.x - base.x * relScale) * dpr;
    const relY = (cur.y - base.y * relScale) * dpr;

    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.clearRect(0, 0, w, h);
    mainCtx.setTransform(relScale, 0, 0, relScale, relX, relY);
    mainCtx.drawImage(offMainCanvas, 0, 0);
    mainCtx.restore();

    // Update Y-axis to match current zoom
    const ey = effectiveYScale();
    const axisScale = d3
      .scaleLinear()
      .domain(ey.domain())
      .range([h / dpr + yPad, yPad]);
    axisGroup.call(yAxis.scale(axisScale));
  }

  /**
   * Schedule a deferred full vector redraw after zoom settles.
   * Clears any pending timer.
   */
  function scheduleVectorRedraw() {
    if (vectorRedrawTimer) clearTimeout(vectorRedrawTimer);
    vectorRedrawTimer = setTimeout(() => {
      vectorRedrawTimer = null;
      zoomTransformAtRender = currentTransform;
      offscreenDirty = true;
      vectorRedraw();
      highlightAlloc(highlightedIndex);
    }, 150);
  }

  // Backward-compatible alias used by resize / select_window
  function redraw() {
    zoomTransformAtRender = currentTransform;
    vectorRedraw();
  }

  // ---- Highlight a single allocation ----
  let highlightedIndex = -1;

  function highlightAlloc(index) {
    const w = hlCanvas.width;
    const h = hlCanvas.height;
    hlCtx.clearRect(0, 0, w, h);
    highlightedIndex = index;
    if (index < 0 || index >= allocations.length) return;

    const ex = effectiveXScale();
    const ey = effectiveYScale();
    const dpr = window.devicePixelRatio || 1;

    drawPolygon(hlCtx, pathCache[index], ex, ey);
    hlCtx.strokeStyle = '#6c8cff';
    hlCtx.lineWidth = 2 * dpr;
    hlCtx.stroke();
  }

  // ---- Pixel → allocation lookup ----
  /**
   * Look up which allocation (if any) sits at a given canvas-space pixel.
   *
   * Uses **geometric search** in data space: convert the pixel coordinate to
   * data-space (timestep, byte-offset) via the inverse of the current scales,
   * then scan allocations to find one whose [bottomY, topY] range at that
   * timestep contains the target byte-offset.
   *
   * This approach is immune to Canvas 2D anti-aliasing artefacts that plague
   * colour-coded hit-canvas picking when thousands of thin polygons overlap.
   */
  function getDataAtPixel(canvasX, canvasY) {
    // If offscreen is dirty (zoom in progress), re-render first
    if (offscreenDirty) {
      zoomTransformAtRender = currentTransform;
      vectorRedraw();
      highlightAlloc(highlightedIndex);
    }

    const ex = effectiveXScale();
    const ey = effectiveYScale();

    // Convert pixel → data space
    const dataX = ex.invert(canvasX);   // timestep (float)
    const dataY = ey.invert(canvasY);   // byte-offset (float)

    if (dataY < 0) return null;

    // Search allocations in *reverse* draw order (top-most first) so that the
    // visually top-most polygon wins when polygons share a boundary pixel.
    for (let i = allocations.length - 1; i >= 0; i--) {
      const p = pathCache[i];
      const xs = p.xs;
      const n = xs.length;
      if (n === 0) continue;

      // Quick range check on X (timestep)
      if (dataX < xs[0] || dataX > xs[n - 1]) continue;

      // Binary search for the segment [xs[j], xs[j+1]] containing dataX
      let lo = 0, hi = n - 2;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dataX < xs[mid]) hi = mid - 1;
        else if (dataX > xs[mid + 1]) lo = mid + 1;
        else { lo = mid; break; }
      }
      const j = lo;
      if (j >= n - 1) continue;

      // Linearly interpolate bottomY and topY at dataX within [xs[j], xs[j+1]]
      const t = xs[j + 1] === xs[j] ? 0 : (dataX - xs[j]) / (xs[j + 1] - xs[j]);
      const bot = p.bottomYs[j] + t * (p.bottomYs[j + 1] - p.bottomYs[j]);
      const top = p.topYs[j] + t * (p.topYs[j + 1] - p.topYs[j]);

      if (dataY >= bot && dataY <= top) {
        return { index: i, allocation: allocations[i] };
      }
    }

    return null;
  }

  // ---- Zoom (O(1) blit during interaction, deferred vector redraw) ----
  const theZoom = d3
    .zoom()
    .scaleExtent([1, 100])
    .on('zoom', (event) => {
      currentTransform = event.transform;
      // Throttle to one repaint per animation frame
      if (!zoomRafId) {
        zoomRafId = requestAnimationFrame(() => {
          zoomRafId = null;
          zoomBlit();               // O(1) bitmap transform
          hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height); // clear stale highlight
        });
      }
      // Schedule a full vector redraw after zoom settles
      scheduleVectorRedraw();
    });

  // We attach zoom to the main canvas via d3
  d3.select(mainCanvas).call(theZoom);

  // ---- Resize ----
  function resize() {
    const rect = wrapper.getBoundingClientRect();
    const plotWidth = rect.width - leftPad;
    const plotHeight = rect.height - yPad * 2; // reserve top/bottom padding for Y-axis labels
    if (plotWidth <= 0 || plotHeight <= 0) return;

    const dpr = window.devicePixelRatio || 1;

    // Update scale ranges
    xScale.range([0, plotWidth]);
    yScale.range([plotHeight, 0]);

    // Main canvas
    mainCanvas.width = Math.round(plotWidth * dpr);
    mainCanvas.height = Math.round(plotHeight * dpr);
    mainCanvas.style.width = `${plotWidth}px`;
    mainCanvas.style.height = `${plotHeight}px`;
    mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Highlight canvas
    hlCanvas.width = mainCanvas.width;
    hlCanvas.height = mainCanvas.height;
    hlCanvas.style.width = `${plotWidth}px`;
    hlCanvas.style.height = `${plotHeight}px`;
    hlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // SVG overlay (covers full container for Y-axis at left)
    axisSvg.attr('width', rect.width).attr('height', rect.height);

    redraw();
    highlightAlloc(highlightedIndex);
  }

  // ---- select_window (called by MiniMap brush) ----
  function select_window(stepbegin, stepend, max) {
    scrubXBegin = stepbegin;
    scrubXEnd = stepend;
    scrubYMax = max;

    // Reset zoom transform when minimap brush changes
    currentTransform = d3.zoomIdentity;
    d3.select(mainCanvas).call(theZoom.transform, d3.zoomIdentity);

    redraw();
    highlightAlloc(highlightedIndex);
  }

  // ---- Delegate (mouse events → ContextViewer) ----
  function set_delegate(delegate) {
    // Track pointerdown position to distinguish click vs. drag.
    // We use pointer events (not mouse events) because d3.zoom captures
    // pointerdown and may preventDefault, which can suppress mouseup.
    let pointerDownPos = null;
    const CLICK_THRESHOLD = 3; // px

    mainCanvas.addEventListener('mousemove', (e) => {
      // During active zoom/drag, hit canvas may be stale — skip picking
      if (offscreenDirty) return;
      const rect = mainCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getDataAtPixel(x, y);
      if (hit) {
        delegate.set_selected(hit.index, hit.allocation);
        highlightAlloc(hit.index);
      } else {
        delegate.set_selected(-1, null);
        highlightAlloc(-1);
      }
    });

    mainCanvas.addEventListener('pointerdown', (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    });

    mainCanvas.addEventListener('pointerup', (e) => {
      if (!pointerDownPos) return;
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      pointerDownPos = null;

      // Only treat as "click" if mouse barely moved (not a drag/pan)
      if (dist > CLICK_THRESHOLD) return;

      const rect = mainCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getDataAtPixel(x, y);
      if (hit) {
        delegate.default_selected_index = hit.index;
        delegate.default_selected_alloc = hit.allocation;
        delegate.set_selected(hit.index, hit.allocation);
        highlightAlloc(hit.index);
      } else {
        delegate.default_selected_index = -1;
        delegate.default_selected_alloc = null;
        delegate.set_selected(-1, null);
        highlightAlloc(-1);
      }
    });

    mainCanvas.addEventListener('mouseleave', () => {
      pointerDownPos = null;
      delegate.set_selected(
        delegate.default_selected_index,
        delegate.default_selected_alloc,
      );
      highlightAlloc(delegate.default_selected_index);
    });
  }

  return {
    redraw,
    resize,
    select_window,
    set_delegate,
    getDataAtPixel,
    highlightAlloc,
  };
}

/**
 * Render structured context panel HTML into a container.
 *
 * Content types:
 *   A) Empty state         — no allocation selected
 *   B) Summarized block    — small tensors aggregated
 *   C) Full allocation     — metadata + frames (Python/C++/unknown)
 *   D) Free-only           — alloc not recorded, showing free stack
 *   E) No frames           — frames array was empty, show explanation
 */
function renderContextContent(container, contextData, elemId) {
  const root = container.node();
  root.innerHTML = '';

  const { metadata, isFreeOnly, hasFrames, noFramesText, frames, userMetadata, forwardFrames } = contextData;

  // -- Free-only badge will be inserted into the frame header below --

  // -- Metadata (compact inline layout, no collapsible wrapper) --
  const metaBar = document.createElement('div');
  metaBar.className = 'ctx-meta-bar';
  for (const { label, value } of metadata) {
    const span = document.createElement('span');
    span.className = 'ctx-meta-item';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-meta-label';
    lbl.textContent = label + ':';
    const val = document.createElement('span');
    val.className = 'ctx-meta-value';
    val.textContent = value;
    span.appendChild(lbl);
    span.appendChild(val);
    metaBar.appendChild(span);
  }
  root.appendChild(metaBar);

  // -- User Metadata (collapsible, default collapsed) --
  if (userMetadata) {
    const umSection = document.createElement('details');
    umSection.className = 'ctx-section';
    const umSummary = document.createElement('summary');
    umSummary.className = 'ctx-section-summary';
    umSummary.textContent = 'User Metadata';
    umSection.appendChild(umSummary);
    const umPre = document.createElement('pre');
    umPre.className = 'ctx-pre-block';
    umPre.textContent = userMetadata;
    umSection.appendChild(umPre);
    root.appendChild(umSection);
  }

  // -- Frames section --
  if (!hasFrames) {
    // Type E: No frames
    const noFrameCard = document.createElement('div');
    noFrameCard.className = 'ctx-no-frames-card';
    noFrameCard.textContent = noFramesText;
    root.appendChild(noFrameCard);
  } else {
    // Type C/D: Has frames — render as non-collapsible section
    const frameSection = document.createElement('div');
    frameSection.className = 'ctx-frame-section';

    // Header row: title + hide toggles + search box in one line
    const frameHeader = document.createElement('div');
    frameHeader.className = 'ctx-frame-header';

    const totalPy = frames.filter(f => f.type === 'python').length;
    const totalCpp = frames.filter(f => f.type === 'cpp').length;
    const totalUnknown = frames.filter(f => f.type === 'unknown').length;

    const frameTitle = document.createElement('span');
    frameTitle.className = 'ctx-frame-title';
    frameTitle.textContent = `Stack Trace (${frames.length})`;
    frameHeader.appendChild(frameTitle);

    // Free-only badge (Type D) — inline with header
    if (isFreeOnly) {
      const badge = document.createElement('span');
      badge.className = 'ctx-badge ctx-badge--warning';
      badge.textContent = '\u26A0 Alloc not recorded — showing free stack trace';
      frameHeader.appendChild(badge);
    }

    // Hide toggles inline with title
    const hideCppLabel = document.createElement('label');
    hideCppLabel.className = 'ctx-toggle-label';
    const hideCppCb = document.createElement('input');
    hideCppCb.type = 'checkbox';
    hideCppCb.checked = true;
    hideCppLabel.appendChild(hideCppCb);
    hideCppLabel.appendChild(document.createTextNode(` C++ (${totalCpp})`));
    frameHeader.appendChild(hideCppLabel);

    const hideUnknownLabel = document.createElement('label');
    hideUnknownLabel.className = 'ctx-toggle-label';
    const hideUnknownCb = document.createElement('input');
    hideUnknownCb.type = 'checkbox';
    hideUnknownCb.checked = true;
    hideUnknownLabel.appendChild(hideUnknownCb);
    hideUnknownLabel.appendChild(document.createTextNode(` Unknown (${totalUnknown})`));
    frameHeader.appendChild(hideUnknownLabel);

    // Search input inline
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'ctx-search-input';
    searchInput.placeholder = 'Search...';
    frameHeader.appendChild(searchInput);

    frameSection.appendChild(frameHeader);

    // Frame list container
    const frameList = document.createElement('div');
    frameList.className = 'ctx-frame-list';
    frameSection.appendChild(frameList);
    root.appendChild(frameSection);

    /**
     * Rebuild the frame list based on current hide toggles and search.
     * Consecutive hidden frames are collapsed into a toggleable placeholder.
     * When search is active, only matching frames are shown.
     */
    function rebuildFrameList(searchTerm) {
      frameList.innerHTML = '';
      const hideCpp = hideCppCb.checked;
      const hideUnknown = hideUnknownCb.checked;
      const lowerSearch = searchTerm ? searchTerm.toLowerCase() : '';

      // Determine which frames should be hidden by type toggle
      const frameVisibility = frames.map(f => {
        if (hideCpp && f.type === 'cpp') return 'hidden';
        if (hideUnknown && f.type === 'unknown') return 'hidden';
        return 'visible';
      });

      // When search is active, hide non-matching visible frames
      if (lowerSearch) {
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i];
          const text = `${f.filename}:${f.line}:${f.name}`;
          const matches = text.toLowerCase().includes(lowerSearch);
          if (matches) {
            // Force show matching frames even if type-hidden
            frameVisibility[i] = 'visible';
          } else if (frameVisibility[i] === 'visible') {
            // Hide non-matching frames that were visible
            frameVisibility[i] = 'filtered';
          }
        }
      }

      let i = 0;
      while (i < frames.length) {
        if (frameVisibility[i] === 'filtered') {
          // Search-filtered frames are simply skipped (not shown at all)
          i++;
          continue;
        }
        if (frameVisibility[i] === 'hidden') {
          // Collapse consecutive hidden frames into a toggleable placeholder
          let j = i;
          const hiddenTypes = { cpp: 0, unknown: 0 };
          while (j < frames.length && frameVisibility[j] === 'hidden') {
            hiddenTypes[frames[j].type]++;
            j++;
          }
          const count = j - i;

          // When search is active, skip hidden groups with no matching frames
          if (lowerSearch) {
            let hasMatch = false;
            for (let k = i; k < j; k++) {
              const f = frames[k];
              const text = `${f.filename}:${f.line}:${f.name}`;
              if (text.toLowerCase().includes(lowerSearch)) {
                hasMatch = true;
                break;
              }
            }
            if (!hasMatch) {
              i = j;
              continue;
            }
          }
          const parts = [];
          if (hiddenTypes.cpp > 0) parts.push(`${hiddenTypes.cpp} C++`);
          if (hiddenTypes.unknown > 0) parts.push(`${hiddenTypes.unknown} unknown`);

          // Wrapper that holds the placeholder and expanded frames
          const wrapper = document.createElement('div');
          wrapper.className = 'ctx-frame-group';

          const placeholder = document.createElement('div');
          placeholder.className = 'ctx-frame-placeholder';
          placeholder.textContent = `\u2026 ${count} hidden frames (${parts.join(', ')}) — click to expand`;
          wrapper.appendChild(placeholder);

          // Container for expanded frames (initially empty)
          const expandedContainer = document.createElement('div');
          expandedContainer.className = 'ctx-frame-group-expanded';
          expandedContainer.style.display = 'none';
          wrapper.appendChild(expandedContainer);

          // Capture range for toggle click
          const startIdx = i;
          const endIdx = j;
          let expanded = false;
          placeholder.addEventListener('click', () => {
            expanded = !expanded;
            if (expanded) {
              // Populate expanded frames on first expand
              if (expandedContainer.children.length === 0) {
                for (let k = startIdx; k < endIdx; k++) {
                  expandedContainer.appendChild(createFrameElement(frames[k], lowerSearch, k));
                }
              }
              expandedContainer.style.display = '';
              placeholder.textContent = `\u25BC ${count} frames (${parts.join(', ')}) — click to collapse`;
              placeholder.classList.add('ctx-frame-placeholder--expanded');
            } else {
              expandedContainer.style.display = 'none';
              placeholder.textContent = `\u2026 ${count} hidden frames (${parts.join(', ')}) — click to expand`;
              placeholder.classList.remove('ctx-frame-placeholder--expanded');
            }
          });

          frameList.appendChild(wrapper);
          i = j;
        } else {
          frameList.appendChild(createFrameElement(frames[i], lowerSearch, i));
          i++;
        }
      }

      // Show a "no results" message when search filters out everything
      if (lowerSearch && frameList.children.length === 0) {
        const noResult = document.createElement('div');
        noResult.className = 'ctx-no-search-result';
        noResult.textContent = `No frames matching "${searchTerm}"`;
        frameList.appendChild(noResult);
      }
    }

    hideCppCb.addEventListener('change', () => rebuildFrameList(searchInput.value));
    hideUnknownCb.addEventListener('change', () => rebuildFrameList(searchInput.value));

    // Initial render
    rebuildFrameList('');

    // Search result count badge (inline in header)
    const searchCountSpan = document.createElement('span');
    searchCountSpan.className = 'ctx-search-count';
    frameHeader.appendChild(searchCountSpan);

    // Wire up search
    searchInput.addEventListener('input', () => {
      rebuildFrameList(searchInput.value);
      // Update match count
      if (searchInput.value) {
        const matchCount = frames.filter(f => {
          const t = `${f.filename}:${f.line}:${f.name}`;
          return t.toLowerCase().includes(searchInput.value.toLowerCase());
        }).length;
        searchCountSpan.textContent = `${matchCount} / ${frames.length} frames`;
        searchCountSpan.style.display = '';
      } else {
        searchCountSpan.textContent = '';
        searchCountSpan.style.display = 'none';
      }
    });
  }

  // -- Forward Frames (collapsible, default collapsed) --
  if (forwardFrames) {
    const ffSection = document.createElement('details');
    ffSection.className = 'ctx-section';
    const ffSummary = document.createElement('summary');
    ffSummary.className = 'ctx-section-summary';
    ffSummary.textContent = 'Forward Pass Stack Trace';
    ffSection.appendChild(ffSummary);
    const ffPre = document.createElement('pre');
    ffPre.className = 'ctx-pre-block';
    ffPre.textContent = forwardFrames;
    ffSection.appendChild(ffPre);
    root.appendChild(ffSection);
  }
}

/**
 * Create a DOM element for a single frame line.
 * @param {number} [index] - Original frame index (0-based), displayed as line number.
 */
function createFrameElement(frame, searchTerm, index) {
  const div = document.createElement('div');
  div.className = `ctx-frame ctx-frame--${frame.type}`;

  // Line number gutter
  if (index !== undefined) {
    const lineNo = document.createElement('span');
    lineNo.className = 'ctx-frame-lineno';
    lineNo.textContent = String(index).padStart(2, ' ');
    div.appendChild(lineNo);
  }

  const text = `${frame.filename}:${frame.line}:${frame.name}`;

  const textSpan = document.createElement('span');
  if (searchTerm && text.toLowerCase().includes(searchTerm.toLowerCase())) {
    // Highlight matching text
    textSpan.innerHTML = highlightText(text, searchTerm);
  } else {
    textSpan.textContent = text;
  }
  div.appendChild(textSpan);

  // FX info
  if (frame.fxInfo) {
    const fxDiv = document.createElement('div');
    fxDiv.className = 'ctx-frame-fx';
    fxDiv.textContent = `\u00BB FX: ${frame.fxInfo}`;
    div.appendChild(fxDiv);
  }

  // Original trace
  if (frame.originalTrace) {
    const otDiv = document.createElement('div');
    otDiv.className = 'ctx-frame-original';
    otDiv.textContent = `\u00BB Original Model Code:\n${frame.originalTrace.split('\n').map(l => `   ${l}`).join('\n')}`;
    div.appendChild(otDiv);
  }

  return div;
}

/**
 * Return HTML string with search term highlighted using <mark>.
 */
function highlightText(text, term) {
  if (!term) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedTerm = escapeHtml(term);
  const regex = new RegExp(`(${escapedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark class="ctx-highlight">$1</mark>');
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * ContextViewer component for showing allocation details.
 * Adapted for Canvas: uses allocation index + data object instead of D3 selection.
 */
function ContextViewer(container, data) {
  let currentSelectedIndex = -1;

  function renderEmpty() {
    const root = container.node();
    root.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'ctx-empty-message';
    msg.textContent = 'Hover over or click an allocation to view details';
    root.appendChild(msg);
  }

  function renderSummarized() {
    const root = container.node();
    root.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'ctx-summarized-message';
    msg.textContent =
      'Small tensors that were not plotted to cut down on render time.\n' +
      'Use detail slider to see smaller allocations.';
    root.appendChild(msg);
  }

  // Show initial empty state
  renderEmpty();

  return {
    default_selected_index: -1,
    default_selected_alloc: null,
    set_selected: (index, alloc) => {
      if (index === currentSelectedIndex) return; // skip redundant updates
      currentSelectedIndex = index;

      if (index < 0 || alloc === null) {
        renderEmpty();
      } else if (alloc.elem === 'summarized') {
        renderSummarized();
      } else {
        const contextData = data.context_for_id(alloc.elem);
        renderContextContent(container, contextData, alloc.elem);
      }
    },
  };
}

/**
 * MiniMap component for timeline navigation
 */
function MiniMap(miniSvg, plot, data, width, height = 60) {
  const maxAtTime = data.max_at_time;
  const yScale = d3.scaleLinear().domain([0, data.max_size]).range([height, 0]);
  const miniXScale = d3.scaleLinear()
    .domain([0, maxAtTime.length])
    .range([0, width]);

  const miniPoints = [
    [maxAtTime.length, 0],
    [0, 0],
  ];

  for (const [i, m] of maxAtTime.entries()) {
    const [, lasty] = miniPoints[miniPoints.length - 1];
    if (m !== lasty) {
      miniPoints.push([i, lasty]);
      miniPoints.push([i, m]);
    } else if (i === maxAtTime.length - 1) {
      miniPoints.push([i, m]);
    }
  }

  let points = miniPoints.map(([t, o]) => `${miniXScale(t)}, ${yScale(o)}`);
  points = points.join(' ');
  miniSvg
    .append('polygon')
    .attr('points', points)
    .attr('fill', schemeTableau10[0]);

  const xScale = d3.scaleLinear()
    .domain([0, maxAtTime.length])
    .range([0, width]);

  const brush = d3.brushX();
  brush.extent([
    [0, 0],
    [width, height],
  ]);
  brush.on('brush', function (event) {
    const [begin, end] = event.selection;

    const stepbegin = Math.floor(xScale.invert(begin));
    const stepend = Math.floor(xScale.invert(end));
    let max = 0;
    for (let i = stepbegin; i < stepend; i++) {
      max = Math.max(max, maxAtTime[i]);
    }
    plot.select_window(stepbegin, stepend, max);
  });
  brush.on('end', function (event) {
    // When brush is cleared (e.g. single click), reset to full range
    if (event.selection === null) {
      plot.select_window(0, maxAtTime.length, data.max_size);
    }
  });
  miniSvg.call(brush);
  return {};
}

/**
 * Legend component for category colors — rendered as SVG overlay
 */
function Legend(svgGroup, categories) {
  const xstart = 100;
  const ystart = 5;
  const legendGroup = svgGroup;

  // Semi-transparent background panel
  const bgPadding = 6;
  const itemHeight = 15;
  const maxTextWidth = Math.max(...categories.map(c => c.length)) * 6 + 30;
  legendGroup
    .append('rect')
    .attr('x', xstart - bgPadding)
    .attr('y', ystart - bgPadding)
    .attr('width', maxTextWidth + bgPadding * 2)
    .attr('height', categories.length * itemHeight + bgPadding * 2)
    .attr('fill', 'rgba(15, 17, 23, 0.75)')
    .attr('stroke', 'rgba(255, 255, 255, 0.08)')
    .attr('stroke-width', 0.5)
    .attr('rx', 4)
    .attr('ry', 4);

  legendGroup
    .selectAll('rect.legend-swatch')
    .data(categories)
    .enter()
    .append('rect')
    .attr('class', 'legend-swatch')
    .attr('x', () => xstart)
    .attr('y', (c, i) => ystart + i * itemHeight)
    .attr('width', 10)
    .attr('height', 10)
    .attr('rx', 2)
    .attr('ry', 2)
    .attr('fill', (c, i) => schemeTableau10[i % schemeTableau10.length]);
  legendGroup
    .selectAll('text.legend-label')
    .data(categories)
    .enter()
    .append('text')
    .attr('class', 'legend-label')
    .attr('x', () => xstart + 16)
    .attr('y', (c, i) => ystart + i * itemHeight + 8)
    .attr('font-family', '-apple-system, BlinkMacSystemFont, Inter, sans-serif')
    .attr('font-size', 10)
    .attr('fill', '#9aa0b0')
    .text((c) => c);
  return {};
}

/**
 * Create trace view — main entry point
 */
export function createTraceView(
  dst,
  snapshot,
  device,
  plotSegments = false,
  maxEntries = 15000,
) {
  const leftPad = 70;
  const data = processAllocData(snapshot, device, plotSegments, maxEntries);
  dst.selectAll('svg').remove();
  dst.selectAll('div').remove();
  dst.selectAll('canvas').remove();

  maxEntries = Math.min(maxEntries, data.elements_length);
  const totalEntries = data.elements_length;
  const d = dst.append('div').attr('class', 'trace-detail-controls');
  // Use the widest possible text to measure and lock the label width,
  // preventing layout shift (slider jitter) when digit count changes.
  const maxLabelText = `Detail: ${totalEntries} of ${totalEntries} entries`;
  const detailLabel = d.append('label').text(
    `Detail: ${maxEntries} of ${totalEntries} entries`,
  );
  // Measure the rendered width of the widest label text, then fix it
  detailLabel.text(maxLabelText);
  const fixedWidth = detailLabel.node().getBoundingClientRect().width;
  detailLabel
    .style('min-width', `${Math.ceil(fixedWidth)}px`)
    .text(`Detail: ${maxEntries} of ${totalEntries} entries`);
  d.append('input')
    .attr('type', 'range')
    .attr('min', 1)
    .attr('max', totalEntries)
    .attr('value', maxEntries)
    .on('input', function () {
      // Update label text in real-time during drag (no rebuild)
      detailLabel.text(
        `Detail: ${this.value} of ${totalEntries} entries`,
      );
    })
    .on('change', function () {
      createTraceView(dst, snapshot, device, plotSegments, this.value);
    });

  const gridContainer = dst
    .append('div')
    .attr('class', 'trace-view-grid');

  // ---- Plot container (Canvas-based) ----
  const plotContainer = gridContainer
    .append('div')
    .attr('class', 'trace-plot-container');

  const plot = MemoryPlot(plotContainer.node(), data, leftPad);

  // Legend as SVG overlay on top of canvas
  if (snapshot.categories.length !== 0) {
    const legendSvg = d3
      .select(plotContainer.node())
      .append('svg')
      .attr('class', 'trace-legend-overlay')
      .style('position', 'absolute')
      .style('top', '0')
      .style('left', `${leftPad}px`)
      .style('pointer-events', 'none')
      .style('overflow', 'visible');
    Legend(legendSvg.append('g').attr('class', 'trace-legend'), snapshot.categories);
    // Size the legend SVG to match container
    const updateLegendSize = () => {
      const rect = plotContainer.node().getBoundingClientRect();
      legendSvg.attr('width', rect.width - leftPad).attr('height', rect.height);
    };
    updateLegendSize();
    // Will be updated by ResizeObserver below
    plot._updateLegendSize = updateLegendSize;
  }

  // ---- Minimap ----
  const minimapContainer = gridContainer
    .append('div')
    .attr('class', 'trace-minimap-container')
    .style('padding-left', `${leftPad}px`);
  const miniSvg = minimapContainer
    .append('svg')
    .attr('display', 'block')
    .attr('viewBox', '0 0 1024 60')
    .attr('preserveAspectRatio', 'none');

  MiniMap(miniSvg, plot, data, 1024);

  // ---- Context panel ----
  const contextDiv = gridContainer
    .append('div')
    .attr('class', 'trace-context-panel');
  const contextContainer = contextDiv.append('div').attr('class', 'ctx-root');
  const delegate = ContextViewer(contextContainer, data);
  plot.set_delegate(delegate);

  // ---- ResizeObserver ----
  const ro = new ResizeObserver(() => {
    plot.resize();
    if (plot._updateLegendSize) plot._updateLegendSize();
  });
  ro.observe(plotContainer.node());

  // Initial sizing (after DOM is attached)
  requestAnimationFrame(() => {
    plot.resize();
    if (plot._updateLegendSize) plot._updateLegendSize();
  });
}