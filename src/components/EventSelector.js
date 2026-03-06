import * as d3 from 'd3';
import {
  schemeTableau10,
  formatEvent,
  eventStack,
  getTraceInteractionMode,
} from '../core/index.js';

/**
 * EventSelector component for displaying and selecting events
 */
export function EventSelector(outer, events, stackInfo, memoryView) {
  const eventsDiv = outer
    .append('div')
    .attr('class', 'segment-events-panel');

  const eventsSelection = eventsDiv
    .selectAll('pre')
    .data(events)
    .enter()
    .append('pre')
    .text((e) => formatEvent(e));

  let selectedEventIdx = null;

  const es = {
    select(idx) {
      if (selectedEventIdx !== null) {
        const selectedEvent = d3.select(
          eventsDiv.node().children[selectedEventIdx],
        );
        selectedEvent.classed('event-selected', false);
      }
      if (idx !== null) {
        const div = d3.select(eventsDiv.node().children[idx]);
        div.classed('event-selected', true);
        const [reserved, allocated] = memoryView.draw(idx);
        const enter = () => eventStack(div.datum(), allocated, reserved);
        stackInfo.highlight(enter);
        div.node().scrollIntoViewIfNeeded(false);
      } else {
        memoryView.draw(0);
      }
      selectedEventIdx = idx;
    },
  };

  d3.select('body').on('keydown', (event) => {
    const key = event.key;
    const actions = { ArrowDown: 1, ArrowUp: -1 };
    if (selectedEventIdx !== null && key in actions) {
      const newIdx = selectedEventIdx + actions[key];
      es.select(Math.max(0, Math.min(newIdx, events.length - 1)));
      event.preventDefault();
    }
  });

  stackInfo.register(
    eventsSelection,
    (t) => eventStack(t.datum()),
    (_t) => {},
    (d) => es.select(d.datum().idx),
  );

  return es;
}
