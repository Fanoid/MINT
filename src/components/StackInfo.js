import * as d3 from 'd3';
import { getTraceInteractionMode } from '../core/index.js';

/**
 * StackInfo component for displaying stack traces
 */
export function StackInfo(outer) {
  const stackTrace = outer
    .append('pre')
    .attr('style', 'grid-column: 1 / 3; grid-row: 2; overflow: auto');

  let selected = {
    enter: () => {
      stackTrace.text('');
    },
    leave: () => {},
  };

  return {
    register(dom, enter, leave, select) {
      leave = leave || ((_e) => {});
      select = select || ((_e) => {});
      if (getTraceInteractionMode() === 'hover') {
        dom
          .on('mouseover', function (event) {
            selected.leave();
            stackTrace.text(enter(d3.select(event.target)));
          })
          .on('mousedown', function (event) {
            const obj = d3.select(event.target);
            selected = {
              enter: () => stackTrace.text(enter(obj)),
              leave: () => leave(obj),
            };
            select(obj);
          })
          .on('mouseleave', function (event) {
            leave(d3.select(event.target));
            selected.enter();
          });
      } else {
        dom.on('click', function (event) {
          selected.leave();
          const obj = d3.select(event.target);
          selected = {
            enter: () => stackTrace.text(enter(obj)),
            leave: () => leave(obj),
          };
          stackTrace.text(enter(obj));
          select(obj);
        });
      }
    },
    highlight(enter, leave = () => {}) {
      selected = { enter: () => stackTrace.text(enter()), leave };
      selected.enter();
    },
  };
}
