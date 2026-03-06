import * as d3 from 'd3';
import { EventSelector } from './EventSelector.js';
import { MemoryView } from './MemoryView.js';
import { StackInfo } from './StackInfo.js';

/**
 * Create segment view for memory state visualization
 */
export function createSegmentView(dst, snapshot, device) {
  const outer = dst
    .append('div')
    .attr('class', 'segment-view-grid');

  const events = snapshot.device_traces[device];
  const stackInfo = StackInfo(outer);
  const memoryView = MemoryView(outer, stackInfo, snapshot, device);
  const eventSelector = EventSelector(outer, events, stackInfo, memoryView);

  window.requestAnimationFrame(function () {
    eventSelector.select(events.length > 0 ? events.length - 1 : null);
  });
}
