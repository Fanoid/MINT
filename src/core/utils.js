import * as d3 from 'd3';

/**
 * Global configuration for trace interaction mode
 * 'hover' = show trace on hover (default)
 * 'click' = show trace on click
 */
let traceInteractionMode = 'hover';

export function setTraceInteractionMode(mode) {
  if (mode === 'click' || mode === 'hover') {
    traceInteractionMode = mode;
  }
}

export function getTraceInteractionMode() {
  return traceInteractionMode;
}

/**
 * Format size in human-readable format
 */
export function formatSize(num, showBytes = true) {
  const orig = num;
  const units = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei', 'Zi'];
  for (const unit of units) {
    if (Math.abs(num) < 1024.0) {
      if (showBytes) {
        return `${num.toFixed(1)}${unit}B (${orig} bytes)`;
      }
      return `${num.toFixed(1)}${unit}B`;
    }
    num /= 1024.0;
  }
  return `${num.toFixed(1)}YiB`;
}

/**
 * Format address for display
 */
export function formatAddr(event) {
  const prefix = event.action.startsWith('segment') ? "s'" : "b'";
  return `${prefix}${event.addr.toString(16)}_${event.version}`;
}

/**
 * Format event for display
 */
export function formatEvent(event) {
  const stream =
    event.stream === null ? '' : `\n              (stream ${event.stream})`;
  switch (event.action) {
    case 'oom':
      return `OOM (requested ${formatSize(event.size)}, Device has ${formatSize(
        event.device_free,
      )} memory free)${stream}`;
    case 'snapshot':
      return 'snapshot';
    default:
      return `${event.action.padEnd(14)} ${formatAddr(event).padEnd(
        18,
      )} ${formatSize(event.size)}${stream}`;
  }
}

/**
 * Format event stack trace
 */
export function eventStack(e, allocated, reserved) {
  let event = formatEvent(e);
  if (reserved !== undefined) {
    event = `(${formatSize(allocated)} allocated / ${formatSize(
      reserved,
    )} reserved)\n${event}`;
  }
  const user_metadata_str = formatUserMetadata(e.user_metadata);
  const frames_str = formatFrames(e.frames);
  const forward_frames_str = formatForwardFrames(e.forward_frames);
  return event + '\n' + (user_metadata_str ? user_metadata_str + '\n' : '') + frames_str + forward_frames_str;
}

/**
 * Calculate hash code from number
 */
export function hashCode(num) {
  const numStr = num.toString();
  let hash = 0;
  for (let i = 0; i < numStr.length; i++) {
    const charCode = numStr.charCodeAt(i);
    hash = (hash << 5) - hash + charCode;
    hash = hash & hash;
  }
  return hash;
}

/**
 * Add stroke highlight to selection
 */
export function addStroke(d) {
  d.attr('stroke', 'red')
    .attr('stroke-width', '2')
    .attr('vector-effect', 'non-scaling-stroke');
}

/**
 * Remove stroke highlight from selection
 */
export function removeStroke(d) {
  d.attr('stroke', '');
}

/**
 * Filter frames based on predefined rules
 */
export function frameFilter({ name, filename }) {
  const omitFunctions = [
    'unwind::unwind',
    'CapturedTraceback::gather',
    'gather_with_cpp',
    '_start',
    '__libc_start_main',
    'PyEval_',
    'PyObject_',
    'PyFunction_',
  ];

  const omitFilenames = [
    'core/boxing',
    '/Register',
    '/Redispatch',
    'pythonrun.c',
    'Modules/main.c',
    'Objects/call.c',
    'Objects/methodobject.c',
    'pycore_ceval.h',
    'ceval.c',
    'cpython/abstract.h',
  ];

  for (const of of omitFunctions) {
    if (name.includes(of)) {
      return false;
    }
  }

  for (const of of omitFilenames) {
    if (filename.includes(of)) {
      return false;
    }
  }

  return true;
}

/**
 * Elide repeated frames
 */
export function elideRepeats(frames) {
  const result = [];
  const length = frames.length;
  for (let i = 0; i < length; ) {
    let j = i + 1;
    const f = frames[i];
    while (j < length && f === frames[j]) {
      j++;
    }
    switch (j - i) {
      case 1:
        result.push(f);
        break;
      case 2:
        result.push(f, f);
        break;
      default:
        result.push(f, `<repeats ${j - i - 1} times>`);
        break;
    }
    i = j;
  }
  return result;
}

/**
 * Format user metadata for display
 */
export function formatUserMetadata(user_metadata) {
  if (!user_metadata) {
    return '';
  }
  if (typeof user_metadata === 'string') {
    return `User Metadata:\n  ${user_metadata}`;
  }
  if (typeof user_metadata === 'object' && Object.keys(user_metadata).length === 0) {
    return '';
  }
  const metadata_lines = Object.entries(user_metadata)
    .map(([key, value]) => `  ${key}: ${value}`);
  return 'User Metadata:\n' + metadata_lines.join('\n');
}

/**
 * Format forward frames for display
 */
export function formatForwardFrames(forward_frames) {
  if (!forward_frames || forward_frames.length === 0) {
    return '';
  }
  let frames_str = forward_frames.join('');
  frames_str = frames_str.trimEnd();
  return `\n\n=== Forward Pass Stack Trace (where this tensor was created) ===\n${frames_str}`;
}

/**
 * Format frames for display
 */
export function formatFrames(frames) {
  if (frames.length === 0) {
    return (
      `This block has no frames. Potential causes:\n` +
      `1) This block was allocated before _record_memory_history was enabled.\n` +
      `2) The context or stacks passed to _record_memory_history does not include this block. Consider changing context to 'state', 'alloc', or 'all', or changing stacks to 'all'.\n` +
      `3) This event occurred during backward, which has no python frames, and memory history did not include C++ frames. Use stacks='all' to record both C++ and python frames.`
    );
  }
  const frame_strings = frames
    .filter(frameFilter)
    .map(f => {
      let frame_str = `${f.filename}:${f.line}:${f.name}`;

      if (f.fx_node_op || f.fx_node_name || f.fx_node_target) {
        const fx_parts = [];
        if (f.fx_node_name) fx_parts.push(`node=${f.fx_node_name}`);
        if (f.fx_node_op) fx_parts.push(`op=${f.fx_node_op}`);
        if (f.fx_node_target) fx_parts.push(`target=${f.fx_node_target}`);
        frame_str += `\n    >> FX: ${fx_parts.join(', ')}`;
      }

      if (f.fx_original_trace) {
        frame_str += `\n    >> Original Model Code:`;
        const original_lines = f.fx_original_trace.trim().split('\n');
        for (const line of original_lines) {
          frame_str += `\n       ${line}`;
        }
      }

      return frame_str;
    });
  return elideRepeats(frame_strings).join('\n');
}

/**
 * Create version space tracker
 */
export function versionSpace() {
  const version = {};
  return (addr, increment) => {
    if (!(addr in version)) {
      version[addr] = 0;
    }
    const r = version[addr];
    if (increment) {
      version[addr]++;
    }
    return r;
  };
}

/**
 * Create Segment object
 */
export function Segment(addr, size, stream, frames, version, user_metadata) {
  return { addr, size, stream, version, frames, user_metadata };
}

/**
 * Create Block object
 */
export function Block(addr, size, requested_size, frames, free_requested, version, user_metadata) {
  return { addr, size, requested_size, frames, free_requested, version, user_metadata };
}
