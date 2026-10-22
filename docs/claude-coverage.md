# Claude Code hook coverage

## Status

The documented command-hook interface and recorded trials do not supply a correlated human-wait/response pair for either path. Repeating the same trials cannot establish a missing event contract.

The owner therefore chose a read-only model in which `asking` means a prompt was probably shown, not that a person is confirmed to be waiting. The states, signals and clearing rules are defined in [`state-model.md`](state-model.md). The trials below remain the evidence for why `PermissionRequest` alone is not trusted: non-interactive sessions are filtered, and clears are correlated by tool-use ID or input fingerprint.

Evidence boundaries:

- `PermissionRequest.tool_use_id` is absent from the documented schema. The projector would retain a valid top-level ID if supplied; it does not intentionally strip that field.
- Question `tool_response` is not projected. These traces therefore cannot prove that upstream lacks structured outcome/origin metadata. An answer object alone would not establish human origin, because hooks can supply question answers programmatically.
- `PostToolUseFailure` and auto-mode `PermissionDenied` do not provide an exhaustive manual denial/cancellation channel.
- MCP `ElicitationResult` concerns a different interaction, not native permission or `AskUserQuestion`. It is not a substitute.

## Authorized live evidence

The user explicitly authorized temporary installation into actual Claude user settings, bounded test sessions, and removal of test-owned hooks while preserving unrelated settings.

The packaged CLI's real-HOME preview/install/check/uninstall/check round trip passed. Each provider probe also removed its owned hooks in cleanup and verified the canonical settings digest was unchanged. No settings contents, conversation text, tool input/output, or transcripts were saved by the probe. Only the explicitly selected synthetic session's validated native-projected metadata was recorded, with identifiers aliased and project name replaced.

`scripts/probe-live-claude.mjs` requires an explicit authorization argument. It is not part of ordinary tests and must not be run without prior user authorization. Both modes use a temporary empty workspace, a single requested tool, no MCP servers, and restrictive permission prompting. The script pins the resolved Claude executable before querying its version and launching it. The model response is not included in evidence.

- `--authorized-live-negative-control Bash|AskUserQuestion` uses nonpersistent print mode, a 90-second process deadline, and a $0.25 request budget.
- `--authorized-live-interactive-probe Bash|AskUserQuestion` opens a temporary command in Terminal and requires the operator to handle the workspace trust and tool prompts. It has a 120-second wait bound and supervised process cleanup, but does **not** use nonpersistent mode or a request-budget flag. Claude itself may therefore retain the synthetic session; Watchling does not read that history.

### Permission negative control: Claude Code 2.1.306

Command mode: `--print --permission-mode manual --permission-prompts none`, with `permissions.ask: ["Bash"]`. This mode has no human permission-answering host. The request was limited to one harmless `printf watchling-live-probe` tool invocation, with no retry after denial.

Observed projected sequence:

| Event             | Observed identifiers / metadata                               |
| ----------------- | ------------------------------------------------------------- |
| SessionStart      | Session ID                                                    |
| UserPromptSubmit  | Same session, prompt ID, `permissionMode: default`            |
| PreToolUse        | Same prompt, `Bash`, tool-use ID                              |
| PermissionRequest | Same prompt, `Bash`; no tool-use ID in the projected event    |
| PostToolBatch     | Same prompt; `toolCalls` contains that Bash tool-use ID       |
| Stop              | Same prompt, `stopHookActive: false`, empty `backgroundTasks` |
| SessionEnd        | Same session and prompt                                       |

There was no `Notification permission_prompt`, `PostToolUse`, or `PostToolUseFailure` in this recorded session. Absence in one trace is not a general absence guarantee.

**Conclusions:** `PermissionRequest` can occur without a human wait. It cannot unconditionally create attention. `PostToolUseFailure` alone is not an exhaustive denial/clear channel. `PostToolBatch` provides correlated batch metadata in this case, but this trace does not prove visible permission-clear timing or all cancellation paths. The observed `default` mode is the hook metadata; the CLI argument was `manual`.

Evidence: `build/verification/live-negative-control-Bash-1792560040842.json`. The source-controlled fixture contains projected metadata, not raw upstream hook JSON. Aliases are not genuine provider IDs or transport UUIDs.

### Question negative-control attempt: Claude Code 2.1.306

The same noninteractive mode requested only `AskUserQuestion`. The recorded events were SessionStart, UserPromptSubmit, Stop, and SessionEnd; no requested tool invocation was observed. The probe correctly exited unsuccessfully despite a successful provider response. This does **not** establish question-tool wait, auto-answer, or clear coverage. The executable had not yet been resolved to a pinned path for this attempt.

Evidence: `build/verification/live-negative-control-AskUserQuestion-1792559970462.json`.

The preliminary Bash probe's hard-coded `2.1.305` label was not a run-time version measurement and must not be used as version evidence. The version-pinned 2.1.306 rerun above is authoritative for that recorded counterexample.

### Interactive permission allow: Claude Code 2.1.306

The operator approved a Bash invocation that wrote a temporary marker and then slept for two seconds. Relative collector/marker observation times were:

| Observation                            | Milliseconds |
| -------------------------------------- | -----------: |
| PermissionRequest, without tool-use ID |     49125.05 |
| Notification permission_prompt         |     55128.71 |
| Execution marker observed              |     65941.42 |
| PostToolUse, with tool-use ID          |     68028.52 |
| PostToolBatch                          |     68310.33 |
| Stop                                   |     70261.02 |
| SessionEnd                             |     70590.75 |

The notification arrived about six seconds after the permission candidate. PostToolUse arrived about 2.087 seconds after the execution marker was observed. The marker is not the exact timestamp of the person's approval, but establishes that execution had already begun before PostToolUse. This trace therefore does not establish an immediate permission-resolution hook. It does not authorize treating the permission candidate as a confirmed human wait.

Evidence: `build/verification/live-interactive-Bash-1792561827367.json`. Owned hooks were removed, settings digest restored, and the supervised interactive process stopped.

### Interactive question answer: Claude Code 2.1.306

Observed: PreToolUse(AskUserQuestion) at 14305.63 ms, PermissionRequest at 14447.61 ms, PostToolUse at 19849.33 ms, PostToolBatch at 19936.22 ms, Stop at 21257.67 ms, and SessionEnd at 21474.64 ms. No permission notification was captured.

This confirms invocation and return of the requested tool in an operator-driven session. It does not timestamp the actual question's visible wait independently of its permission check, nor prove cancel/deny or automated-answer behavior.

Evidence: `build/verification/live-interactive-AskUserQuestion-1792561891860.json`. Owned hooks were removed, settings digest restored, and the supervised interactive process stopped.

## Remaining required evidence

- Actual visible-wait entry and causal clear signals for permission allow and question answer; permission deny/cancel and question cancel remain untested.
- Plain-prose questions must not become attention.
- Stop/tool failure, actual parallel/child behavior, app-off and mid-session termination.
- Both complete human-wait paths through the real desktop UI; these probes exercised the production helper/collector, not the full live Electron attention path.
- Full fixed N/O acceptance and physical monitor disconnect/reconnect. Passing individual timing/resource measurements does not waive missed producer inputs or missing provider semantics.

Official references: [hooks](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide). Documentation is not a substitute for observed live coverage.

The [mods event reference](https://code.claude.com/docs/en/plugins/mods/reference) was also checked read-only: `tool.check` runs before permission prompting, and the documented render sites do not supply a general permission-dialog open/close pair. No mod was installed, and a render callback is not assumed to prove an outstanding human wait.
