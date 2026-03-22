# AGENTS.md

## Project Intent

This repository hosts `shell-ws`, an interactive 2D shell workspace. The UI is a browser app and the kernel is a local Rust service. Keep the UI dense, responsive, and practical. Favor real functionality over speculative abstraction.

## Architecture Notes

- `ui/` contains the React client.
- `kernel/` contains the Rust execution service.
- Root `package.json` orchestrates local development commands.
- `flake.nix` defines the preferred development environment.

## Working Rules

- Do not modify files outside `/per/dev/shell-ws`.
- NEVER read from, write to, move, delete, or otherwise touch paths outside `/per/dev/shell-ws` without explicit user consent. This includes exploratory searches, cleanup, migration, and recovery attempts.
- Keep the UI and kernel loosely coupled over explicit HTTP and WebSocket interfaces.
- Preserve JSON workspace compatibility where reasonable.
- Prefer small, testable pieces over large framework-heavy indirection.
- Add brief comments for subtle, non-obvious logic where future readers would otherwise have to rediscover the reason.
- Add or update tests whenever behavior changes materially.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Initialize and use git in this repo. Create frequent, meaningful commits.
- Commit messages must use a short summary headline, with `WHAT:`, `WHY:`, and `HOW:` sections in the commit body.
- When creating commit bodies from the shell, use real newlines via multiple `-m` flags or a heredoc/file; do not embed literal `\n` sequences in commit text.
- Kernel code should fail clearly and surface execution state to the UI.
- UI interactions should stay smooth with dozens to hundreds of nodes.
- Avoid investor-demo aesthetics. Aim for a clean, tool-like interface.

## Communication Style

- NEVER prompt the user with the interactive multiple-choice question feature. ALWAYS use the standard text chat instead. This allows for nuanced back-and-forth instead of shoehorning the user into making a final choice. You MAY present the user with a set of multiple-choice questions, formatted similar to how they would be if using the interactive feature, but you MUST NOT actually use the feature.
- Communicate directly and efficiently. Do not repeat points the user already made or restate your earlier answer unless doing so is necessary to resolve ambiguity or support a new conclusion.
- Do not repeat points the user already acknowledged unless there is new information, a correction, or the repetition is strictly necessary for precision.
- After answering the direct question, stop. Do not restate prior context, rationale, or conclusions unless the user asks for elaboration.
- Prefer delta-style responses: say only what changed, what is true, or what to do next.
- If the user asks a narrow follow-up, answer only that narrow follow-up.
- Assume the user remembers the immediately preceding exchange. Treat repeated explanation as a mistake unless it adds new content.
- As an exception to the above, when reporting completed changes provide a short, one-line summary of what was done.

## Technical Pushback

- If a request is impossible, contradictory, or disproportionately costly relative to its value, say so clearly and propose the closest viable alternative.
- Do not force a brittle implementation just to satisfy the literal wording of the request.
- If the behavior contract is unclear or the risk of a broken implementation is high, stop and ask the user instead of guessing.
- You MUST NOT implement workarounds, hacks, or fallback behaviors without the user's explicit consent. Diagnose first; if a workaround seems useful, propose it clearly and wait for approval.

