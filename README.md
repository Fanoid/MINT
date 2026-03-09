# 🌿 MINT — Modern Memory Insight Tool

**MINT** (**M**odern Memory **In**sight **T**ool) is an interactive visualization tool for GPU memory snapshots, built with D3.js and Vite. It helps you understand and analyze GPU memory usage by visualizing memory snapshots captured from [PyTorch training processes](https://pytorch.org/blog/understanding-gpu-memory-1/).

Inspired by and built upon [PyTorch Memory Viz](https://docs.pytorch.org/memory_viz), MINT serves as a **drop-in replacement** with enhanced interactivity and a modernized tech stack.

## Features

- **Active Memory Timeline** — Visualize memory allocation and deallocation over time
- **Address Space View** — Explore the memory layout with detailed address mapping
- **Trace View** — Analyze memory allocation traces with hierarchical stack information
- **Interactive Navigation** — Zoom, pan, and hover to inspect individual allocations
- **Pickle Snapshot Support** — Load PyTorch memory snapshots directly in the browser

## Getting Started

Visit [https://fanoid.github.io/MINT/](https://fanoid.github.io/MINT/) and upload your profiler snapshot file directly — no installation needed.

Or, to run locally, see the [Development](#development) section below.

## Development

### Prerequisites

- Node.js >= 18

### Installation

```bash
git clone https://github.com/Fanoid/MINT.git
cd MINT
npm install
```

### Dev Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
npm run build
npm run preview
```

## License

[MIT](LICENSE) © [Fanoid](https://github.com/Fanoid)
