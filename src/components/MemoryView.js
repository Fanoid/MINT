import * as d3 from 'd3';
import {
  addStroke,
  removeStroke,
  formatSize,
  formatUserMetadata,
  formatFrames,
  formatForwardFrames,
  schemeTableau10,
  hashCode,
  Segment,
  Block,
} from '../core/index.js';

/**
 * MemoryView component for visualizing memory segments and blocks
 */
export function MemoryView(outer, stackInfo, snapshot, device) {
  const svg = outer
    .append('svg')
    .attr('class', 'segment-memory-panel')
    .attr('viewBox', '0 0 200 100')
    .attr('preserveAspectRatio', 'xMinYMin meet');
  const g = svg.append('g');

  const segZoom = d3.zoom();
  segZoom.on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
  svg.call(segZoom);

  const sortedSegments = [];
  const blockMap = {};

  for (const seg of snapshot.segments) {
    if (seg.device !== device) {
      continue;
    }
    sortedSegments.push(
      Segment(
        seg.address,
        seg.total_size,
        seg.stream,
        seg.frames || [],
        seg.version,
        seg.user_metadata,
      ),
    );
    for (const b of seg.blocks) {
      if (b.state !== 'active_pending_free' && b.state !== 'active_allocated') {
        continue;
      }
      blockMap[b.addr] = Block(
        b.addr,
        b.size,
        b.requested_size,
        b.frames,
        b.state === 'active_pending_free',
        b.version,
        b.user_metadata,
      );
    }
  }

  sortedSegments.sort((x, y) => {
    if (x.addr === y.addr) return 0;
    return x.addr < y.addr ? -1 : 1;
  });

  function simulateMemory(idx) {
    const lSegments = sortedSegments.map((x) => ({ ...x }));
    const lBlockMap = { ...blockMap };

    function mapSegment(merge, seg) {
      let idx = lSegments.findIndex((e) => e.addr > seg.addr);
      if (!merge) {
        lSegments.splice(idx, 0, seg);
        return;
      }
      if (idx === -1) {
        idx = lSegments.length;
      }
      lSegments.splice(idx, 0, seg);
      if (idx + 1 < lSegments.length) {
        const next = lSegments[idx + 1];
        const segEnd =
          seg.addr + (typeof seg.addr === 'bigint' ? BigInt(seg.size) : seg.size);
        if (segEnd === next.addr && seg.stream === next.stream) {
          seg.size += next.size;
          lSegments.splice(idx + 1, 1);
        }
      }
      if (idx > 0) {
        const prev = lSegments[idx - 1];
        const prevEnd =
          prev.addr + (typeof prev.addr === 'bigint' ? BigInt(prev.size) : prev.size);
        if (prevEnd === seg.addr && prev.stream === seg.stream) {
          prev.size += seg.size;
          lSegments.splice(idx, 1);
        }
      }
    }

    function unmapSegment(merge, seg) {
      if (!merge) {
        lSegments.splice(
          lSegments.findIndex((x) => x.addr === seg.addr),
          1,
        );
        return;
      }
      const segEnd =
        seg.addr + (typeof seg.addr === 'bigint' ? BigInt(seg.size) : seg.size);
      const idx = lSegments.findIndex((e) => {
        const eEnd =
          e.addr + (typeof e.addr === 'bigint' ? BigInt(e.size) : e.size);
        return e.addr <= seg.addr && segEnd <= eEnd;
      });
      const existing = lSegments[idx];
      const existingEnd =
        existing.addr +
        (typeof existing.addr === 'bigint' ? BigInt(existing.size) : existing.size);
      if (existing.addr === seg.addr) {
        existing.addr +=
          typeof existing.addr === 'bigint' ? BigInt(seg.size) : seg.size;
        existing.size -= seg.size;
        if (existing.size === 0) {
          lSegments.splice(idx, 1);
        }
      } else if (existingEnd === segEnd) {
        existing.size -= seg.size;
      } else {
        existing.size = Number(seg.addr - existing.addr);
        seg.addr = segEnd;
        seg.size = Number(existingEnd - segEnd);
        lSegments.splice(idx + 1, 0, seg);
      }
    }

    const events = snapshot.device_traces[device];
    for (let i = events.length - 1; i > idx; i--) {
      const event = events[i];
      switch (event.action) {
        case 'free':
          lBlockMap[event.addr] = Block(
            event.addr,
            event.size,
            event.size,
            event.frames,
            false,
            event.version,
            event.user_metadata,
          );
          break;
        case 'free_requested':
          lBlockMap[event.addr].free_requested = false;
          break;
        case 'free_completed':
          lBlockMap[event.addr] = Block(
            event.addr,
            event.size,
            event.size,
            event.frames,
            true,
            event.version,
            event.user_metadata,
          );
          break;
        case 'alloc':
          delete lBlockMap[event.addr];
          break;
        case 'segment_free':
        case 'segment_unmap':
          mapSegment(
            event.action === 'segment_unmap',
            Segment(
              event.addr,
              event.size,
              event.stream,
              event.frames,
              event.version,
              event.user_metadata,
            ),
          );
          break;
        case 'segment_alloc':
        case 'segment_map':
          unmapSegment(
            event.action === 'segment_map',
            Segment(
              event.addr,
              event.size,
              event.stream,
              event.frames,
              event.version,
              event.user_metadata,
            ),
          );
          break;
        case 'oom':
          break;
        default:
          break;
      }
    }
    const newBlocks = Object.values(lBlockMap);
    return [lSegments, newBlocks];
  }

  return {
    draw(idx) {
      const [segmentsUnsorted, blocks] = simulateMemory(idx);
      g.selectAll('g').remove();

      const segmentD = g.append('g');
      const blockG = g.append('g');
      const blockR = g.append('g');

      segmentD.selectAll('rect').remove();
      blockG.selectAll('rect').remove();
      blockR.selectAll('rect').remove();

      const segments = [...segmentsUnsorted].sort((x, y) => {
        if (x.size > y.size) return 1;
        if (x.size < y.size) return -1;
        if (x.addr > y.addr) return 1;
        if (x.addr < y.addr) return -1;
        return 0;
      });

      const segmentsByAddr = [...segments].sort((x, y) => {
        if (x.addr === y.addr) return 0;
        return x.addr < y.addr ? -1 : 1;
      });

      const maxSize = segments.length === 0 ? 0 : segments.at(-1).size;

      const xScale = d3.scaleLinear().domain([0, maxSize]).range([0, 200]);
      const padding = xScale.invert(1);

      let curRow = 0;
      let curRowSize = 0;
      for (const seg of segments) {
        seg.occupied = 0;
        seg.internal_free = 0;
        if (curRowSize + seg.size > maxSize) {
          curRowSize = 0;
          curRow += 1;
        }
        seg.offset = curRowSize;
        seg.row = curRow;
        curRowSize += seg.size + padding;
      }

      const numRows = curRow + 1;
      const yScale = d3.scaleLinear().domain([0, numRows]).range([0, 100]);

      const segmentsSelection = segmentD
        .selectAll('rect')
        .data(segments)
        .enter()
        .append('rect')
        .attr('x', (x) => xScale(x.offset))
        .attr('y', (x) => yScale(x.row))
        .attr('width', (x) => xScale(x.size))
        .attr('height', yScale(4 / 5))
        .attr('stroke', 'rgba(255, 255, 255, 0.18)')
        .attr('stroke-width', '1')
        .attr('vector-effect', 'non-scaling-stroke')
        .attr('fill', '#232735');

      stackInfo.register(
        segmentsSelection,
        (d) => {
          addStroke(d);
          const t = d.datum();
          const free = t.size - t.occupied;
          let internal = '';
          if (t.internal_free > 0) {
            internal = ` (${(t.internal_free / free) * 100}% internal)`;
          }
          const userMetadataStr = formatUserMetadata(t.user_metadata);
          const framesStr = formatFrames(t.frames);
          const forwardFramesStr = formatForwardFrames(t.forward_frames);
          return (
            `s${t.addr.toString(16)}_${t.version}: segment ${formatSize(
              t.size,
            )} allocated, ` +
            `${formatSize(free)} free${internal} (stream ${
              t.stream
            })\n` +
            (userMetadataStr ? userMetadataStr + '\n' : '') +
            framesStr +
            forwardFramesStr
          );
        },
        (d) => {
          d.attr('stroke', 'rgba(255, 255, 255, 0.18)')
            .attr('stroke-width', '1')
            .attr('vector-effect', 'non-scaling-stroke');
        },
      );

      function findSegment(addr) {
        let left = 0;
        let right = segmentsByAddr.length - 1;
        while (left <= right) {
          const mid = Math.floor((left + right) / 2);
          const seg = segmentsByAddr[mid];
          const segEnd =
            seg.addr + (typeof seg.addr === 'bigint' ? BigInt(seg.size) : seg.size);
          if (addr < seg.addr) {
            right = mid - 1;
          } else if (addr >= segEnd) {
            left = mid + 1;
          } else {
            return seg;
          }
        }
        return null;
      }

      for (const b of blocks) {
        b.segment = findSegment(b.addr);
        b.segment.occupied += b.requested_size;
        b.segment.internal_free += b.size - b.requested_size;
      }

      const blockSelection = blockG
        .selectAll('rect')
        .data(blocks)
        .enter()
        .append('rect')
        .attr('x', (x) => xScale(x.segment.offset + Number(x.addr - x.segment.addr)))
        .attr('y', (x) => yScale(x.segment.row))
        .attr('width', (x) => xScale(x.requested_size))
        .attr('height', yScale(4 / 5))
        .attr('fill', (x, _i) =>
          x.free_requested
            ? '#f87171'
            : schemeTableau10[Math.abs(hashCode(x.addr)) % schemeTableau10.length],
        );

      stackInfo.register(
        blockSelection,
        (d) => {
          addStroke(d);
          const t = d.datum();
          let requested = '';
          if (t.free_requested) {
            requested = ' (block freed but waiting due to record_stream)';
          }
          const userMetadataStr = formatUserMetadata(t.user_metadata);
          const framesStr = formatFrames(t.frames);
          const forwardFramesStr = formatForwardFrames(t.forward_frames);
          return (
            `b${t.addr.toString(16)}_${t.version} ` +
            `${formatSize(t.requested_size)} allocation${requested} (stream ${
              t.segment.stream
            })\n` +
            (userMetadataStr ? userMetadataStr + '\n' : '') +
            framesStr +
            forwardFramesStr
          );
        },
        removeStroke,
      );

      const freeSelection = blockR
        .selectAll('rect')
        .data(blocks)
        .enter()
        .append('rect')
        .attr('x', (x) =>
          xScale(
            x.segment.offset + Number(x.addr - x.segment.addr) + x.requested_size,
          ),
        )
        .attr('y', (x) => yScale(x.segment.row))
        .attr('width', (x) => xScale(x.size - x.requested_size))
        .attr('height', yScale(4 / 5))
.attr('fill', (_x, _i) => '#f87171');

      stackInfo.register(
        freeSelection,
        (d) => {
          addStroke(d);
          const t = d.datum();
          const userMetadataStr = formatUserMetadata(t.user_metadata);
          const framesStr = formatFrames(t.frames);
          const forwardFramesStr = formatForwardFrames(t.forward_frames);
          return (
            `Free space lost due to rounding ${formatSize(
              t.size - t.requested_size,
            )}` +
            ` (stream ${t.segment.stream})\n` +
            (userMetadataStr ? userMetadataStr + '\n' : '') +
            framesStr +
            forwardFramesStr
          );
        },
        removeStroke,
      );

      const reserved = segments.reduce((x, y) => x + y.size, 0);
      const allocated = blocks.reduce((x, y) => x + y.requested_size, 0);
      return [reserved, allocated];
    },
  };
}
