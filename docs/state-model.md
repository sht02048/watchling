# Session state model

## Decision

pagent stays a read-only observer. It never answers permission or question prompts. Because Claude Code command hooks provide no causally correlated human-wait entry/clear pair (see `claude-coverage.md`), `attention` is replaced by `asking`, which means **a prompt was probably shown to the person**, not that a person is confirmed to be waiting.

Comparable projects reach the same limit. Those that know exact wait timing do so only by holding the permission hook open and answering it in-app, which is out of scope here.

## States

Displayed priority: `asking > unknown > working > background > idle`. The pet shows the highest state across sessions.

| State        | Meaning                                                  | Enter                                                                                                                                                                              | Leave                                                                                                                                                             |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asking`     | A permission or question prompt is likely shown          | `PermissionRequest` or `Notification` (`permission_prompt`) not marked non-interactive; `PreToolUse` for `AskUserQuestion`                                                         | See [Clearing an ask](#clearing-an-ask)                                                                                                                           |
| `working`    | A turn is in progress                                    | `UserPromptSubmit`; main-session `PreToolUse`, `PermissionRequest` and post-tool events                                                                                            | `Stop`; `StopFailure`; interrupt                                                                                                                                  |
| `unknown`    | Evidence for this session is broken                      | Known transport loss or overflow; a session cap; more than 32 asks; a post-tool fingerprint that matches several fingerprint-only asks; a session first seen mid-turn after a loss | The next `UserPromptSubmit` for that session                                                                                                                      |
| `background` | The main turn ended while background subagents still run | `PostToolUse` for `Agent` reporting `async_launched`, once the main turn is `idle`                                                                                                 | `SubagentStop` for each launched agent; an empty `background_tasks` list on `Stop` / `SubagentStop`; `UserPromptSubmit` shows `working` while agents keep running |
| `idle`       | Claude awaits the next prompt, or nothing is observed    | A new session; main-session `Stop` / `StopFailure`; `PostToolUseFailure` with `is_interrupt`; no sessions                                                                          | `UserPromptSubmit`; main-session tool activity                                                                                                                    |

Subagent events (`agent_id` present) never move an `idle` session to `working`; background agents can keep running after the main `Stop`. Their asks still count.

Events that arrive after `SessionEnd` are ignored unless they start a new turn, so late deliveries cannot revive an ended session.

No state changes on elapsed time alone. If the receiver fails to start, or a loss occurs while no session is known, the pet shows `unknown` rather than `idle`.

While `asking`, a speech bubble with `!` pops in above the pet's head, then nudges with a short burst (bob, zoom or wiggle, varied each time) every few seconds and stays still in between. It disappears as soon as the ask clears. Its look and timing come from `src/renderer/pet/attention.json`, tuned in the attention lab (`pnpm playground`, then `/attention.html`).

Each running background subagent also appears as a small companion sitting on the pet's head, up to three, whatever the displayed state; they take the pet's current colors. Their look and motion come from `src/renderer/pet/companions.json`, tuned in the companions lab (`pnpm playground`, then `/companions.html`).

Background shell tasks are not counted, so a long-running dev server does not keep the pet out of `idle`. The launch `agentId` is assumed to match the `agent_id` on that subagent's `SubagentStop`; this has not been confirmed against a live session.

## Signals added to the emitter

- **Interactivity.** `PermissionRequest` also fires in `--print` sessions with no person to answer. For `PermissionRequest` and `Notification` only, the helper reads `CLAUDE_CODE_SESSION_ATTENDED` (`1` / `0`) from the hook environment. Otherwise it walks at most four ancestor processes to the Claude process (`CLAUDE_PID`, or the executable name) and reports `interactive: false` when its arguments contain `-p` / `--print`. Both environment variables are undocumented; when neither path answers, the field is omitted and the request still counts as `asking`.
- **Input fingerprint.** `PermissionRequest` carries no `tool_use_id`. For tool events the helper sends an HMAC-SHA256 of `tool_name` and canonical `tool_input`, truncated to 128 bits. The key is derived from the per-epoch transport token, so fingerprints are not comparable across app runs. The raw input is never sent, logged or stored.

## Clearing an ask

Each ask is keyed by `tool_use_id` when known. A `PermissionRequest` without one is bound to the pending `PreToolUse` whose fingerprint matches exactly one entry; otherwise it is keyed by its fingerprint.

1. A post-tool event or `PostToolBatch` entry with the same `tool_use_id` clears that ask.
2. A post-tool event whose fingerprint matches exactly one fingerprint-only ask clears it. Matching several clears those asks and makes the session `unknown`, which is shown instead of a possibly stale `asking`. Overflowing 32 asks does the same.
3. A post-tool event that matches nothing changes nothing; parallel tools that needed no prompt are normal.
4. A `PostToolUseFailure` marked as an interrupt clears every ask and ends the turn.
5. `UserPromptSubmit`, main-session `Stop` / `StopFailure` and `SessionEnd` clear every ask in the session.

An ask from a `Notification` alone has no key and is cleared by any post-tool event in the session. Asks are tracked independently; clearing one leaves the others.

## Accepted limits

- An ask answered in the terminal stays `asking` until execution finishes and the matching post-tool event arrives.
- A denial or cancellation without an interrupt event stays `asking` until the next `UserPromptSubmit`. Claude does not send `Stop` after a user interrupt.
- Hook input larger than 1 MiB is dropped by the helper, so an ask whose post-tool event exceeds it clears only at the turn boundary.
- Input over 64 KiB or 10,000 JSON nodes is not fingerprinted, keeping the helper inside its 150 ms budget. Such a `PermissionRequest` becomes an unkeyed ask, cleared by the next post-tool event in its session.
- `-p` given as the value of another option is read as non-interactive when the environment does not say otherwise.
- Two simultaneous prompts with identical tool input collapse into one ask.
- Plain-prose questions are never inferred; they appear as `idle`.
