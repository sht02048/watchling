# Session list

Decided from a prototype comparing five directions for the 320×280 list that opens from the pet.

## Decision: Grouped

- One line per session, grouped by project. A project with one session stays a single line; a project with several gets a header line (state dot of its most urgent session, name, session count, and "N needs you" when any session asks) followed by indented session lines.
- Each session line shows a state dot, a short ID only when the project has more than one session, a short summary and the time in its current state. The short ID ends in `…` to show it is a prefix; hovering a line shows where it opens, its project and summary, and the full session ID as a tooltip.
- Clicking a line brings the session's terminal app to the front with `open -b`, using the `__CFBundleIdentifier` the helper inherits from it. Inside Orca the helper also sends `ORCA_TERMINAL_HANDLE`, and the app first runs Orca's bundled CLI (`orca terminal switch`) to select that tab. Only lines whose events carried one of these values are clickable, and they end in a `›`. Known bundle IDs are named in the tooltip and menu ("Show in Orca"); others read "Show Terminal". Clickable lines have the button role. Other terminals' tabs are not selected, because that needs AppleScript, an automation permission prompt and an extra entitlement. The app never sends input to a terminal and never calls Orca commands that read terminal contents.
- The list opens 10 px above Peep's drawn body, not its mostly transparent window, so the gap looks the same at every pet size. It lines up with the body's edge that faces the middle of the screen: its right edge when Peep is on the right half, its left edge otherwise. Without room above, it opens 10 px below the body.
- The context menu's **Stop Tracking** keeps a session listed but leaves it out of Peep: its state, companions and asks no longer count, and Hide When No Sessions treats it as gone. Its line moves below the tracked ones in its project, with a hollow dot, muted text, "Not tracked" and no elapsed time. **Resume Tracking** brings it back with its current state. The choice lasts until the session ends or Watchling quits.
- Copying the session ID moved from an inline button to the line's context menu (right-click), so a click on the line always means one thing.
- The list never takes keyboard focus: a focused Watchling window makes macOS switch away from a full-screen app's Space. It shows without activating Watchling and closes when Peep is clicked again, a line is opened, or the pointer stays off both the list and Peep for a second (not while a line's menu is open).
- Summaries: `Approve <tool>`, `Answer a question`, `Needs approval` (prompt without a tool name), `Running <tool>`, `Working`, `N background agents`, `Waiting on N background tasks`, `Missed signals`, `Idle`. MCP tools read as `server · tool`.
- A top line shows `N sessions` and, when any session asks, `N need you`. Asking lines get a light purple wash.
- Order: projects by their most urgent session, sessions by state priority then most recent change.
- Elapsed time counts from the last displayed state change, ticks in the renderer and uses tabular figures. It is display-only and never changes a state.
- Removed: window title, Close button, the aggregate sentence that repeated the pet, per-session reason sentences that repeated the badge, and the standing footer. The "start Claude Code" hint appears only when the list is empty.

## Rejected

- **Current** — every message said the same thing three times (pet, aggregate sentence, badge plus reason), and three sessions already overflowed the window.
- **Triage** — "needs you" cards were the clearest call to action, but each card took two lines, so with several sessions the rest of the list scrolled out of view.
- **Ledger** — the densest option, but a project with several sessions repeated its name on every line.
- **Companion** — per-session avatars and speech bubbles carried the pet's personality, but used two lines per session and grew with sentence length.
