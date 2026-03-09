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
 * MemoryPlot component for rendering allocation timeline
 */
function MemoryPlot(svg, data, leftPad, width, height, colors = schemeTableau10) {
  function formatPoints(d) {
    const size = d.size;
    const xs = d.timesteps.map((t) => xScale(t));
    const bottom = d.offsets.map((t) => yScale(t));
    const m = Array.isArray(size)
      ? (t, i) => yScale(t + size[i])
      : (t) => yScale(t + size);
    const top = d.offsets.map(m);
    const p0 = xs.map((x, i) => `${x},${bottom[i]}`);
    const p1 = xs.map((x, i) => `${x},${top[i]}`).reverse();
    return `${p0.join(' ')} ${p1.join(' ')}`;
  }

  const maxTimestep = data.max_at_time.length;
  const maxSize = data.max_size;

  const plotWidth = width - leftPad;
  const plotHeight = height;

  const yScale = d3.scaleLinear().domain([0, maxSize]).range([plotHeight, 0]);
  const yaxis = d3.axisLeft(yScale).tickFormat((d) => formatSize(d, false));
  const xScale = d3.scaleLinear().domain([0, maxTimestep]).range([0, plotWidth]);

  const plotCoordinateSpace = svg
    .append('g')
    .attr('transform', `translate(${leftPad}, ${0})`);
  const plotOuter = plotCoordinateSpace.append('g');

  function viewRect(a) {
    return a
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', plotWidth)
      .attr('height', plotHeight)
      .attr('fill', '#232735');
  }

  viewRect(plotOuter);

  const cp = svg.append('clipPath').attr('id', 'clip');
  viewRect(cp);
  plotOuter.attr('clip-path', 'url(#clip)');

  const zoomGroup = plotOuter.append('g');
  const scrubGroup = zoomGroup.append('g');

  const plot = scrubGroup
    .selectAll('polygon')
    .data(data.allocations_over_time)
    .enter()
    .append('polygon')
    .attr('points', formatPoints)
    .attr('fill', (d) => colors[d.color % colors.length]);

  const axis = plotCoordinateSpace.append('g').call(yaxis);

  function handleZoom(event) {
    const t = event.transform;
    zoomGroup.attr('transform', t);
    axis.call(yaxis.scale(event.transform.rescaleY(yScale)));
  }

  const theZoom = d3.zoom().on('zoom', handleZoom);
  plotOuter.call(theZoom);

  return {
    select_window: (stepbegin, stepend, max) => {
      const begin = xScale(stepbegin);
      const size = xScale(stepend) - xScale(stepbegin);
      const scale = plotWidth / size;
      const translate = -begin;
      const yscale = maxSize / max;
      scrubGroup.attr(
        'transform',
        `scale(${scale / yscale}, 1) translate(${translate}, 0)`,
      );
      plotOuter.call(
        theZoom.transform,
        d3.zoomIdentity
          .scale(yscale)
          .translate(0, -(plotHeight - plotHeight / yscale)),
      );
    },
    set_delegate: (delegate) => {
      plot
        .on('mouseover', function () {
          delegate.set_selected(d3.select(this));
        })
        .on('mousedown', function () {
          delegate.default_selected = d3.select(this);
        })
        .on('mouseleave', function () {
          delegate.set_selected(delegate.default_selected);
        });
    },
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
 * Renders structured HTML into the container div.
 */
function ContextViewer(container, data) {
  let currentSelected = null;

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
    default_selected: null,
    set_selected: (d) => {
      if (currentSelected !== null) {
        currentSelected.attr('stroke', null).attr('stroke-width', null);
      }
      if (d === null) {
        renderEmpty();
      } else {
        const dd = d.datum();
        if (dd.elem === 'summarized') {
          renderSummarized();
        } else {
          const contextData = data.context_for_id(dd.elem);
          renderContextContent(container, contextData, dd.elem);
        }
        d.attr('stroke', '#6c8cff')
          .attr('stroke-width', 2)
          .attr('vector-effect', 'non-scaling-stroke');
      }
      currentSelected = d;
    },
  };
}

/**
 * MiniMap component for timeline navigation
 */
function MiniMap(miniSvg, plot, data, leftPad, width, height = 70) {
  const maxAtTime = data.max_at_time;
  const plotWidth = width - leftPad;
  const yScale = d3.scaleLinear().domain([0, data.max_size]).range([height, 0]);
  const miniXScale = d3.scaleLinear()
    .domain([0, maxAtTime.length])
    .range([leftPad, width]);

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
    .range([0, plotWidth]);

  const brush = d3.brushX();
  brush.extent([
    [leftPad, 0],
    [width, height],
  ]);
  brush.on('brush', function (event) {
    const [begin, end] = event.selection.map((x) => x - leftPad);

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
 * Legend component for category colors
 */
function Legend(plotSvg, categories) {
  const xstart = 100;
  const ystart = 5;
  const legendGroup = plotSvg;

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
 * Create trace view
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

  const plotContainer = gridContainer
    .append('div')
    .attr('class', 'trace-plot-container');
  const plotSvg = plotContainer
    .append('svg')
    .attr('display', 'block')
    .attr('viewBox', '0 0 1024 576')
    .attr('preserveAspectRatio', 'none');

  const plot = MemoryPlot(plotSvg, data, leftPad, 1024, 576);

  if (snapshot.categories.length !== 0) {
    Legend(plotSvg.append('g').attr('class', 'trace-legend'), snapshot.categories);
  }

  const minimapContainer = gridContainer
    .append('div')
    .attr('class', 'trace-minimap-container');
  const miniSvg = minimapContainer
    .append('svg')
    .attr('display', 'block')
    .attr('viewBox', '0 0 1024 60')
    .attr('preserveAspectRatio', 'none');

  MiniMap(miniSvg, plot, data, leftPad, 1024);
  const contextDiv = gridContainer
    .append('div')
    .attr('class', 'trace-context-panel');
  const contextContainer = contextDiv.append('div').attr('class', 'ctx-root');
  const delegate = ContextViewer(contextContainer, data);
  plot.set_delegate(delegate);
}
