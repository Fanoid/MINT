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

  // Hide the drop zone when a snapshot is loaded
  const dropZone = d3.select('.drop-zone');
  if (!dropZone.empty()) {
    dropZone.style('display', 'none');
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
  const body = d3.select('#app');
  body.attr('style', 'display: flex; flex-direction: column; height: 100vh;');

  // === Toolbar ===
  const toolbar = body.append('div').attr('class', 'toolbar');

  // Brand
  const brand = toolbar.append('div').attr('class', 'toolbar-brand');
  brand.append('div').attr('class', 'toolbar-brand-icon').text('M');
  brand.append('span').attr('class', 'toolbar-brand-text').text('MemoryViz');

  toolbar.append('div').attr('class', 'toolbar-divider');

  // Snapshot selector group
  const snapshotGroup = toolbar.append('div').attr('class', 'toolbar-group');
  snapshotGroup.append('span').attr('class', 'toolbar-label').text('Snapshot');
  const snapshotSelect = snapshotGroup.append('select');

  toolbar.append('div').attr('class', 'toolbar-divider');

  // View selector group
  const viewGroup = toolbar.append('div').attr('class', 'toolbar-group');
  viewGroup.append('span').attr('class', 'toolbar-label').text('View');
  const view = viewGroup.append('select');
  for (const x in kinds) {
    view.append('option').text(x);
  }

  toolbar.append('div').attr('class', 'toolbar-divider');

  // GPU selector group
  const gpuGroup = toolbar.append('div').attr('class', 'toolbar-group');
  gpuGroup.append('span').attr('class', 'toolbar-label').text('GPU');
  const gpu = gpuGroup.append('select');

  toolbar.append('div').attr('class', 'toolbar-divider');

  // Interaction mode toggle
  const interactionLabel = toolbar.append('label');
  const interactionCheckbox = interactionLabel.append('input')
    .attr('type', 'checkbox')
    .attr('id', 'interaction-mode-toggle');
  interactionLabel.append('span').text('Click mode');

  interactionCheckbox.on('change', function() {
    const mode = this.checked ? 'click' : 'hover';
    setTraceInteractionMode(mode);
    if (snapshotSelect.node().value) {
      selectedChange(snapshotSelect, view, gpu, body);
    }
  });

  // File open button
  const fileInput = body.append('input')
    .attr('type', 'file')
    .attr('id', 'file-input-hidden')
    .attr('multiple', true);

  const openBtn = toolbar.append('button')
    .attr('class', 'btn btn-primary')
    .on('click', () => fileInput.node().click());
  openBtn.append('span').attr('class', 'btn-icon').text('📂');
  openBtn.append('span').text('Open File');

  // === Content area ===
  const contentArea = body.append('div').attr('class', 'content-area');

  // Drop zone (initial placeholder)
  const dropZone = contentArea.append('div').attr('class', 'drop-zone');
  dropZone.append('div').attr('class', 'drop-zone-icon').text('📁');
  dropZone.append('div').attr('class', 'drop-zone-text')
    .html('Drag & drop snapshot files here<br>or click <b>Open File</b> to browse');
  dropZone.append('div').attr('class', 'drop-zone-hint')
    .text('Supports .pickle files • No data is uploaded');

  // Setup event handlers
  snapshotSelect.on('change', () => selectedChange(snapshotSelect, view, gpu, contentArea));
  view.on('change', () => selectedChange(snapshotSelect, view, gpu, contentArea));
  gpu.on('change', () => selectedChange(snapshotSelect, view, gpu, contentArea));

  // Drag and drop support
  body.on('dragover', (event) => {
    event.preventDefault();
    d3.select('.drop-zone').classed('drag-over', true);
  });

  body.on('dragleave', (event) => {
    // Only remove class if leaving the drop zone entirely
    if (!event.relatedTarget || !d3.select('.drop-zone').node()?.contains(event.relatedTarget)) {
      d3.select('.drop-zone').classed('drag-over', false);
    }
  });

  body.on('drop', (event) => {
    event.preventDefault();
    d3.select('.drop-zone').classed('drag-over', false);
    console.log(event.dataTransfer.files);
    Array.from(event.dataTransfer.files).forEach(file => {
      addSnapshot(file.name, (uniqueName) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          finishedLoading(uniqueName, e.target.result, snapshotSelect, view, gpu, contentArea);
        };
        reader.readAsArrayBuffer(file);
      }, snapshotSelect);
    });
    snapshotSelect.node().selectedIndex =
      snapshotSelect.node().options.length - 1;
    selectedChange(snapshotSelect, view, gpu, contentArea);
  });

  // File input handler
  fileInput.on('change', function () {
    Array.from(this.files).forEach(file => {
      addSnapshot(file.name, (uniqueName) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          finishedLoading(uniqueName, e.target.result, snapshotSelect, view, gpu, contentArea);
        };
        reader.readAsArrayBuffer(file);
      }, snapshotSelect);
    });
    this.value = null;
    snapshotSelect.node().selectedIndex =
      snapshotSelect.node().options.length - 1;
    selectedChange(snapshotSelect, view, gpu, contentArea);
  });

  // Update snapshotChange to use the closure variables
  window.snapshotChange = (f) => snapshotChange(f, view, gpu, snapshotSelect, contentArea);
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
          finishedLoading(uniqueName, data, d3.select(selects[0]), d3.select(selects[1]), d3.select(selects[2]), d3.select('#app'));
        });
    }, d3.select(snapshotSelectNode));
  });
  if (files.length > 0) {
    const selects = d3.selectAll('select').nodes();
    selectedChange(d3.select(selects[0]), d3.select(selects[1]), d3.select(selects[2]), d3.select('#app'));
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
      finishedLoading(uniqueName, decodeBase64(f.base64), d3.select(selects[0]), viewSelect, d3.select(selects[2]), d3.select('#app'));
    }, snapshotSelect);
  });
  if (files.length > 0) {
    const snapshotSelect = d3.select(selects[0]);
    const gpu = d3.select(selects[2]);
    selectedChange(snapshotSelect, viewSelect, gpu, d3.select('#app'));
  }
}

// Export configuration functions
export { setTraceInteractionMode, getTraceInteractionMode };
