# AGENTS.md

## Project Intent

This repository hosts `shell-ws`, an interactive 2D shell workspace. The UI is a browser app and the kernel is a local Rust service. Keep the UI dense, responsive, and practical. Favor real functionality over speculative abstraction.

## Architecture Notes

- `ui/` contains the React client.
- `kernel/` contains the Rust execution service.
- Root `package.json` orchestrates local development commands.
- `flake.nix` defines the preferred development environment.

## Working Guidance

- Keep the UI and kernel loosely coupled over explicit HTTP and WebSocket interfaces.
- Preserve JSON workspace compatibility where reasonable.
- Prefer small, testable pieces over large framework-heavy indirection.
- Add brief comments for subtle, non-obvious logic where future readers would otherwise have to rediscover the reason.
- Add or update tests whenever behavior changes materially.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Kernel code should fail clearly and surface execution state to the UI.
- UI interactions should stay smooth with dozens to hundreds of nodes.
- Avoid investor-demo aesthetics. Aim for a clean, tool-like interface.
- After each medium-small- to large- sized change, do a pass over the code and look for potential simplifications, easy perf wins, ways to improve documentation and readability, and any accidental mistakes, potential bugs, or dead code.
- If a change is implemented that will not be seen until the user restarts the kernel, be sure to give explicit instructions to do so

## VCS Guidance

- Use git in this repo. Create frequent, meaningful commits.
- Commit messages must use a short summary headline, with `WHAT:`, `WHY:`, and `HOW:` sections in the commit body.
- If a change is a direct modification to the changes made in HEAD, or a small, highly-related addition, commit the change as an amend.
- When creating commit bodies from the shell, ensure newlines are genuine 0x0A values and not a "\" followed by an "n" (unless that's what's intended). Two ways to ensure this are using multiple `-m` flags or a heredoc/file.

