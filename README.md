<p align="center">
  <img src="resources/icon.svg" width="128" height="128" alt="Watchling icon">
</p>

<h1 align="center">Watchling</h1>

<p align="center"><b>A quiet desktop pet that watches your Claude Code sessions.</b></p>

<p align="center">
  <a href="https://github.com/sht02048/watchling/releases/latest"><img src="https://img.shields.io/badge/download-latest-brightgreen?style=flat-square" alt="Download"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B%20Apple%20silicon-blue?style=flat-square" alt="macOS 13+ on Apple silicon">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <img src="docs/assets/watchling.gif" width="800" alt="Peep turns orange while Claude works, carries companions for background agents, turns purple with a speech bubble when a session needs you, and opens the session list on click">
</p>

Start a long task, switch to something else, and look up when Peep turns purple. Peep busies itself while Claude works, carries little companions when background agents run, and pops a speech bubble when a session is waiting for your approval or answer. Watchling only watches: it never answers prompts or approves tools for you.

## Features

- **Live session state** — Peep shows the most urgent state across all your Claude Code sessions
- **Attention bubble** — a purple speech bubble when a session needs approval or an answer, with no sounds or notifications
- **Background companions** — up to three small companions ride on Peep's head while background agents run
- **Session list** — click Peep to see every session grouped by project, with what it's doing and for how long
- **Auto-connect** — hooks install on first launch and can be turned off from the menu bar
- **Local and read-only** — nothing leaves your Mac, and Watchling never changes a session

## Install

Download the latest `.dmg` from [Releases](https://github.com/sht02048/watchling/releases/latest), move Watchling to Applications and launch it. It connects to Claude Code on first launch and shows a one-time notification.

Requires macOS 13 or later on Apple silicon.

> [!NOTE]
> Builds are not notarized yet. If macOS blocks the first launch, right-click Watchling and choose **Open**.

## Usage

### Peep's states

<!-- Image: Peep in each state -->

| Peep looks              | Meaning                                          |
| ----------------------- | ------------------------------------------------ |
| Purple, speech bubble   | A session is waiting for your approval or answer |
| Grey                    | Watchling missed some signals and can't tell     |
| Orange                  | Claude is working                                |
| Blue, companions on top | Only background agents are running               |
| Coral                   | Nothing to do                                    |

With several sessions open, Peep shows the one highest in this table. See [docs/state-model.md](docs/state-model.md) for the full rules.

### Session list

<!-- Image: session list grouped by project -->

Click Peep to open the list, and click again or press <kbd>Esc</kbd> to close it. Sessions are grouped by project. Each line shows what the session is doing and how long it has been in that state. Hover a line to see the full session ID and copy it.

### Menu bar

Watchling has no Dock icon. Use the menu bar icon to show or hide Peep, turn the Claude Code connection on or off, and quit. Drag Peep anywhere on screen; it remembers where you left it.

## How it works

```
Claude Code ──hook──▶ watchling-hook-emitter ──local socket──▶ Watchling ──▶ Peep
```

Watchling adds hooks to `~/.claude/settings.json`. For each event, Claude Code runs a small Swift helper that forwards a few fields to the app over a local Unix socket. Each hook has a one-second timeout and never replies to Claude Code. While the app isn't running, the helper keeps the same fields in `~/Library/Application Support/watchling/pending`, and Watchling picks them up when it starts.

## Privacy

The helper sends event metadata such as session and tool IDs, the event type, tool names, permission mode and the project folder name. While the app is closed, that metadata waits on disk until the next launch. Prompts, tool input and transcripts are never stored, shown or sent. Tool input is reduced to a one-way fingerprint inside the helper so permission requests can be matched to their tool calls. Watchling makes no network requests.

## FAQ

**Peep doesn't react to my sessions.**
Make sure Watchling runs from Applications and **Connected to Claude Code** is ticked in the menu bar menu. Sessions that ran while Watchling was closed appear when it starts, if their Claude Code process is still running. Sessions from before Watchling was installed appear after their next prompt or tool call.

**Will it slow down Claude Code?**
No. Each hook has a one-second timeout and returns nothing.

**Can I approve permission requests from Peep?**
No, by design. Watchling only tells you that a session needs you; you answer in the terminal.

**What exactly does it change in my settings?**
It adds only its own hook handlers and keeps the rest of `~/.claude/settings.json`. The previous file is backed up to `~/Library/Application Support/watchling/hook-backups`.

## Uninstall

Choose **Uninstall Watchling…** in the menu bar menu. Watchling removes its hooks from `~/.claude/settings.json`, moves itself to the Trash and quits. Optionally delete `~/Library/Application Support/watchling` afterwards.

If you trash the app first, Claude Code keeps working; the leftover hooks check for the helper and do nothing. Installing Watchling again picks them up, even if you deleted its data folder.

## Build from source

<details>
<summary>Only needed for contributing or testing unreleased changes.</summary>
<br>

Requires macOS 13+ on Apple silicon, Node.js 24, pnpm 10 and the Xcode command line tools.

```sh
git clone https://github.com/sht02048/watchling.git
cd watchling
pnpm install
pnpm dev
```

`pnpm make` packages the app and DMG into `build/release/`. Tests, scripts and project layout are described in [CLAUDE.md](CLAUDE.md).

</details>

## Contributing

Issues and pull requests are welcome. Run `pnpm typecheck`, `pnpm test:unit` and `pnpm test:integration` before opening a pull request, and keep the privacy rule: no prompts, tool input or transcripts may be stored, logged, shown or sent.

## License

[MIT](LICENSE). Watchling is an independent project and is not affiliated with Anthropic.
