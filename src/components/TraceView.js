import * as d3 from 'd3';
import {
  schemeTableau10,
  formatSize,
  formatAddr,
  formatFrames,
  formatForwardFrames,
  formatUserMetadata,
  getTraceInteractionMode,
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
    context_for_id: (id) => {
      const elem = elements[id];
      let text = `Addr: ${formatAddr(elem)}`;
      text = `${text}, Size: ${formatSize(elem.size)} allocation`;
      text = `${text}, Total memory used after allocation: ${formatSize(
        elem.max_allocated_mem,
      )}`;
      const context = elem?.compile_context ?? 'None';
      text = `${text}, Compile context: ${context}`;
      if (elem.stream !== null) {
        text = `${text}, stream ${elem.stream}`;
      }
      if (elem.timestamp !== null) {
        const d = new Date(elem.time_us / 1000);
        text = `${text}, timestamp ${d}`;
      }
      if (!elem.action.includes('alloc')) {
        text = `${text}\nalloc not recorded, stack trace for free:`;
      }
      const userMetadataStr = formatUserMetadata(elem.user_metadata);
      if (userMetadataStr) {
        text = `${text}\n${userMetadataStr}`;
      }
      text = `${text}\n${formatFrames(elem.frames)}`;
      text = `${text}${formatForwardFrames(elem.forward_frames)}`;
      return text;
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
      .attr('fill', 'white');
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
      if (getTraceInteractionMode() === 'hover') {
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
      } else {
        plot.on('click', function () {
          delegate.default_selected = d3.select(this);
          delegate.set_selected(d3.select(this));
        });
      }
    },
  };
}

/**
 * ContextViewer component for showing allocation details
 */
function ContextViewer(text, data) {
  let currentSelected = null;

  return {
    default_selected: null,
    set_selected: (d) => {
      if (currentSelected !== null) {
        currentSelected.attr('stroke', null).attr('stroke-width', null);
      }
      if (d === null) {
        text.text('');
      } else {
        const dd = d.datum();
        if (dd.elem === 'summarized') {
          text.html(
            'Small tensors that were not plotted to cutdown on render time.\n' +
              'Use detail slider to see smaller allocations.',
          );
        } else {
          text.text(`${dd.elem} ${data.context_for_id(dd.elem)}`);
        }
        d.attr('stroke', 'black')
          .attr('stroke-width', 1)
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
  miniSvg.call(brush);
  return {};
}

/**
 * Legend component for category colors
 */
function Legend(plotSvg, categories) {
  const xstart = 100;
  const ystart = 5;
  plotSvg
    .append('g')
    .selectAll('rect')
    .data(categories)
    .enter()
    .append('rect')
    .attr('x', () => xstart)
    .attr('y', (c, i) => ystart + i * 15)
    .attr('width', 10)
    .attr('height', 10)
    .attr('fill', (c, i) => schemeTableau10[i % schemeTableau10.length]);
  plotSvg
    .append('g')
    .selectAll('text')
    .data(categories)
    .enter()
    .append('text')
    .attr('x', () => xstart + 20)
    .attr('y', (c, i) => ystart + i * 15 + 8)
    .attr('font-family', 'helvetica')
    .attr('font-size', 10)
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
  const d = dst.append('div');
  d.append('input')
    .attr('type', 'range')
    .attr('min', 0)
    .attr('max', data.elements_length)
    .attr('value', maxEntries)
    .on('change', function () {
      createTraceView(dst, snapshot, device, plotSegments, this.value);
    });
  d.append('label').text(
    `Detail: ${maxEntries} of ${data.elements_length} entries`,
  );

  const gridContainer = dst
    .append('div')
    .attr(
      'style',
      'display: grid; grid-template-columns: 1fr; grid-template-rows: 10fr 1fr 8fr; flex: 1; min-height: 0; gap: 10px',
    );

  const plotSvg = gridContainer
    .append('svg')
    .attr('display', 'block')
    .attr('viewBox', '0 0 1024 576')
    .attr('preserveAspectRatio', 'none')
    .attr('style', 'grid-column: 1; grid-row: 1; width: 100%; height: 100%;');

  const plot = MemoryPlot(plotSvg, data, leftPad, 1024, 576);

  if (snapshot.categories.length !== 0) {
    Legend(plotSvg.append('g'), snapshot.categories);
  }

  const miniSvg = gridContainer
    .append('svg')
    .attr('display', 'block')
    .attr('viewBox', '0 0 1024 60')
    .attr('preserveAspectRatio', 'none')
    .attr('style', 'grid-column: 1; grid-row: 2; width: 100%; height: 100%;');

  MiniMap(miniSvg, plot, data, leftPad, 1024);
  const contextDiv = gridContainer
    .append('div')
    .attr(
      'style',
      'grid-column: 1; grid-row: 3; width: 100%; height: 100%; min-height: 0; overflow: auto;',
    );
  const delegate = ContextViewer(contextDiv.append('pre').text('none'), data);
  plot.set_delegate(delegate);
}
