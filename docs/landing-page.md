# Landing page layout

Decided from a prototype that compared four layouts for the `site/` landing page, a fake macOS desktop running a scripted Claude Code session.

## Decision: Split, with Peep under the state list

- **Left column:** a readable headline ("A desktop pet for Claude Code") with a one-line subhead, then the "Peep's states" list, then Peep. The column is `min(440px, 30vw)` wide.
- **Peep:** sits right below the state list, right-aligned so its body's right edge lines up with the list's right edge, on the side facing the terminal. Its size is `peepSize` in `site/src/config/config.json` (default 210px). Peep shrinks, down to 140px, when the column runs out of height. Companions and the asking "!" are drawn above the list. Peep stays draggable.
- **Terminal:** `max(56px, 5vw)` to the right of the column. Its width is `min(980px, viewport − column − gap − max(32px, 6vw) − max(32px, 4vw))`, and its height is `max(300px, area − 104px − (peepSize × 0.82 + 2px))`. These are the sizes from the prototype.
- **Centring:** the column, the gap and the terminal are centred together as one group in the viewport. The column and the terminal are each centred vertically between the menu bar and the top of the Dock, so the group is centred too.
- **Sessions window:** opens under the state list, to the left of Peep. It narrows to between 240 and 312px so it doesn't cover Peep, and it never covers the terminal.
- **Mobile (<720px):** stacked as headline and subhead, the terminal with its menu, Peep (right-aligned and overlapping the terminal's bottom edge), then the state list.

## Interaction flow

The visitor changes Peep's state only by choosing in the terminal, or with the menu bar's "Connected to Claude Code" toggle. There is no HTML speech bubble. What Peep says appears in the terminal as Peep lines: a small Peep mark, then `Peep · …`, in that state's palette colour.

- **First screen:** a Peep intro line, then the menu. Peep starts idle, and idle is where every flow comes back to.
- **Menu:** "What should Claude do?", with:
  1. Work on a task: working while tool lines stream in. It finishes on its own about 5 seconds after it starts, or at once with "Finish task".
  2. Ask for permission: asking straight away, with the Yes/No prompt.
  3. Run background agents: background, with the agents riding on Peep. A "Finish now" option ends them at once; otherwise they finish one by one after `agentDurations`.
  4. Lose the connection: unknown, with a "Reconnect to Claude Code" option.
- **Controls:** keyboard first, like Claude Code. `↑`/`↓` move and `Enter` chooses; the footer reads "↑↓ to move · Enter to choose". The keys work page-wide without clicking first, except in form fields, while the Watchling menu is open, or with a modifier key held. The Yes/No prompt also takes `←`/`→`, with Yes selected first. Clicking an option works too. Options are buttons with a moving `❯` and roving focus. Rows are 34px tall, or 44px on touch screens.
- **States that last:** working, asking, background and unknown can be ended from the terminal: "Finish task", Yes/No, "Finish now", or "Reconnect to Claude Code". The terminal's controls show the selection with the moving `❯` and highlight rather than a focus ring.
- **After each flow:** a short wrap-up line and a Peep line explaining Peep's state, then the menu again. This repeats without end.
- **Peep lines:** wrapped lines hang-indent so they line up with the message, not under the "Peep" label.
- **Progress:** the "Peep's states" list tracks which states have been found, and its hints name the option that shows each state. The menu itself carries no marks.
- **Timings:** `typeSpeed` and `agentDurations` in `site/src/config/config.json`; a task lasts about 5 seconds. With reduced motion, lines appear at once.

## Rejected

- **Current** (big terminal with Peep in its corner and a faint wallpaper title): Peep and the explanation got the least attention.
- **Center stage** (Peep in the middle with the terminal below): the terminal was too small, and the page was crowded at 1280×720.
- **Monitor** (Peep perched on a centred terminal): the headline, Peep and the bubble fought for the band above the terminal, and the per-state hints were lost.
