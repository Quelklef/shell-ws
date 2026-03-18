# Shell-WS Plan

## Summary

`shell-ws` is a browser-based 2D shell workspace backed by a local Rust kernel. Users place nodes on a canvas, write bash or other shell snippets, connect ports visually, and execute the graph with push, pull, or timed auto-run semantics.

## Main Decisions

- UI is a browser app built with React and TypeScript.
- Kernel is a local Rust service exposing HTTP and WebSocket APIs.
- Workspaces are stored as JSON files on the kernel side.
- Process nodes default to `bash` but allow per-node shell override.
- `stdout` and `stderr` are separate output ports.
- Wires own buffering strategy: `unbuffered`, `line_or_1024`, or `on_complete`.
- Cycles are allowed, with a default 250 ms delivery delay to avoid runaway loops.
- Auto-run is per node, defaults to 1000 ms, and supports both push and pull modes.

## MVP Scope

- Process, text, display, and merge nodes.
- Canvas interactions: pan, zoom, drag-select, resize, minimap, and selected-group layout.
- Streaming output indicators on ports.
- Display rendering for text, JSON, YAML, TOML, XML, Markdown, SVG, images, and audio/video where possible.
- Workspace save/load via JSON.
- Tests for kernel execution logic and core UI behavior.

## Implementation Phases

1. Create reproducible project scaffolding and root documentation.
2. Build the Rust kernel with persistence, execution, and streaming.
3. Build the React UI with interactive graph editing and display rendering.
4. Integrate client and kernel, then verify with automated tests.
