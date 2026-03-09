# 🌿 MINT — Modern Memory Insight Tool

An interactive visualization tool for GPU memory snapshots, built with D3.js and Vite.

MINT helps you understand and analyze GPU memory usage by visualizing memory snapshots captured from PyTorch training processes.

## Features

- **Active Memory Timeline** — Visualize memory allocation and deallocation over time
- **Address Space View** — Explore the memory layout with detailed address mapping
- **Trace View** — Analyze memory allocation traces with hierarchical stack information
- **Interactive Navigation** — Zoom, pan, and hover to inspect individual allocations
- **Pickle Snapshot Support** — Load PyTorch memory snapshots directly in the browser

## Getting Started

### Prerequisites

- Node.js >= 18

### Installation

```bash
git clone https://github.com/Fanoid/MINT.git
cd MINT
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
npm run build
npm run preview
```

## Usage

1. Place your PyTorch memory snapshot file (`.pickle`) in the `public/` directory
2. Start the dev server with `npm run dev`
3. Load the snapshot file from the UI
4. Switch between different views to analyze memory usage

## License

[MIT](LICENSE) © [Fanoid](https://github.com/Fanoid)
