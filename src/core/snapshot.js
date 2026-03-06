import { versionSpace, Segment, Block } from './utils.js';

/**
 * Annotate snapshot with additional metadata
 */
export function annotateSnapshot(snapshot) {
  snapshot.segment_version = versionSpace();
  snapshot.block_version = versionSpace();
  snapshot.categories = [];
  const empty_list = [];
  let next_stream = 1;
  const stream_names = { 0: 0 };

  function stream_name(s) {
    if (!(s in stream_names)) {
      stream_names[s] = next_stream++;
    }
    return stream_names[s];
  }

  const new_traces = [];
  for (const device_trace of snapshot.device_traces) {
    const new_trace = [];
    new_traces.push(new_trace);
    for (const t of device_trace) {
      if (!('frames' in t)) {
        t.frames = empty_list;
      }
      t.stream = stream_name(t.stream);
      switch (t.action) {
        case 'free_completed':
          t.version = snapshot.block_version(t.addr, true);
          if (new_trace.length > 0) {
            const prev = new_trace.at(-1);
            if (prev.action === 'free_requested' && prev.addr === t.addr) {
              prev.action = 'free';
              continue;
            }
          }
          break;
        case 'free_requested':
        case 'alloc':
          t.version = snapshot.block_version(t.addr, false);
          break;
        case 'segment_free':
        case 'segment_unmap':
          t.version = snapshot.segment_version(t.addr, true);
          break;
        case 'segment_alloc':
        case 'segment_map':
          t.version = snapshot.segment_version(t.addr, false);
          break;
        default:
          break;
      }
      if ('category' in t && !snapshot.categories.includes(t.category)) {
        snapshot.categories.push(t.category);
      }
      t.idx = new_trace.length;
      new_trace.push(t);
    }
  }
  snapshot.device_traces = new_traces;

  if (next_stream == 1) {
    for (const device_trace of snapshot.device_traces) {
      for (const t of device_trace) {
        t.stream = null;
      }
    }
  }

  for (const seg of snapshot.segments) {
    seg.stream = stream_name(seg.stream);
    seg.version = snapshot.segment_version(seg.address, false);
    let addr = seg.address;
    for (const b of seg.blocks) {
      b.addr = addr;
      if (!('frames' in b)) {
        if ('history' in b) {
          b.frames = b.history[0].frames || empty_list;
          b.requested_size = b.requested_size || b.history[0].real_size;
        } else {
          b.frames = empty_list;
          b.requested_size = b.requested_size || b.size;
        }
      }
      b.version = snapshot.block_version(b.addr, false);
      addr += typeof addr === 'bigint' ? BigInt(b.size) : b.size;
    }
  }

  if (
    snapshot.categories.length > 0 &&
    !snapshot.categories.includes('unknown')
  ) {
    snapshot.categories.push('unknown');
  }
}

/**
 * Calculate fragmentation metric
 */
export function calculateFragmentation(blocks, sorted_segments) {
  const sorted_blocks = Object.values(blocks).sort((a, b) => {
    if (a.addr === b.addr) return 0;
    return a.addr < b.addr ? -1 : 1;
  });
  let block_i = 0;
  let total_size = 0;
  let sum_squared_free = 0;

  for (const seg of sorted_segments) {
    let addr = seg.addr;
    total_size += seg.size;
    const seg_end =
      seg.addr + (typeof seg.addr === 'bigint' ? BigInt(seg.size) : seg.size);

    while (
      block_i < sorted_blocks.length &&
      sorted_blocks[block_i].addr < seg_end
    ) {
      const block = sorted_blocks[block_i];
      if (block.addr > addr) {
        sum_squared_free += Number(block.addr - addr) ** 2;
      }
      addr =
        block.addr +
        (typeof block.addr === 'bigint' ? BigInt(block.size) : block.size);
      block_i += 1;
    }
    if (addr < seg_end) {
      sum_squared_free += Number(seg_end - addr) ** 2;
    }
  }
  console.log(sum_squared_free / total_size ** 2);
}

/**
 * Create segment view data from snapshot
 */
export function createSegmentData(snapshot, device) {
  const sorted_segments = [];
  const block_map = {};

  for (const seg of snapshot.segments) {
    if (seg.device !== device) {
      continue;
    }
    sorted_segments.push(
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
      block_map[b.addr] = Block(
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

  sorted_segments.sort((x, y) => {
    if (x.addr === y.addr) return 0;
    return x.addr < y.addr ? -1 : 1;
  });

  return { sorted_segments, block_map };
}
