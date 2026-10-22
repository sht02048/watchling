# Session list

Decided from a prototype comparing five directions for the 320×280 list that opens from the pet.

## Decision: Grouped

- One line per session, grouped by project. A project with one session stays a single line; a project with several gets a header line (state dot of its most urgent session, name, session count, and "N needs you" when any session asks) followed by indented session lines.
- Each session line shows a state dot, a short ID only when the project has more than one session, a short summary and the time in its current state. The short ID ends in `…` to show it is a prefix; hovering a line shows the full session ID as a tooltip and reveals a copy button.
- Summaries: `Approve <tool>`, `Answer a question`, `Needs approval` (prompt without a tool name), `Running <tool>`, `Working`, `N background agents`, `Missed signals`, `Idle`. MCP tools read as `server · tool`.
- A top line shows `N sessions` and, when any session asks, `N need you`. Asking lines get a light purple wash.
- Order: projects by their most urgent session, sessions by state priority then most recent change.
- Elapsed time counts from the last displayed state change, ticks in the renderer and uses tabular figures. It is display-only and never changes a state.
- Removed: window title, Close button (Escape still closes), the aggregate sentence that repeated the pet, per-session reason sentences that repeated the badge, and the standing footer. The "start Claude Code" hint appears only when the list is empty.

## Rejected

- **Current** — every message said the same thing three times (pet, aggregate sentence, badge plus reason), and three sessions already overflowed the window.
- **Triage** — "needs you" cards were the clearest call to action, but each card took two lines, so with several sessions the rest of the list scrolled out of view.
- **Ledger** — the densest option, but a project with several sessions repeated its name on every line.
- **Companion** — per-session avatars and speech bubbles carried the pet's personality, but used two lines per session and grew with sentence length.
