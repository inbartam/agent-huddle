# Fixtures

Recorded Claude Code payloads, scrubbed, one scenario per file. Tests replay them.

S-numbers (S5, S16, …) name experiments run on the author's machine during development; the experiment log is not published.

The fixtures were recorded from real Claude Code sessions and scrubbed with in-house tools that are not published.
Each line is one captured hook or telemetry request.

Before a payload is copied here: replace real paths with `C:/Users/user/project`, replace prompt
and message text with short neutral text, remove tokens and anything private, keep ids consistent
within the file. The scrubber did this, with three exceptions kept for the ADR-012 tests:

- `PostToolUse(Agent).tool_response` keeps `agentId`, `isAsync`, `status` and `resolvedModel` only; every other tool_response is dropped.
- A prompt keeps its opening tag (`<task-notification>`, `<agent-message from="agent-2">`); a task notification also keeps its
  `<task-id>`, `<tool-use-id>` and `<status>`. The rest becomes `(scrubbed text)`.
- Any key starting with `user.` or `organization.` is removed.

`npm run test:scripts` checks every fixture for the Agent link and for emails, identity keys, the user name and real paths.

Each line has this shape:

```json
{"t":"2026-11-13T15:22:19.000Z","kind":"hook","event":"SubagentStart","payload":{}}
```

`kind` is `hook`, `otlp-logs`, `otlp-metrics`, `otlp-traces` or `statusline`.

| File | Shows |
|---|---|
| `single-agent.jsonl` | One main agent, two Reads and a Glob; a `Stop` blocked once by a follow-up (S7b), so the second `Stop` has `stop_hook_active: true` |
| `parallel-subagents.jsonl` | Two Explore subagents launched **async** (`tool_response.agentId`, `isAsync`); main `Stop` while they run (`background_tasks`), `<task-notification>` prompts with `task-id`/`tool-use-id` re-entering as `UserPromptSubmit`, two unanswered `PermissionRequest`s inside subagents, `api_request` per agent. Headless |
| `nested-subagents.jsonl` | general-purpose subagent (foreground, `status: completed`, no `isAsync`) spawning an Explore subagent; parent visible on the inner `PreToolUse(Agent)`, child in `tool_response.agentId`, and as `parent_agent_id` in telemetry. Headless |
| `failure.jsonl` | `PostToolUseFailure` on a missing file; four `PermissionRequest`s left unanswered in a headless run (no `PermissionDenied`, no `PostToolUse`) |
| `compaction.jsonl` | Manual `/compact` via stream-json: `PreCompact` → `SubagentStop` with empty `agent_type` and no `SubagentStart` → `SessionStart(source=compact, model)` → `PostCompact` |
| `permission-allow.jsonl` | `PermissionRequest(Bash)` held by the Huddle and allowed → `PostToolUse(Bash)` |
| `permission-deny.jsonl` | `PermissionRequest(Bash)` held and denied with a message → no `PostToolUse`, no `PermissionDenied` |
| `interactive-helpers.jsonl` | Interactive session (owner check, 19:17): `SessionStart` with `model`, main loop `api_request` with `query_source: repl_main_thread`, helper `api_request`s `generate_session_title` (haiku) and `prompt_suggestion`, a bare helper `SubagentStop` (empty `agent_type`, no `SubagentStart`), `AskUserQuestion`, `SessionEnd` |
| `statusline-docs-sample.jsonl` | **Docs-derived, not recorded.** Five status line stdin payloads (`kind: "statusline"`, `event: null`) built from the field list in INTEGRATION.md "Status line data": session start (`current_usage` null, no `rate_limits`), two calls with usage and both limit windows, after `/compact` (`current_usage` null again), and one with only `five_hour`. Replace with a scrubbed interactive capture when spike S12 runs. Listed separately (`listStatuslineFixtureFiles`), because it has no hook or telemetry lines |
| `tasks-enabled.jsonl` | Spike S4b, headless with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`: `ToolSearch` loads `TaskCreate`/`TaskUpdate`; three `PreToolUse(TaskCreate)` (`subject`, `description`, `activeForm`) each followed by `TaskCreated` (`task_id` 1–3); `PreToolUse(TaskUpdate)` `{taskId, status: in_progress}` then `completed`, each `completed` followed by `TaskCompleted`. **Hooks only, no telemetry** (`HOOKS_ONLY_FIXTURES`) |
| `agent-messages.jsonl` | Session whose main loop reports `query_source: sdk` (no `model` on `SessionStart`), `generate_session_title`, two async Explore subagents that hand back with `SubagentHandback` → `<agent-message from="agent-N">` prompt → `SubagentStop`; `subagent_completed` telemetry |
| `mcp-progress.jsonl` | **Reconstructed from reduced S19 evidence (case e2), not a raw capture.** Spike S19, Claude Code 2.1.325, haiku, `-p` with `--mcp-config` (server key `huddle`): `mcp__huddle__report_progress` called four times by the main agent and once by a general-purpose subagent (`agent_id` present, `fraction: 1` at its own finish); `PreToolUse`/`PostToolUse` with `tool_input` `{fraction, minutesLeft, note}` and `mcp_server`; Glob, Read, ToolSearch and a foreground Agent call around them; `SubagentStart`/`SubagentStop`, `SessionEnd`. Times, order, ids (session and agent renamed), tool names, fractions and minutes are as recorded; the notes are replaced with short neutral text; `tool_input` of the other tools, `effort`, `prompt_id` and the `SessionEnd` reason were not kept by the evidence and are left out; `mcp_server.source` was recorded only as a 7-character string and is written as `dynamic` (assumed: the scope of a `--mcp-config` server); `PostToolUse(Agent).tool_response` is rebuilt from `SubagentStart` (`agentId`, `status: completed`, foreground). Hooks only (`HOOKS_ONLY_FIXTURES`) |
| `agent-team.jsonl` | Spike S20 (b), Claude Code 2.1.325, haiku, an **interactive** `--teammate-mode in-process` session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`: the lead creates teammates `alpha` and `beta` through `Agent` calls with `name` (`subagent_type: general-purpose`, `model: haiku`), then one unnamed general-purpose subagent. Teammate `agent_id` `a<name>-<16 hex>` with `agent_type` = the name, plain subagent `a<16 hex>`; one `session_id` for all; `SubagentStop` then `TeammateIdle` (`teammate_name`, `team_name` `session-<first 8 of the session id>`) about 20 ms later; a `<task-notification>` for the plain subagent; `Stop` whose `background_tasks` lists the teammates as `type: "teammate"`; two helper `SubagentStop`s (empty `agent_type`, no `SubagentStart`); `TaskStop` with `task_id` = a teammate name. No `SessionStart` (it did not reach HTTP hooks), no `TaskCreated`/`TaskCompleted` (not observed). Made with a one-off converter over `scripts/lib/scrub.mjs` with pre-seeded ids so the id **shapes** survive: session `00000000-0000-4000-8000-000000000001`, teammates `aalpha-0000000000000001`/`abeta-0000000000000002`, others `a000000000000000N`; times and order as recorded. The spike server had dropped every `tool_response`, so the Agent calls carry none (`NO_AGENT_LINK_FIXTURES`). Hooks only (`HOOKS_ONLY_FIXTURES`) |
| `agent-team-report.jsonl` | **Derived from `agent-team.jsonl`, not recorded** (M6 P5b, ADR-027): the same S20 (b) lines with the session id changed to `00000000-0000-4000-8000-000000000002` (so it never merges with the recorded run), plus four lead lines inserted after both teammates went idle (12:30:29.931-.940, before the recorded `UserPromptSubmit`): `PreToolUse`/`PostToolUse` of `mcp__huddle__report_teammate` with `tool_input` `{name: "alpha", status: "finished"}` and `{name: "beta", status: "waiting", note: "waits for the reply"}`, no `agent_id` (the lead), `mcp_server: {name: "huddle", source: "user"}` (assumed: the scope of a `claude mcp add --scope user` server; S19 recorded only a 7-character string for a `--mcp-config` one), no `tool_response`. Hooks only, no Agent link (`HOOKS_ONLY_FIXTURES`, `NO_AGENT_LINK_FIXTURES`). Replace with a real capture once a team run exercises the tool |
| `stream-s16-team.jsonl` | **Reconstructed from reduced S16 evidence, not a raw capture.** Spike S16 (d), Claude Code 2.1.325: a `-p` stream-json run with three `--agents` subagents (`s16-lister`, `s16-reader`, `s16-grepper`). `kind: "stream"`, `event: null`, `payload` = one stdout line. `system/init` (capabilities array, tools without MCP names, agents limited to built-ins and `s16-*`), main-loop `Agent` tool_use, 9 subagent messages whose `parent_tool_use_id` is one of 3 Agent ids, `task_*` system lines, one `rate_limit_event`, one `result` success. Listed separately (`listStreamFixtureFiles`) |
| `stream-s16-interrupt.jsonl` | **Reconstructed, as above.** Spike S16 (a): a Bash call interrupted over stdin → `control_response` success → `result` `error_during_execution`; then a second turn (second `system/init`) ending in `result` success |

The two `stream-*` files were made with a one-off converter, because `npm run fixture:scrub` reads hook and telemetry lines
only. The S16 evidence is already reduced (no tool output, text clipped to 200 characters); the converter put each line back
into its stream-json shape (`message.content[]`, `rate_limit_info`, `response`, `permission_denials[]` from the recorded
count) and replaced every free-text value with `(scrubbed text)` and every path with `C:/Users/user/project`. Init keys the
evidence did not keep values for are left out. Ids, numbers, subtypes and the order of lines are as recorded.
