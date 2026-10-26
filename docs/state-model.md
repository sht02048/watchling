# Session state model

## Decision

Watchling stays a read-only observer. It never answers permission or question prompts. Because Claude Code command hooks provide no causally correlated human-wait entry/clear pair (see `claude-coverage.md`), `attention` is replaced by `asking`, which means **a prompt was probably shown to the person**, not that a person is confirmed to be waiting.

Comparable projects reach the same limit. Those that know exact wait timing do so only by holding the permission hook open and answering it in-app, which is out of scope here.

## States

Displayed priority: `asking > unknown > working > subagents > waiting > idle`. The pet shows the highest state across sessions.

| State        | Meaning                                                  | Enter                                                                                                                                                                              | Leave                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asking`     | A permission or question prompt is likely shown          | `PermissionRequest` or `Notification` (`permission_prompt`) not marked non-interactive; `PreToolUse` for `AskUserQuestion`                                                         | See [Clearing an ask](#clearing-an-ask)                                                                                                                                                       |
| `working`    | A turn is in progress                                    | `UserPromptSubmit`; main-session `PreToolUse`, `PermissionRequest` and post-tool events                                                                                            | `Stop`; `StopFailure`; interrupt                                                                                                                                                              |
| `unknown`    | Evidence for this session is broken                      | Known transport loss or overflow; a session cap; more than 32 asks; a post-tool fingerprint that matches several fingerprint-only asks; a session first seen mid-turn after a loss; a session whose record from while the app was closed restarted or is unreadable | The next `UserPromptSubmit` for that session                                                                                                                                                  |
| `subagents`  | The main turn ended while background subagents still run | `PostToolUse` for `Agent` reporting `async_launched`, or for `SendMessage` reporting a `resumedAgentId`; `SubagentStart` for a workflow subagent; once the main turn is `idle`     | `SubagentStop` for each launched agent; an empty `background_tasks` list on `Stop` / `SubagentStop` (except workflow subagents); `UserPromptSubmit` shows `working` while agents keep running |
| `waiting`    | The main turn ended while a background shell task still runs | The latest `Stop` / `SubagentStop` lists a `background_tasks` entry of type `shell` (or `local_bash`) with status `running`, once the main turn is `idle` | A later `background_tasks` list without one; `UserPromptSubmit` shows `working` |
| `idle`       | Claude awaits the next prompt, or nothing is observed    | A new session; main-session `Stop` / `StopFailure`; a main turn end from the mod; no sessions                                                                                      | `UserPromptSubmit`; main-session tool activity                                                                                                                                                |

Subagent events (`agent_id` present) never move an `idle` session to `working`; background agents can keep running after the main `Stop`. Their asks still count. Any other subagent event that arrives while the main turn is `idle` comes from a background agent, since foreground subagents end with their turn, so it adds that agent to the background set if it is missing. This brings back an agent whose launch Watchling never saw, for example one started before Watchling restarted; it reappears with its next event.

Events that arrive after `SessionEnd` are ignored unless they start a new turn, so late deliveries cannot revive an ended session.

No state changes on elapsed time alone. If the receiver fails to start, or a loss occurs while no session is known, the pet shows `unknown` rather than `idle`.

### While the app is closed

When no endpoint is published, or its socket is gone (after a reboot), the helper appends the event to `pending/<session_id>.jsonl` in the app's data folder (`0700` folder, `0600` files), together with the Claude process ID and start time. The event is projected exactly as for the socket but without an input fingerprint, since there is no epoch key. Only lowercase UUID session IDs are recorded. A refused connection is not taken as a closed app, since a busy app refuses too; events after a crash, until the next launch, are dropped. A main-session `SessionEnd` deletes the session's file. A file holds at most 256 KB and starts over with a lost marker when full; at most 32 sessions are recorded.

On launch the app publishes its endpoint first, then renames `pending` to claim it. A helper checks the endpoint again after opening `pending`, so an event either lands in the claimed folder or goes to the socket. The app waits 300 ms for helpers that opened the folder before the rename, keeps sessions whose Claude process (ID and start time) still runs, and feeds their events through the reducer before any live event. A restarted or unreadable record marks that session `unknown` until a turn starts. Asks recorded this way have no fingerprint, so they clear on the session's next post-tool event.

Each session also records when its displayed state last changed, the tool it is running, the tool or question it is asking about, and its background agent count. The session list ([`session-list.md`](session-list.md)) turns these into short summaries and an elapsed time; the time is display-only.

While `asking`, a speech bubble with `!` pops in above the pet's head, then nudges with a short burst (bob, zoom or wiggle, varied each time) every few seconds and stays still in between. It disappears as soon as the ask clears. Its look and timing come from `src/renderer/pet/attention.json`, tuned in the attention lab (`pnpm playground`, then `/attention.html`).

Each running background or workflow subagent also appears as a small companion sitting on the pet's head, up to three, whatever the displayed state; they take the pet's current colors. Their look and motion come from `src/renderer/pet/companions.json`, tuned in the companions lab (`pnpm playground`, then `/companions.html`).

Workflow subagents are recognized when `SubagentStart` has `agent_type` `workflow-subagent`; the helper forwards only `subagentKind: "workflow"`, never the `agent_type` text. Other `SubagentStart` events are not counted, because foreground subagents end with their turn. Workflow subagents are not cleared by an empty `background_tasks` list, since it is not known whether running workflows appear in it; only their `SubagentStop` or `SessionEnd` removes them.

Background shell tasks (`type: "shell"`, for example a `Bash` command run in the background) show as `waiting`: Peep turns mint with a small satellite circling it. Otherwise `waiting` rests like `idle`, only later: Peep dozes off after ten minutes and dims (with Dim When Idle) after ten and a half, so a dev server left running does not keep it awake for good. A session that is `waiting` still exists, so Hide When No Sessions never applies. No hook fires when such a task ends, so the count only changes with the next `Stop` or `SubagentStop`, which follows once Claude is told the task finished; an interrupt or a `StopFailure` keeps the last count, since the tasks usually keep running. Claude Code documents only the `running` status, so only `running` and `pending` entries count. A list that holds nothing but shell tasks also clears background agents, because any agent still remembered must have missed its stop. The launch `agentId` is assumed to match the `agent_id` on that subagent's `SubagentStop`; this has not been confirmed against a live session.

## Turns that end without Stop

No hook fires when the user interrupts a turn (Esc or Ctrl+C) or dismisses a permission prompt with Esc: the hooks reference says `Stop` does not run on an interrupt, and cancelling a running tool does not fire `PostToolUseFailure` either. Claude Code's own `turn.complete` event fires for every turn end, so Watchling ships a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (`resources/claude-mod/`). The installer copies it to `claude-mod` in the app's data folder and adds that folder to `env.CLAUDE_CODE_PLUGIN_DIRS` in the user settings, alongside the hooks; uninstalling removes both.

Measured on Claude Code 2.1.310: Esc during a streamed answer and Esc during a running `Bash` call each end the turn with `isAborted: true`, and Esc on a permission prompt ends it with `reason: "answer"`; none of the three runs `Stop` or `PostToolUseFailure`. A turn that finishes normally runs `Stop` about 200 ms before `turn.complete`.

When a main-loop turn ends and, within a second, no prompt is submitted and no other main-loop turn starts, the mod reads the helper path from the installation manifest and runs the helper with a `TurnEnded` event. The event carries only the session ID and working directory, read when the turn ended, so a `/clear` in that second cannot redirect it. The mod never reads or forwards the turn's answer. The reducer then ends the main turn: it goes `idle` and drops its asks, including those of foreground agents, which end with the turn, while background agents, their asks and shell tasks stay. After a normal finish, `Stop` has already ended the turn. The second covers a queued prompt or a Stop hook that keeps Claude going, either of which starts the next turn at once. A prompt submitted in the few milliseconds between that second and the helper's delivery could still be ended by the late event until its next tool call.

The installation manifest keeps version 1, so older builds still manage the hooks; they leave the mod's settings entry and folder behind, and the mod then finds no helper that accepts its event.

The mod needs Claude Code with mods (2.1.287 or later) and the `$.process` API, which only the CLI provides, so sessions in the desktop app or the Agent SDK still stay `working` until the next prompt. An organization's managed settings can turn off user mods (`allowManagedModsOnly`, `allowManagedHooksOnly`, `disableAllHooks`). A turn that ends while the mod reloads is missed.

## Signals added to the emitter

- **Interactivity.** `PermissionRequest` also fires in `--print` sessions with no person to answer. For `PermissionRequest` and `Notification` only, the helper reads `CLAUDE_CODE_SESSION_ATTENDED` (`1` / `0`) from the hook environment. Otherwise it walks at most four ancestor processes to the Claude process (`CLAUDE_PID`, or the executable name) and reports `interactive: false` when its arguments contain `-p` / `--print`. Both environment variables are undocumented; when neither path answers, the field is omitted and the request still counts as `asking`.
- **Input fingerprint.** `PermissionRequest` carries no `tool_use_id`. For tool events the helper sends an HMAC-SHA256 of `tool_name` and canonical `tool_input`, truncated to 128 bits. The key is derived from the per-epoch transport token, so fingerprints are not comparable across app runs. The raw input is never sent, logged or stored.

## Clearing an ask

Each ask is keyed by `tool_use_id` when known. A `PermissionRequest` without one is bound to the pending `PreToolUse` whose fingerprint matches exactly one entry; otherwise it is keyed by its fingerprint.

1. A post-tool event or `PostToolBatch` entry with the same `tool_use_id` clears that ask.
2. A post-tool event whose fingerprint matches exactly one fingerprint-only ask clears it. Matching several clears those asks and makes the session `unknown`, which is shown instead of a possibly stale `asking`. Overflowing 32 asks does the same.
3. A post-tool event that matches nothing changes nothing; parallel tools that needed no prompt are normal.
4. A main turn end reported by the mod, or a `PostToolUseFailure` marked as an interrupt, clears the asks of the main turn and ends it. Asks from subagents stay, since background agents keep running.
5. `UserPromptSubmit`, main-session `Stop` / `StopFailure` and `SessionEnd` clear every ask in the session.

An ask from a `Notification` alone has no key and is cleared by any post-tool event in the session. Asks are tracked independently; clearing one leaves the others.

## Accepted limits

- An ask answered in the terminal stays `asking` until execution finishes and the matching post-tool event arrives.
- Without the mod, a denial or cancellation without an interrupt event stays `asking` until the next `UserPromptSubmit`. Claude does not send `Stop` after a user interrupt; only the mod reports one (see [Turns that end without Stop](#turns-that-end-without-stop)).
- Hook input larger than 1 MiB is dropped by the helper, so an ask whose post-tool event exceeds it clears only at the turn boundary.
- Input over 64 KiB or 10,000 JSON nodes is not fingerprinted, keeping the helper inside its 150 ms budget. Such a `PermissionRequest` becomes an unkeyed ask, cleared by the next post-tool event in its session.
- `-p` given as the value of another option is read as non-interactive when the environment does not say otherwise.
- Two simultaneous prompts with identical tool input collapse into one ask.
- Plain-prose questions are never inferred; they appear as `idle`.
