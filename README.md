# pagent

pagent is a small desktop pet for macOS that shows what your Claude Code sessions are doing. It is read-only: it listens to Claude Code hooks and never answers prompts or changes a session.

Apple silicon only.

## Install

1. Build the DMG with `pnpm build:local-app`, or use one you were given. It is written to `build/release/pagent-<version>-arm64.dmg`.
2. Open the DMG and drag `pagent.app` to `/Applications`.
3. Launch it. pagent has no Dock icon; it lives in the menu bar and as the pet on screen.

The app is ad-hoc signed and not notarized. If macOS refuses the first launch, right-click `pagent.app` and choose **Open**. On macOS versions where that is not offered, use **System Settings → Privacy & Security → Open Anyway**.

## Claude Code hooks

pagent learns about sessions through hooks in `~/.claude/settings.json`. Nothing is changed until you ask:

```sh
/Applications/pagent.app/Contents/MacOS/pagent hooks check
/Applications/pagent.app/Contents/MacOS/pagent hooks install            # preview
/Applications/pagent.app/Contents/MacOS/pagent hooks install --apply
/Applications/pagent.app/Contents/MacOS/pagent hooks uninstall --apply
```

Install adds only pagent's own handlers and keeps the rest of the file. Uninstall removes exactly those handlers. A backup of the previous settings is kept in `~/Library/Application Support/pagent/hook-backups`.

If hooks were installed from another copy of the app, launching pagent from `/Applications` or `~/Applications` moves them to the new helper path. It never installs hooks you have not installed before.

## States

The pet shows the most urgent state across sessions: `asking`, `unknown`, `working`, `background`, `idle`. See [docs/state-model.md](docs/state-model.md) for what each one means and when it changes, and [docs/claude-coverage.md](docs/claude-coverage.md) for the hook evidence behind it.

## Development

| Command                 | What it does                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`            | Build and run the app from source                                                                                                                                                     |
| `pnpm dev`              | Run from source with watch: renderer edits reload the windows, main edits restart the app. Quits the installed app first; real Claude events still arrive through the installed hooks |
| `pnpm playground`       | Open a browser page to preview every pet state                                                                                                                                        |
| `pnpm build`            | Bundle main, preload and renderers into `dist/`                                                                                                                                       |
| `pnpm build:helper`     | Build the Swift hook helper                                                                                                                                                           |
| `pnpm build:local-app`  | Package the app and DMG into `build/release/`                                                                                                                                         |
| `pnpm typecheck`        | Type-check the project                                                                                                                                                                |
| `pnpm test:unit`        | Unit tests                                                                                                                                                                            |
| `pnpm test:integration` | Hook helper integration tests                                                                                                                                                         |
| `pnpm test:packaged`    | Package, then test the hooks CLI and relocation in a temp HOME                                                                                                                        |
| `pnpm test:e2e`         | Playwright window tests                                                                                                                                                               |
| `pnpm format`           | Format with Prettier                                                                                                                                                                  |

`build/release/` holds the fused production app. `build/unfused/` holds the same app without Electron fuses so Playwright can drive it (`node scripts/drive-local-app.mjs`).
