import * as d3 from 'd3';

/**
 * StackInfo component for displaying stack traces
 */
export function StackInfo(outer) {
  const stackTrace = outer
    .append('pre')
    .attr('class', 'segment-stack-panel');

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
    },
    highlight(enter, leave = () => {}) {
      selected = { enter: () => stackTrace.text(enter()), leave };
      selected.enter();
    },
  };
}
