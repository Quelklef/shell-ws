# shell-ws

`shell-ws` is an interactive 2D shell workspace with a browser UI and a local Rust kernel.

## Architecture

- The browser UI owns the live workspace state and sends a full workspace snapshot to the kernel for each run.
- The Rust kernel is responsible for execution and disk persistence, but execution no longer reloads workspace state from disk.
- Workspace saves are separate from execution, so failed persistence does not change what the user runs.

## Run

For the reproducible path on NixOS:

```bash
nix develop -c just dev
```

That starts the Rust kernel on `http://127.0.0.1:4000` and the Vite UI on `http://127.0.0.1:5173`.

To run the built app after a production build:

```bash
nix develop -c just build
nix develop -c cargo run --manifest-path kernel/Cargo.toml
```

The kernel serves `ui/dist` when it exists, so `http://127.0.0.1:4000` becomes the single app entrypoint.

## Test

```bash
nix develop -c just test
```
