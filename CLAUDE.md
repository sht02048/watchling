# Watchling

Watchling is a macOS desktop pet (named Peep) that shows what your Claude Code sessions are doing. It is read-only: it listens to Claude Code hooks and never answers prompts or changes a session. Apple silicon only.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Watch mode. Renderer edits reload, main edits restart the app. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:unit` | Node test runner over `tests/unit` |
| `pnpm test:integration` | Builds the Swift helper, then runs `tests/integration` |
| `pnpm test:e2e tests/e2e/window.test.ts` | Playwright against Electron with a temporary `HOME` |
| `pnpm test:packaged` | Builds the app and checks hook install/relocation in packaged form |
| `pnpm build:local-app` | Fused, ad-hoc signed app and DMG in `build/release/` |
| `pnpm playground` | Browser labs for pet states, companions and the asking cue at http://127.0.0.1:5178/ |
| `pnpm format` | Prettier |

## Layout

- `src/main/` — Electron main: windows, tray, IPC (`ipc.ts`), snapshot publishing, Claude Code auto-connect (`connection.ts`), CLI (`hook-command.ts`).
- `src/integration/claude/` — hook install/uninstall/relocation in `~/.claude/settings.json` (`hook-install.ts`), the Unix socket collector, and the wire protocol.
- `src/domain/observations.ts` — reducer from hook events to per-session states and the snapshot.
- `src/shared/ui-contract.ts` — snapshot types, state labels and the preload bridge contract.
- `src/renderer/pet/` — canvas pet, companions and the asking speech bubble. `src/renderer/sessions/` — the session list.
- `src/playground/` — design labs; their saved JSON configs feed the real renderer.
- `native/hook-emitter/` — Swift helper that Claude Code runs for each hook event.
- `docs/` — design decisions: `state-model.md`, `session-list.md`, `claude-coverage.md`, `landing-page.md`.

## Rules

- **Privacy:** never store, log, display or send raw prompts, `tool_input` or transcripts. Tool input is only reduced to an HMAC fingerprint inside the helper.
- **Read-only:** the app never answers a permission prompt or writes back to Claude Code.
- **Real settings:** tests and scripts must run the app with a temporary `HOME`. Never touch the developer's real `~/.claude/settings.json`.
- **Do not run `tests/e2e/native-window.test.ts`** unattended; it moves the real mouse.
- **Do not build while `pnpm dev` runs.** `pnpm build`, `test:e2e` and `test:packaged` recreate `dist/` and break the dev renderer watcher.
- **Helper changes need a reinstall.** Claude Code always runs the helper inside the installed `/Applications/Watchling.app`, and `pnpm dev` receives events through it. After changing `native/hook-emitter`, run `pnpm build:local-app` and install the new app before checking real sessions.
- **Verify UI in a real Electron window.** The app CSP is strict (`img-src 'self'`, `style-src 'self'`, `script-src 'self'`), so `data:` URLs, `<style>` blocks and `style=""` attributes that work in a plain browser do not render in the app. Setting styles from scripts through `element.style` still works. Draw icons as inline SVG elements.
- **English** for all code, UI text, tests and docs. Match surrounding style; add comments only for non-obvious constraints.

## Local wiki

If `llm-wiki/` exists, it is a gitignored, Korean-language knowledge base of decisions that are not in the code. Read `llm-wiki/index.md` for context and follow `llm-wiki/AGENTS.md` when updating it.
