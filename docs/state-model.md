# Session state model

## Decision

pagent stays a read-only observer. It never answers permission or question prompts. Because Claude Code command hooks provide no causally correlated human-wait entry/clear pair (see `claude-coverage.md`), `attention` is replaced by `asking`, which means **a prompt was probably shown to the person**, not that a person is confirmed to be waiting.

Comparable projects reach the same limit. Those that know exact wait timing do so only by holding the permission hook open and answering it in-app, which is out of scope here.

## States

Displayed priority: `asking > unknown > working > done > idle`. The pet shows the highest state across sessions.

| State     | Meaning                                          | Enter                                                                                                                                  | Leave                                                        |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `asking`  | A permission or question prompt is likely shown  | `PermissionRequest` or `Notification` (`permission_prompt`) not marked non-interactive; `PreToolUse` for `AskUserQuestion`             | See [Clearing an ask](#clearing-an-ask)                      |
| `working` | A turn is in progress                            | `UserPromptSubmit`; main-session `PreToolUse` / post-tool events; `SubagentStart` before the turn ends                                 | `Stop`; `StopFailure`; interrupt                             |
| `done`    | The turn ended and Claude awaits the next prompt | Main-session `Stop` / `StopFailure`; `PostToolUseFailure` with `is_interrupt`                                                          | `UserPromptSubmit`; main-session tool activity; `SessionEnd` |
| `unknown` | Evidence for this session is broken              | Known transport loss or overflow; a session cap; more than 32 asks; a post-tool fingerprint that matches several fingerprint-only asks | The next `UserPromptSubmit` for that session                 |
| `idle`    | Nothing to report                                | A new session before any turn; no sessions                                                                                             | Any activity                                                 |

Subagent events (`agent_id` present) never move a finished turn back to `working`; background agents can keep running after the main `Stop`. Their asks still count.

No state changes on elapsed time alone. If the receiver fails to start, or a loss occurs while no session is known, the pet shows `unknown` rather than `idle`.

## Signals added to the emitter

- **Interactivity.** `PermissionRequest` also fires in `--print` sessions with no person to answer. For `PermissionRequest` and `Notification` only, the helper reads `CLAUDE_CODE_SESSION_ATTENDED` (`1` / `0`) from the hook environment. Otherwise it walks at most four ancestor processes to the Claude process (`CLAUDE_PID`, or the executable name) and reports `interactive: false` when its arguments contain `-p` / `--print`. Both environment variables are undocumented; when neither path answers, the field is omitted and the request still counts as `asking`.
- **Input fingerprint.** `PermissionRequest` carries no `tool_use_id`. For tool events the helper sends an HMAC-SHA256 of `tool_name` and canonical `tool_input`, truncated to 128 bits. The key is derived from the per-epoch transport token, so fingerprints are not comparable across app runs. The raw input is never sent, logged or stored.

## Clearing an ask

Each ask is keyed by `tool_use_id` when known. A `PermissionRequest` without one is bound to the pending `PreToolUse` whose fingerprint matches exactly one entry; otherwise it is keyed by its fingerprint.

1. A post-tool event or `PostToolBatch` entry with the same `tool_use_id` clears that ask.
2. A post-tool event whose fingerprint matches exactly one fingerprint-only ask clears it. Matching several makes the session `unknown`.
3. A post-tool event that matches nothing changes nothing; parallel tools that needed no prompt are normal.
4. A `PostToolUseFailure` marked as an interrupt clears every ask and ends the turn.
5. `UserPromptSubmit`, main-session `Stop` / `StopFailure` and `SessionEnd` clear every ask in the session.

An ask from a `Notification` alone has no key and is cleared by any post-tool event in the session. Asks are tracked independently; clearing one leaves the others.

## Accepted limits

- An ask answered in the terminal stays `asking` until execution finishes and the matching post-tool event arrives.
- A denial or cancellation without an interrupt event stays `asking` until the next `UserPromptSubmit`. Claude does not send `Stop` after a user interrupt.
- Hook input larger than 1 MiB is dropped by the helper, so an ask whose post-tool event exceeds it clears only at the turn boundary.
- Two simultaneous prompts with identical tool input collapse into one ask.
- Plain-prose questions are never inferred; they appear as `done`.
