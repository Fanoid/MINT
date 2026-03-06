import * as d3 from 'd3';
import {
  setTraceInteractionMode,
  getTraceInteractionMode,
  unpickle,
  decodeBase64,
  annotateSnapshot,
} from './core/index.js';
import {
  createTraceView,
  createSegmentView,
  createSettingsView,
} from './components/index.js';

/**
 * View kinds mapping
 */
const kinds = {
  'Active Memory Timeline': createTraceView,
  'Allocator State History': createSegmentView,
  'Active Cached Segment Timeline': (dst, snapshot, device) =>
    createTraceView(dst, snapshot, device, true),
  'Allocator Settings': createSettingsView,
};

/**
 * Application state
 */
const snapshotCache = {};
const snapshotToLoader = {};
const selectionToDiv = {};

/**
 * Unpickle and annotate snapshot data
 */
function unpickleAndAnnotate(data) {
  data = unpickle(data);
  console.log(data);
  annotateSnapshot(data);
  return data;
}

/**
 * Handle snapshot selection change
 */
function snapshotChange(f, view, gpu, snapshotSelect, body) {
  const viewValue = view.node().value;
  let noStartingGpu = gpu.node().value == '';
  let device = Number(gpu.node().value);
  const snapshot = snapshotCache[f];

  gpu.selectAll('option').remove();
  const hasSegments = {};
  for (const s of snapshot.segments) {
    hasSegments[s.device] = true;
  }

  let deviceValid = false;
  let maxTraceLength = -1;
  let defaultDevice = null;

  for (const [i, trace] of snapshot.device_traces.entries()) {
    if (trace.length > 0 || i in hasSegments) {
      gpu.append('option').text(i);
      if (trace.length > maxTraceLength) {
        maxTraceLength = trace.length;
        defaultDevice = i;
      }
      if (i === device) {
        deviceValid = true;
        gpu.node().selectedIndex = gpu.node().children.length - 1;
      }
    }
  }

  if (!deviceValid) {
    device = Number(gpu.node().value);
  }

  if (noStartingGpu) {
    device = defaultDevice;
    gpu.node().value = device;
  }

  const key = [f, viewValue, device];
  if (!(key in selectionToDiv)) {
    selectionToDiv[key] = d3.select(body.node()).append('div');
    kinds[viewValue](selectionToDiv[key], snapshot, device);
  }
  const selectedDiv = selectionToDiv[key];

  selectedDiv.attr('style', 'display: flex; flex-direction: column; flex: 1; min-height: 0');
}

/**
 * Handle view selection change
 */
function selectedChange(snapshotSelect, view, gpu, body) {
  for (const d of Object.values(selectionToDiv)) {
    d.attr('style', 'display: none; flex-direction: column; flex: 1; min-height: 0');
  }
  const f = snapshotSelect.node().value;
  if (f === '') {
    return;
  }
  if (!(f in snapshotCache)) {
    snapshotToLoader[f](f);
  } else {
    snapshotChange(f, view, gpu, snapshotSelect, body);
  }
}

/**
 * Add snapshot to selection
 */
let nextUniqueN = 1;
function addSnapshot(name, loader, snapshotSelect) {
  if (name in snapshotToLoader) {
    name = `${name} (${nextUniqueN++})`;
  }
  snapshotSelect.append('option').text(name);
  snapshotToLoader[name] = loader;
}

/**
 * Finish loading snapshot
 */
function finishedLoading(name, data, snapshotSelect, view, gpu, body) {
  snapshotCache[name] = unpickleAndAnnotate(data);
  snapshotChange(name, view, gpu, snapshotSelect, body);
}

/**
 * Initialize the application
 */
export function initApp() {
  const body = d3.select('body');
  const controls = body.append('div');
  const snapshotSelect = controls.append('select');
  const view = controls.append('select');

  for (const x in kinds) {
    view.append('option').text(x);
  }
  const gpu = controls.append('select');

  // Add interaction mode toggle
  const interactionLabel = body.append('label')
    .attr('style', 'margin-left: 15px; cursor: pointer;');
  const interactionCheckbox = interactionLabel.append('input')
    .attr('type', 'checkbox')
    .attr('id', 'interaction-mode-toggle')
    .attr('style', 'cursor: pointer; margin-right: 5px;');
  interactionLabel.append('span').text('Require click to show trace (applies on file load)');

  interactionCheckbox.on('change', function() {
    const mode = this.checked ? 'click' : 'hover';
    setTraceInteractionMode(mode);
    if (snapshotSelect.node().value) {
      selectedChange(snapshotSelect, view, gpu, body);
    }
  });

  // Setup event handlers
  snapshotSelect.on('change', () => selectedChange(snapshotSelect, view, gpu, body));
  view.on('change', () => selectedChange(snapshotSelect, view, gpu, body));
  gpu.on('change', () => selectedChange(snapshotSelect, view, gpu, body));

  // Drag and drop support
  body.on('dragover', () => {
    event.preventDefault();
  });

  body.on('drop', () => {
    console.log(event.dataTransfer.files);
    Array.from(event.dataTransfer.files).forEach(file => {
      addSnapshot(file.name, (uniqueName) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          finishedLoading(uniqueName, e.target.result, snapshotSelect, view, gpu, body);
        };
        reader.readAsArrayBuffer(file);
      }, snapshotSelect);
    });
    event.preventDefault();
    snapshotSelect.node().selectedIndex =
      snapshotSelect.node().options.length - 1;
    selectedChange(snapshotSelect, view, gpu, body);
  });

  // Initial placeholder
  selectionToDiv[''] = body
    .append('div')
    .text(
      'Drag and drop or select a file to load a local snapshot. No data from the snapshot is uploaded.',
    );

  // File input
  const fileInput = body.append('input')
    .attr('type', 'file')
    .attr('multiple', true)
    .style('margin-left', '8px')
    .on('change', function () {
      Array.from(this.files).forEach(file => {
        addSnapshot(file.name, (uniqueName) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            finishedLoading(uniqueName, e.target.result, snapshotSelect, view, gpu, body);
          };
          reader.readAsArrayBuffer(file);
        }, snapshotSelect);
      });
      this.value = null;
      snapshotSelect.node().selectedIndex =
        snapshotSelect.node().options.length - 1;
      selectedChange(snapshotSelect, view, gpu, body);
    });

  // Update snapshotChange to use the closure variables
  window.snapshotChange = (f) => snapshotChange(f, view, gpu, snapshotSelect, body);
}

/**
 * Add remote files for loading
 */
export function addRemoteFiles(files) {
  files.forEach(f => {
    const snapshotSelectNode = d3.select('select').node();
    const selects = d3.selectAll('select').nodes();
    addSnapshot(f.name, (uniqueName) => {
      console.log('fetching', f.url);
      fetch(f.url)
        .then(x => x.arrayBuffer())
        .then(data => {
          finishedLoading(uniqueName, data, d3.select(selects[0]), d3.select(selects[1]), d3.select(selects[2]), d3.select('body'));
        });
    }, d3.select(snapshotSelectNode));
  });
  if (files.length > 0) {
    const selects = d3.selectAll('select').nodes();
    selectedChange(d3.select(selects[0]), d3.select(selects[1]), d3.select(selects[2]), d3.select('body'));
  }
}

/**
 * Add local files from base64 data
 */
export function addLocalFiles(files, viewValue) {
  const selects = d3.selectAll('select').nodes();
  const viewSelect = d3.select(selects[1]);
  viewSelect.node().value = viewValue;

  files.forEach(f => {
    const snapshotSelect = d3.select(selects[0]);
    addSnapshot(f.name, (uniqueName) => {
      finishedLoading(uniqueName, decodeBase64(f.base64), d3.select(selects[0]), viewSelect, d3.select(selects[2]), d3.select('body'));
    }, snapshotSelect);
  });
  if (files.length > 0) {
    const snapshotSelect = d3.select(selects[0]);
    const gpu = d3.select(selects[2]);
    selectedChange(snapshotSelect, viewSelect, gpu, d3.select('body'));
  }
}

// Export configuration functions
export { setTraceInteractionMode, getTraceInteractionMode };
