# AGENTS.md

## Project Intent

This repository hosts `shell-ws`, an interactive 2D shell workspace. The UI is a browser app and the kernel is a local Rust service. Keep the UI dense, responsive, and practical. Favor real functionality over speculative abstraction.

## Working Rules

- Do not modify files outside `/per/dev/shell-ws`.
- Keep the UI and kernel loosely coupled over explicit HTTP and WebSocket interfaces.
- Preserve JSON workspace compatibility where reasonable.
- Prefer small, testable pieces over large framework-heavy indirection.
- Add brief comments for subtle, non-obvious logic where future readers would otherwise have to rediscover the reason.
- Add or update tests whenever behavior changes materially.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Initialize and use git in this repo. Create frequent, meaningful commits.
- Commit messages must use a short summary headline, with `WHAT:`, `WHY:`, and `HOW:` sections in the commit body.

## Technical Pushback

- If a request is impossible, contradictory, or disproportionately costly relative to its value, say so clearly and propose the closest viable alternative.
- Do not force a brittle implementation just to satisfy the literal wording of the request.
- If the behavior contract is unclear or the risk of a broken implementation is high, stop and ask the user instead of guessing.

## Architecture Notes

- `ui/` contains the React client.
- `kernel/` contains the Rust execution service.
- Root `package.json` orchestrates local development commands.
- `flake.nix` defines the preferred development environment.

## Quality Bar

- Kernel code should fail clearly and surface execution state to the UI.
- UI interactions should stay smooth with dozens to hundreds of nodes.
- Avoid investor-demo aesthetics. Aim for a clean, tool-like interface.
