# Landing page layout

Decided from a prototype that compared four layouts for the `site/` landing page, a fake macOS desktop running a scripted Claude Code session.

## Decision: Split, with Peep under the state list

- **Left column:** a readable headline ("A desktop pet for Claude Code") with a one-line subhead, then the "Peep's states" list, then Peep. The column is `min(440px, 30vw)` wide.
- **Peep:** sits right below the state list, its body aligned with the column's left edge. Its size is the `peepSize` knob (default 210px). Peep shrinks, down to 140px, when the column runs out of height. Companions and the asking "!" are drawn above the list. Peep stays draggable.
- **Speech bubble:** to Peep's right, facing the terminal, with its tail on Peep. Its width is capped so it ends 16px before the terminal. When less than 200px is free, it moves above Peep inside the left column. The first bubble ends with "Try Run task →".
- **Terminal:** `max(56px, 5vw)` to the right of the column. Its width is `min(980px, viewport − column − gap − max(32px, 6vw) − max(32px, 4vw))`, and its height is `max(300px, area − 104px − (peepSize × 0.82 + 2px))`. These are the sizes from the prototype.
- **Centring:** the column, the gap and the terminal are centred together as one group in the viewport. The column and the terminal are each centred vertically between the menu bar and the top of the Dock, so the group is centred too.
- **Sessions window:** opens under the bubble beside Peep. It never covers the terminal.
- **Mobile (<720px):** stacked as headline and subhead, terminal, Peep with the bubble, then the state list.

## Rejected

- **Current** (big terminal with Peep in its corner and a faint wallpaper title): Peep and the explanation got the least attention.
- **Center stage** (Peep in the middle with the terminal below): the terminal was too small, and the page was crowded at 1280×720.
- **Monitor** (Peep perched on a centred terminal): the headline, Peep and the bubble fought for the band above the terminal, and the per-state hints were lost.
