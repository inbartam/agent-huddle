# Claude Code integration notes

This is the project's cache of facts about Claude Code that the Huddle depends on.

S-numbers (S5, S16, …) name experiments run on the author's machine during development; the experiment log is not published.

- **Checked against the public docs on 2026-11-13; status line, model windows, `--settings` and `api_request` re-checked 2026-11-14; one-shot read-only `-p` flags (§3, F25) checked 2026-11-14; Channels, cross-session messaging, agent teams, team hooks and MCP notes (§1, §3) docs-checked 2026-11-16, not run-checked (M6 spikes S20, S21).** Docs-checked is not run-checked: nothing here
  has been confirmed on this machine yet. Items marked unproven were still to be confirmed by experiment.
- Claude Code changes quickly. Before writing code against anything below, run
  `/verify-claude-api <topic>` and update this file with the date and `claude --version`.
- Index of all doc pages: https://code.claude.com/docs/llms.txt (append `.md` to a page URL for Markdown).

## 0. Run-checked on this machine (2026-11-13, Claude Code 2.1.323)

Experiments run on the author's machine during development (S0, S1, ...). Where a run differed from, or added to, the docs-checked text below, it is listed here
first; the sections below are annotated "run-checked" where they were confirmed as written.

**Hooks**
- Every session on the machine reports, **including sessions that were already running** when settings.json changed.
- `SessionStart` on `source: startup` has `model` in **interactive** sessions (terminal and VS Code) but **not in headless `-p`** runs;
  on `source: compact` it has one. Fallback: the main loop's telemetry `api_request.model` (skip the helper `query_source`s below),
  the Agent tool's `resolvedModel`, or `PostModelSwitch`.
- **Hidden helper agents**: Claude Code runs helpers that look like subagents (`SubagentStop` with an empty `agent_type` and no
  `SubagentStart`) or show up as extra `api_request`s: `query_source` `generate_session_title` (haiku), `prompt_suggestion`,
  `away_summary`. Hide them.
- The interactive main-loop `query_source` is `repl_main_thread` (headless: `sdk`). Some setups hand subagent results back through a
  `SubagentHandback` tool and an `<agent-message …>` UserPromptSubmit instead of a `<task-notification>`.
- **Handback order** (16 handbacks in the M0 logs, see S2): the subagent's `PostToolUse(SubagentHandback)` with
  `tool_response.success: true` is always followed by `SubagentStop` for the same `agent_id` (0.37–1.5 s later, nothing in between). The
  parent session gets `UserPromptSubmit` `<agent-message from="<agentId>">`, usually just before that `SubagentStop`, but after it when
  the parent was busy. A **failed** handback (`success: false`) does not end the agent: it keeps working and stops later. A
  `<task-notification>` for the same agent can still arrive after all this (its `<task-id>` is the `agentId`, its `<tool-use-id>` the
  Agent call's `tool_use_id`). A stopped subagent that gets a message is **resumed**: a new `SubagentStart` with the **same** `agent_id`.
- Users in **auto permission mode** rarely get a `PermissionRequest`; the inbox matters mostly in default mode.
- `InstructionsLoaded` fields: `file_path, memory_type, load_reason, globs, trigger_file_path` (+ `agent_id/agent_type` inside subagents).
- `PostCompact` carries `compact_summary` (free text: clip, never store in fixtures). Compaction itself shows up as a
  **`SubagentStop` with an empty `agent_type` and no `SubagentStart`** between `PreCompact` and `PostCompact`.
- `Stop` and `SubagentStop` carry `background_tasks: [{id, type:"subagent", status, description, agent_type}]` and `session_crons`.
- **Subagents often run async** even without `run_in_background`: `PostToolUse(Agent)` returns at once with
  `tool_response: {isAsync:true, status:"async_launched", agentId, resolvedModel, …}`, the main agent may `Stop` while they run,
  and each finished subagent re-enters as a **`UserPromptSubmit` whose prompt is a `<task-notification>`** (new `prompt_id`).
- `PostToolUse(Agent).tool_response.agentId` links the Agent call (`tool_use_id`) to the subagent (`agent_id`), for async and
  foreground agents. The spawning call's own `agent_id` is the parent. Foreground `tool_response` also has `totalTokens`,
  `totalToolUseCount`, `totalDurationMs`, `usage`, `resolvedModel`.
- A hook `deny` on `PermissionRequest` does **not** fire `PermissionDenied` (auto mode only). In `-p` runs a `PermissionRequest` that
  gets no decision is auto-denied (`--permission-prompts none` is the explicit form of that).
- Held `PreToolUse`: parallel calls are held independently; at the hook `timeout` Claude Code closes the request and proceeds.
  Interactive terminals show only the normal spinner while a call is held.
- Held `PermissionRequest` (interactive): Claude Code's own prompt stays visible, the first answer wins, and a `Notification`
  `permission_prompt` fires after ~6 s. **On 2.1.325 an answer in the terminal does not close the held request** (run-checked
  2026-11-14, SPIKES S1): the tool runs (`PostToolUse`) while the hook connection stays open. The Huddle ends the hold itself.
- Right after a held `AskUserQuestion` was released with no decision, 2.1.325 sends a `PermissionRequest` with
  `tool_name: "AskUserQuestion"` before showing its own question box (run-checked 2026-11-14). It is not an approval: the Huddle
  answers it at once with no decision and shows no card.
- `AskUserQuestion` (interactive) can be answered from `PreToolUse` with allow + `updatedInput.answers`; the terminal shows it as the user's answer.
- **With the Huddle down**, a headless run prints one stderr line (the `SessionEnd` hook), but an **interactive terminal prints a
  `hook error · connect ECONNREFUSED` line for every HTTP hook** (each prompt, before and after each tool call, Stop).
- Hook answer latency on loopback: median 2.1 ms; refused connection 1.8 ms.

**Telemetry**
- `api_request` attributes: `agent_id` (subagents only), `parent_agent_id` (nested subagents only), `query_source`
  (`sdk` main loop of `-p`, `agent:builtin:<type>`), `model`, token fields incl. `cache_creation_5m/1h_tokens`, **`cost_usd`**
  (sums equal Claude Code's `total_cost_usd` exactly), `duration_ms`, `ttft_ms`, `request_id`, `prompt.id`, `effort`, `speed`.
- **Every record carries `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`.** Drop at ingest.
- Also emitted: `hook_execution_start/complete` (with `num_hooks`, `total_duration_ms`), `hook_registered`, `plugin_loaded`,
  `mcp_server_connection`, `tool_decision`, `tool_result`, `user_prompt`, `assistant_response`, `subagent_completed`.

**Tools**
- **Task tools are model-gated** (v2.1.268+): on current models there is no `TaskCreate`/`TaskUpdate` unless
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set (or `--allowedTools TaskCreate`). With it, `TaskCreated`/`TaskCompleted` fire and
  `PreToolUse(TaskUpdate)` carries `{taskId, status: in_progress|completed}` (S4b, 2026-11-14); `PostToolUse` repeats the same
  `tool_input`, which the Huddle reads for `task.started` (the id is also read from `task_id`/`id` as a guard; only `taskId` is recorded). Without it nothing fires. See ADR-010.
- **No `AskUserQuestion`** in `-p` / stream-json runs; present in interactive sessions. See S5.

**`claude -p` stream-json**: stdin line `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`;
a new `system/init` per turn; `/model <name>` works as a message; `rate_limit_event` carries
`unifiedWindows.<window>.utilization` and `resetsAt`; `apiKeySource: "none"` on a subscription login. `--session-id <uuid>` sets the id.
Windows Git Bash rewrites a leading `/` in arguments into a path (`/compact` → `C:/Program Files/Git/compact`): spawn from Node
with `shell: false` or set `MSYS_NO_PATHCONV=1`.

## 1. Hooks

Source: https://code.claude.com/docs/en/hooks · guide: https://code.claude.com/docs/en/hooks-guide

### Configuration
Hooks live under `hooks` in a settings file. User scope is `~/.claude/settings.json` (applies to
every project, which is what the Huddle wants). Shape:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "http", "url": "http://127.0.0.1:47821/huddle/hooks/PreToolUse", "timeout": 5, "headers": { "X-Huddle-Token": "…" } } ] } ] } }
```

- Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Not every event supports every type.
- **`SessionStart` and `Setup` accept only `command` and `mcp_tool`.** Hence `scripts/huddle-forward-hook.mjs`.
- `PermissionRequest` accepts `command`, `http`, `mcp_tool`, `prompt` (not `agent`).
- Leaving `matcher` out matches everything. For tool events the matcher is the tool name.
- Header values may interpolate `$VAR` only for names listed in `allowedEnvVars`. The Huddle
  writes the token literally instead, so nothing depends on the environment.

### HTTP hook behavior
| Situation | Result |
|---|---|
| 2xx, empty body | success, no decision |
| 2xx, JSON body | parsed with the same output schema as command hooks |
| 2xx, non-JSON body | non-blocking error |
| non-2xx, connection refused | non-blocking error, the action proceeds |
| timeout | hook cancelled, the action proceeds |

So an absent Huddle fails open by default. An `onFailure: "block"` option exists (v2.1.295+) for
hooks that must fail closed; the Huddle does not use it.

Default timeouts: 600 s for `command`, `http`, `mcp_tool` (30 s on `UserPromptSubmit`; `SessionEnd`
hooks share about 1.5 s). `timeout` is per hook entry, in seconds.

### Reload, user-visible messages, quiet failure (docs-checked 2026-11-13 for ADR-014 / WP8; run-checked 2026-11-14, S11)
Run-checked on this machine (S11): removing the hooks while an interactive session runs stops its hook calls with no error lines,
and a SessionStart command hook's `systemMessage` is shown to the user once, not added to Claude's context, and not repeated after `/clear`.
- **Edits to `hooks` reach running sessions, including removals (docs).** https://code.claude.com/docs/en/settings
  ("When edits take effect"): "Claude Code watches your settings files and reloads them when they change, so it applies most edits to
  the running session without a restart, including edits to `permissions`, `hooks`, and credential helpers". The hooks page
  ("Disable or remove hooks"): "Direct edits to hooks in settings files are normally picked up automatically by the file watcher."
  Run-checked only for *adding* hooks (S0 surprise 2). Removal is not run-checked yet: S11.
- **`systemMessage` from a SessionStart command hook is shown to the user (docs, not run-checked).** https://code.claude.com/docs/en/hooks
  ("Hook input and output"): "To surface a message to the user on any platform, return `systemMessage` in JSON output. Some events
  discard it or deliver it elsewhere, and each event's section says so." The SessionStart section does not list it as discarded, and
  it suggests it ("report what resuming a stale conversation costs before the first request, for example in a `systemMessage`"). The
  JSON output table: "`systemMessage` … Warning message shown to the user." Discarded on: Setup, Notification, ConfigChange, PreCompact,
  PostCompact, SessionEnd, WorktreeRemove, Elicitation(Result); async hooks deliver it to Claude instead of the user.
  - Stdout rules: only **plain-text** stdout of a SessionStart hook is added to Claude's context. Stdout that is exactly one JSON object
    is parsed as JSON output instead ("your stdout counts as JSON output only when you print one JSON object … with nothing around it
    but whitespace"). So `{"systemMessage":"…"}` on stdout, exit 0, should show the hint without putting text in the context.
  - The other documented channel, exit 2 + stderr, renders as a `SessionStart hook error` notice. Not used: the hint is not an error.
  - Not run-checked: S11.
- **No quiet-failure option for HTTP hooks (docs).** A refused connection is a non-blocking error ("**Connection failure**:
  non-blocking error"), shown as "a `<hook name> hook error` notice in the transcript". `onFailure` takes only `"continue"` or
  `"block"`. `suppressOutput` "Has no effect: Claude Code accepts the field but doesn't act on it." `disableAllHooks` exists but turns
  off every hook, the user's own included ("There is no way to disable an individual hook while keeping it in the configuration").
  So ADR-014 option (b), attach while running, stands.

### Fields on every event
`session_id`, `hook_event_name`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`
(absent before the first prompt), `effort.level`, and **`agent_id` + `agent_type` only when the
event fires inside a subagent**. That last pair is how tool calls are attributed to a subagent.
Run-checked (2026-11-13, Claude Code 2.1.323): most events also carry **`scratchpad_dir`**, the session's temp scratchpad folder
(SessionStart, UserPromptSubmit, Pre/PostToolUse, Stop, SubagentStart/Stop, InstructionsLoaded, SessionEnd in the fixtures). It is a
local path; the Huddle does not use it and the normalizer does not copy it into events.

### Events the Huddle registers, and what they carry
| Event | Extra input fields | Huddle use |
|---|---|---|
| `SessionStart` | `source` (startup, resume, clear, compact, fork), `model` (may be absent), `session_title` | session row, model |
| `UserPromptSubmit` | `prompt`, `session_title` | timeline, status working |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | timeline, current activity, policy rules, pause, nudge |
| `PostToolUse` | + `tool_response` (can be huge), `duration_ms` | timeline, tool count |
| `PostToolUseFailure` | + `error`, `is_interrupt` | failures, loop detection |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions` (no `tool_use_id`) | approvals inbox |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id`, `reason` (auto mode only) | timeline |
| `Notification` | `message`, `title`, `notification_type` (permission_prompt, idle_prompt, agent_needs_input, agent_completed, …) | status waiting, toasts |
| `SubagentStart` | `agent_id`, `agent_type` (of the new subagent) | new tree node |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`; run-checked also `background_tasks`, `session_crons` (session-wide, §0) | node done, handoff result |
| `TaskCreated` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `agent_id?` (v2.1.290+), `team_name?` (deprecated, "will be removed"; do not rely on it). Does not fire in a session without the Task tools. No matchers | progress total |
| `TaskCompleted` | same. Fires on an explicit TaskUpdate and also when a teammate ends its turn with in-progress tasks | progress completed |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | status idle, follow-up delivery |
| `StopFailure` | (fields not yet confirmed) | status failed |
| `PreCompact` / `PostCompact` | `trigger` (manual, auto), `custom_instructions`; PostCompact also `compact_summary` (run-checked, §0) | context health |
| `PostModelSwitch` | `from_model`, `to_model`, `source` | model per agent |
| `InstructionsLoaded` | `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path` (run-checked, §0) | context inspector |
| `TeammateIdle` | `teammate_name`, `team_name` (deprecated), `agent_id?` (v2.1.290+, the in-process teammate). Exit 2 keeps the teammate working; `{"continue":false}` stops it. Docs-checked 2026-11-16 (hooks.md). **Run-checked (S20, 2.1.325)**: also `agent_type` = the name; follows the teammate's `SubagentStop` by ~20 ms. The Huddle answers it with an empty 200 (observation only) and logs `teammate.idle` | agent teams (S20, M6): teammate idle, waiting for messages |
| `SessionEnd` | `reason` (clear, resume, logout, prompt_input_exit, other) | session ended, report |

Deliberately not registered: `WorktreeCreate` (a hook replaces the default worktree creation),
`PreModelSwitch` (a slow answer blocks the switch), `Elicitation`, `ConfigChange`, `MessageDisplay`.

### Decisions a hook can return
- **`PermissionRequest`**: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny", …}}}`.
  With allow: optional `updatedInput`, `updatedPermissions`. With deny: optional `message`, `interrupt`.
- **`PreToolUse`**: `hookSpecificOutput.permissionDecision` = `allow` | `deny` | `ask` | `defer`, plus
  `permissionDecisionReason`, `updatedInput`, `additionalContext`.
  **A hook's allow does not bypass the user's own deny or ask rules.** Good: Huddle rules can
  remove prompts but cannot remove safeguards.
- **`Stop` / `SubagentStop`**: `{"decision":"block","reason":"…"}` keeps the agent going with the
  reason as its next instruction. Loop guards exist (`stop_hook_active`, a cap on consecutive continuations).
- **`PostToolUse`**: may add `additionalContext`.

### What the Huddle sends back (M3, `packages/core/src/ingest/hook-replies.ts`)
Only these shapes, each proven by a spike: PermissionRequest allow, or deny with an optional `message` (S1), sent as
`Denied by the user in Agent Huddle. Their message: <message>` (`DENY_PREFIX`; a bare instruction was read by the model as
unattributed tool output in the M3 runbook, 2026-11-14; the logged `approval.resolved.message` is the user's text without it);
PreToolUse(AskUserQuestion) allow with `updatedInput: {...tool_input, answers: {<question>: <answer>}}` (S5): one label for
single-select; for multi-select the labels in option order joined with `", "`; typed ("Other") words verbatim, after the labels (S14 b,
wired 2026-11-17); PreToolUse `additionalContext` prefixed `Note from the user via Agent Huddle: ` (S7a);
Stop `{"decision":"block","reason"}`, never when `stop_hook_active` (S7b); otherwise an empty 200 (no decision).
A held reply ends in one of four ways, each logged as an event: the user decides; a rule decides (hook point only, M4); Claude
Code closes the request (`res` closed before we wrote: `expired` when within 2 s of the hook timeout, else `answered_elsewhere`,
an inference from timing), or the terminal prompt is over while the request is still open (2.1.325, S1): for the same agent the
same call ended (`PostToolUse`, `PostToolUseFailure` or `PermissionDenied` with the same tool name and input digest, or the same
one-line summary), or its turn is over (`Stop`; `SubagentStop` for a subagent; a new `UserPromptSubmit` for the main agent), or
`SessionEnd`. The Huddle then answers with an empty 200 (ignored by then) and logs `answered_elsewhere` by `claude_code`. An
unrelated call of the same agent does not end it. The Huddle quits (empty 200, `by: shutdown`). The broker lets go itself 5 s before the hook timeout
(`hold_limit`). PreToolUse and PermissionRequest are installed with `timeout: 600` (ADR-019).

### Windows
- HTTP hooks need no shell, which is one reason the Huddle prefers them.
- Command hooks run in Git Bash when installed, otherwise PowerShell (`shell` field selects).
  A command written as `node "C:/path/file.mjs"` works in both.
- The exec form (`args` present) needs a real executable; `.cmd` shims do not work.

## 2. OpenTelemetry

Source: https://code.claude.com/docs/en/monitoring-usage

Enable with env vars. **They must be in the user-level settings `env` block (or the shell): Claude
Code ignores OTEL exporter variables set in a repository's `.claude/settings.json`.**

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp            OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:47821      (exporter appends /v1/logs, /v1/metrics)
OTEL_EXPORTER_OTLP_HEADERS=X-Huddle-Token=<token>
OTEL_LOGS_EXPORT_INTERVAL=2000     OTEL_METRIC_EXPORT_INTERVAL=10000     (defaults 5000 and 60000 ms)
```

Prompt text and tool details are not exported unless `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_TOOL_DETAILS`
are set. The Huddle leaves them off; hooks already provide what it needs.

The record that matters is the log event **`claude_code.api_request`**: `model`, `input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `duration_ms`,
`request_id`, `query_source` (main, subagent, auxiliary), plus `session.id`, `prompt.id`, and on
subagent requests **`agent_id`** and `parent_agent_id`. That gives tokens per subagent and, in
principle, the parent of a nested subagent.

Other events: `user_prompt`, `tool_result`, `tool_decision`, `api_error`, `assistant_response`,
`subagent_completed`. Metrics include `claude_code.token.usage` and `claude_code.cost.usage`, but
metrics lack the per-request correlation fields, so the Huddle meters from log events.

Cost is Claude Code's own client-side estimate (`cost_usd`, also `cost_usd_micros`, an integer). On a subscription it is an API-equivalent figure.

Docs-checked 2026-11-14 (https://code.claude.com/docs/en/monitoring-usage.md, first 100k of 176k chars read):
- `api_request` also has `cost_usd_micros`, `client_request_id`, `cache_creation_5m/1h_tokens` (v2.1.300+), `ttft`-style fields not
  confirmed by docs (the run-check in section 0 saw `ttft_ms`). `request_id` comes from the `request-id` header.
- `query_source` on **events** is free-form: "such as `repl_main_thread`, `compact`, or a subagent name". Only `repl_main_thread` and
  `compact` are named. `sdk`, `generate_session_title`, `prompt_suggestion`, `away_summary` are NOT in the docs (run-checked only, section 0).
  On **metrics** it is the coarse `main` | `subagent` | `auxiliary`. The old line above that lists main/subagent/auxiliary for the log event is wrong.
- Title generation labelling: not documented. Compaction: documented as `compact`.
- Telemetry export variables in `env` do not take effect from project or local settings (settings.md). `--settings` is not named in
  the part read; whether OTEL_* in `--settings` `env` is honored: not documented, spike S13.

## 3. Running and controlling sessions from outside

### `claude -p` (managed sessions)
Source: https://code.claude.com/docs/en/headless · flags: https://code.claude.com/docs/en/cli-reference

- `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` streams
  one JSON object per line: a `system/init` message (model, tools, MCP servers, session id), then
  assistant and user messages, then a final `result` (text, `total_cost_usd`, per-model usage,
  `permission_denials`).
- Subagent messages carry `parent_tool_use_id` (the Agent tool call that started them; `null` for
  the main conversation). `--forward-subagent-text` adds their text at every nesting depth, which
  allows an exact tree for managed sessions.
- `--input-format stream-json` keeps stdin open for further user messages (shape to confirm, S8).
- Without `--bare`, a `-p` run loads hooks, skills, agents and CLAUDE.md like an interactive
  session. `--bare` skips all of that and does not use the subscription login (it needs an API
  key), so the Huddle does not use `--bare`. That a normal `-p` run uses the existing login is
  implied by the docs rather than stated; S8 confirms it.
- In a `-p` run a call that needs approval is denied unless something approves it, such as a
  `PermissionRequest` hook. So the Huddle's held-hook mechanism also covers managed runs.
- `/model <name>` and `/effort <level>` work as prompts in `-p` mode.
- `--permission-mode`, `--allowedTools`, `--agents <json>`, `--agent <name>`, `--model`,
  `--max-turns`, `--max-budget-usd`, `--resume <id>`, `--worktree`.

**Run-checked by S16 (2026-11-14, 2.1.325; S16). These override every "not run-checked / needs S16" note in the block below.**
- Interrupt: stdin `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt","cancel_queued":true}}` → a
  `control_response` with `subtype:"success"`; the turn ends at once (`result` `error_during_execution`) and the process takes the next message.
- Close stdin: the turn finishes, the process exits 0, `SessionEnd` fires. `taskkill /T /F` and Node `kill('SIGINT')` on Windows are hard
  terminates: held hook sockets close, **no `SessionEnd`**, no `result`.
- `--agents <file.json>` and inline both work under `-p`; `SubagentStart.agent_type` is the `--agents` name; `parent_tool_use_id` on subagent
  stream messages equals the `Agent` `tool_use` id. `--agent <name>` accepts a `--agents` name.
- `--session-id <uuid>` with stream-json: `system/init` and every hook carry it.
- `PermissionRequest` fires under `-p` only in `default` and `acceptEdits`; `plan` and `auto` ran a non-allowed Bash without it; `dontAsk` refused it.
- A never-trusted folder under `-p`: no prompt, its `CLAUDE.md` and `.claude/settings.json` `env` load. Hook `cwd` in a `git worktree add` folder is
  the worktree root.

**Env of a managed run (observed 2026-11-14 on 2.1.325, not documented as a list; M4 WP6 `runtime/runs.ts`).** Claude Code
sets these in the processes it starts (read from a Bash tool call's environment): `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`,
`CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`. A Huddle started from a Claude Code terminal (dev) inherits them, so the launcher
removes exactly these (`NESTED_SESSION_ENV_VARS`) from the run's env and keeps everything else: auth, `ANTHROPIC_*`,
`CLAUDE_CONFIG_DIR`, `OTEL_*` and the user's settings env such as `CLAUDE_CODE_ENABLE_TELEMETRY`,
`CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Not run-checked: what a nested `claude -p` does
when they are present (refuse, or mix itself into the parent session). `CLAUDE_EFFORT` is assumed to be the parent
session's effort, not a user setting; check with `/verify-claude-api` if a run's effort looks wrong.

**M4 launch flags, docs-checked 2026-11-14** (Claude Code 2.1.325 on this machine; none of the lines below is run-checked unless it says so).
Pages: cli-reference.md (flag table, "CLI flags"), sub-agents.md ("Choose the subagent scope"), permission-modes.md, headless.md,
worktrees.md, permissions.md ("What runs before you trust a folder"), agent-sdk/typescript.md; all under https://code.claude.com/docs/en/.
- **`--agents`** (cli-reference, sub-agents): JSON object, each top-level key is an agent name (must not start with `-`), value is the definition.
  Fields: `prompt` (system prompt; may be empty, v2.1.281+) plus the subagent frontmatter fields `description`, `tools`, `disallowedTools`,
  `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `autoCompactWindow`, `skills`, `initialPrompt`, `memory`, `effort`,
  `background`, `omitClaudeMd`, `isolation`. `color` and `experimental` are ignored. Example from the docs:
  `{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer","tools":["Read","Grep"],"model":"sonnet"}}` (`tools` is an array there).
  Session-only, never written to disk. Priority 2 of 5 (above `.claude/agents/` and `~/.claude/agents/`), so it shadows a same-named file agent.
  Validated at startup (v2.1.242+): an invalid value makes `claude` exit (errors.md "Invalid --agents configuration").
  **File form**: with `-p`, the value may be a path to a JSON file ("for definitions too large to pass on the command line", v2.1.281+);
  an interactive session refuses a path. Use the file form: it avoids Windows command-line limits and quoting entirely. Nothing in the docs
  gives a size limit for the inline form, and nothing about quoting with an args array: "not documented", S16 (inline vs file on 2.1.325).
  With `shell: false` and an args array, Node quotes the argument itself; the escaping risk is only when a shell sits in between.
  Use by the main loop as a subagent: sub-agents.md does not say so in one sentence; it lists `--agents` as a subagent scope and says Claude
  "delegates to that subagent" when a task matches its `description`. Treat as yes, but **not run-checked: S16**.
- **`--agent <name>`** (cli-reference, sub-agents): "Specify an agent for the current session (overrides the `agent` setting)". The main thread
  itself takes that subagent's tool restrictions and model ("Run the whole session as a subagent"); the choice persists on resume. It is
  not a way to spawn a subagent. Naming an agent defined by `--agents`: not stated; the `--agents` field text (an empty `prompt` agent
  "selected as the session's agent with `--agent`") implies it works. Not run-checked: S16.
- **`--permission-mode`** (cli-reference): `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, plus `manual` as an alias of
  `default` (v2.1.200+; `--help` lists `manual` instead of `default`). `--enable-auto-mode` was removed in v2.1.111. Meanings (permission-modes):
  `default`/Manual: reads only run unasked; `acceptEdits`: reads, edits, `mkdir/touch/mv/cp`; `plan`: explore and write a plan, no source
  edits; `auto`: a classifier model reviews actions; `dontAsk`: "auto-denies every tool call that would otherwise prompt"; `bypassPermissions`:
  everything. **From v2.1.302 a `-p` run with no mode set starts in Manual (`default`)**; before that it could start in auto.
  Hooks in `-p` (headless): in Manual a call needing approval "is denied unless something approves it, such as a `PermissionRequest` hook".
  What the docs do NOT say: whether `PermissionRequest` fires in `dontAsk` (the page says an allow rule or a `PreToolUse` hook run, and
  that "a mod you installed can still approve"), in `auto` (the classifier decides; prompts that fall back are what a hook would see) or in
  `bypassPermissions`. Held approvals in the Huddle therefore need `default`/`manual`, `acceptEdits` or `plan`; `plan`, `dontAsk` and `auto`
  hook behavior are "not documented, needs spike S16". In `auto` with `-p` and no `--permission-prompt-tool`, repeated classifier blocks do
  not stop the run: "the action doesn't run and Claude keeps working".
- **`--permission-prompts none`** (v2.1.259+): anything that would prompt is denied "unless a `PermissionRequest` hook allows it"; Claude is
  told nobody can approve and not to retry. Removes `AskUserQuestion`. Denials show as `permission_denied` system messages and in the final
  `permission_denials`.
- **`--worktree` / `-w [name]`** (cli-reference, worktrees): creates `<repo>/.claude/worktrees/<name>/` (name generated if omitted, e.g.
  `bright-running-fox`) on a new branch `worktree-<name>`, branched from the remote default branch (`worktree.baseRef` `"fresh"`, the default;
  `"head"` branches from local HEAD). Fetches the default branch if not fetched in 24 h (5 s cap). Reuses an existing worktree of the same name.
  Copies gitignored files listed in `.worktreeinclude`. `#<n>` or a PR URL branches from that PR. `-p` skips the trust check. **`-p` never
  cleans up** ("Non-interactive runs with `-p` have no exit prompt, so Claude doesn't clean up their worktrees"; each stays `git worktree
  lock`ed until a later sweep): remove with `git worktree remove` (after `git worktree unlock` if locked). Interactive exit removes a clean,
  unnamed worktree and prompts otherwise. The Huddle plans its own `git worktree add` instead: the page says that works ("Manage worktrees
  manually": `git worktree add ../x -b y`, then `cd` and run `claude`). A run started with `cwd` inside such a worktree is a normal session;
  permission approvals saved by "don't ask again" go to the main checkout's `.claude/settings.local.json` and are shared by all worktrees.
  Resuming (`--resume` in `-p`) a session that ended in a worktree re-enters it; launching the resume from inside a worktree not created
  under `.claude/worktrees/` is refused ("launch those from the main checkout"). Hook `cwd` is the worktree root. Run-checked on 2.1.325:
  not yet (S16 should start one `-p` run with `cwd` in a `git worktree add` folder and check hook `cwd` and `session_id`).
- **`--session-id <uuid>`** (cli-reference): "Use a specific session ID for the conversation (must be a valid UUID)". The table puts no print-mode
  or format restriction on it, and §0 says it was run-checked. Combined with `--input-format stream-json --output-format stream-json`: not
  named by the docs, so confirm in S16 together with the first `SessionStart` hook carrying that id. Also `--resume` needs the id to exist.
- **Interrupting a stream-json run**: the stdin wire protocol is **not documented** as a CLI contract. What the docs do say
  (agent-sdk/typescript): the SDK's `interrupt()` is "only available in streaming input mode"; control messages have the shape
  `{ type: "control_request", request_id, request }`; "A client that drives the CLI's control protocol directly, rather than through
  `interrupt()`, can set `cancel_queued: true` on the `interrupt` control request" (v2.1.219+, advertised by the `system/init`
  `capabilities` entry `interrupt_cancel_queued_v1`; `interrupt_receipt_v1` from v2.1.205 returns `{still_queued: string[], cancelled?: string[]}`).
  So the subtype name `interrupt` is implied by that sentence but the full request JSON and the response shape are not documented: **needs
  spike S16** (send `{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}`, read `system/init.capabilities`, expect a
  `control_response`). Documented process-level alternatives (headless.md "Stop a run with SIGTERM"): SIGTERM exits 143, leaves the turn
  unfinished with no result recorded, runs `SessionEnd` hooks; "To end the turn instead, send SIGINT". A permission prompt waiting when
  stdin ends is cancelled ("Claude Code cancels the prompt as soon as the input ends"). On Windows signal delivery to a spawned child is
  different (Node `kill()` is a hard terminate): not documented, S16.
  **Closing stdin**: headless.md only says "After Claude finishes its turn and stdin has closed, a `claude -p` run can stay open to wait for
  background work" (background subagents, commands, Monitor, `/loop` wakeups; 10-minute idle cap, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`;
  `--max-budget-usd` stops it). So closing stdin ends the session after the current turn and queued background work, not at once.
  `--replay-user-messages` re-emits stdin user messages on stdout as an acknowledgement (needs both stream-json formats).
- **`parent_tool_use_id`** (headless "Follow subagent messages"): on `assistant` and `user` stream messages; `null` for the main conversation;
  for a subagent it is the `tool_use` id of the Agent (or Skill) call that started it, and a nested subagent carries the id of the call that
  started that nested one, so the tree can be rebuilt. By default only a subagent's `tool_use`/`tool_result` blocks are emitted (and its
  first `user` message, the prompt, for a foreground one); `--forward-subagent-text` (v2.1.211+, or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) adds
  text and thinking blocks. A forked skill started by `/<skill>` as the prompt carries `forked-command-…` instead (arrives after it finishes).
  The same field exists on SDK `SessionMessage` ("`tool_use_id` of the `Agent` or `Skill` tool call that started the subagent").
- **`--max-budget-usd`, `--max-turns`** (cli-reference): both present, print mode only. `--max-budget-usd` checks Claude Code's client-side
  estimate, subagent spend counts, "Spend can pass the cap"; at the cap spawning a subagent fails with `Budget limit reached` and running
  background subagents are stopped (v2.1.217+). `--max-turns`: "No limit by default"; with stream-json a queued message starts a new
  turn with its own limit. The Huddle does not use either for budgets.
- **Workspace trust in `-p`** (headless "bare mode", permissions "What runs before you trust a folder"): "Claude Code shows the trust dialog
  in interactive terminal sessions, but not in `claude -p` or SDK sessions". Without `--bare`, "a `-p` session runs the hooks in a project's
  `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted", and `-p` "discovers and loads"
  hooks, skills, subagents and CLAUDE.md "as an interactive session would". Not used in an untrusted `-p` folder: the project's
  `permissions.allow` rules and `additionalDirectories` (stderr warning `this workspace has not been trusted`), project-subagent frontmatter
  hooks, inline subagent `mcpServers`. To make a folder trusted: `projects["<path>"].hasTrustDialogAccepted: true` in `~/.claude.json`.
  Consequence for managed sessions: project hooks load (so the Huddle's user-level hooks surely do), but a project's allow rules do not, so
  a never-opened worktree has fewer pre-approvals than the main checkout. CLAUDE.md in an untrusted `-p` folder: the docs say discovery is
  as interactive, and the trust table row for CLAUDE.md was not legible in the fetch; treat as loaded, confirm in S16.

**Protected paths and read-only commands (docs-checked 2026-11-14, Claude Code 2.1.325; not run-checked except as noted).**
Run-checked by S17 (2026-11-14): in `-p` `default` mode, `git status` and `git diff` run with **no PermissionRequest** even when the repo's
`.git/config` already holds an executable `core.fsmonitor` or a `filter.*.clean`, and that program runs. So the default `git status|diff|log`
allows are never consulted; the defence is that writes to `.git/config` are protected and the Huddle never auto-allows them.
Pages: permission-modes.md ("Protected paths", "What acceptEdits auto-approves", "Actions no mode auto-approves"), permissions.md
("Read-only commands", "Redirections"), security.md, hooks.md (PermissionRequest).
- **Protected directories** (permission-modes): `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`,
  and `.claude` (exceptions: `.claude/worktrees/`, the session's own plan files, background-session scratch, auto-memory and subagent-memory
  Markdown). Also a `--plugin-dir` directory and `dev-mods/`. **Protected files**: `.gitconfig`, `.gitmodules`, shell rc files (`.bashrc`,
  `.zshrc`, `.profile`, `.envrc` ...), `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `bunfig.toml`, `.bazelrc`, `.pre-commit-config.yaml`,
  `lefthook.y*ml`, `.ripgreprc`, `pyrightconfig.json`, `.mcp.json`, `.claude.json`, and any file passed to `--settings`, `--mcp-config` or `--agents`.
- **Per-mode outcome for a protected-path write**: `default`/`acceptEdits` prompted; `auto` routed to the classifier ("which decides");
  `dontAsk` denied; `bypassPermissions` allowed ("Claude Code skips permission prompts, including for writes to protected paths such as
  `.git` and `.claude`", permissions.md); `plan` allowed in interactive sessions with bypass available, otherwise classifier or prompt.
  Settings allow rules do not help: "`permissions.allow` rules in settings files do not pre-approve protected-path writes."
  Output redirects (`> file`, `>> file`, `tee`) from Bash are checked against protected paths too (permissions.md "Redirections").
- **Does a `PermissionRequest` hook allow override the protection? Not documented.** hooks.md says the hook runs "when Claude Code is about to
  ask you for permission" and that `allow` does not override deny or ask rules; protected-path prompts are not named as an exception or as
  covered. A protected-path prompt in `default`/`acceptEdits` is a permission prompt, so the hook very likely sees it and an allow would grant
  it. **Huddle rule: never auto-allow `Edit`/`Write`/`NotebookEdit` (or Bash redirects) whose target is under a protected directory or is a
  protected file; let those reach the user.** Whether the hook fires at all in `auto` (classifier decides) or `dontAsk` (denied): spike S16.
- **Bash in `acceptEdits`**: auto-approved are only file edits plus `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` on in-scope paths
  (PowerShell tool: `Set-Content`, `Add-Content`, `Clear-Content`, `Remove-Item`). "All other Bash commands except the built-in read-only set"
  still prompt, as do "Writes to protected paths". So `git config core.fsmonitor x` is not in either set and prompts (docs-checked). A `mv`,
  `cp` or `sed -i` aimed at `.git/config` is a protected-path write and prompts; the docs do not say how the path check reads `sed -i` or `cp`
  targets inside `.git`: not documented.
- **Built-in read-only Bash set** (permissions.md "Read-only commands"): runs "without a permission prompt in every mode" (except
  `blockReadsOutsideWorkingDirectories`; in `auto` it may still wait for the classifier). The set "includes `ls`, `cat`, `echo`, `pwd`,
  `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only forms of `git`". The full list and which `git`
  subcommands and flags count as read-only are **not documented**; security.md names `git status` as an example. "The set is not
  configurable"; to force a prompt add an `ask` or `deny` rule. Read-only commands never prompt, so a `PermissionRequest` hook is not
  consulted for them (inferred from the hook's "about to ask you" wording; the docs do not state it for this case). Consequence: a Huddle
  allow rule for `git status|diff|log` is redundant for plain forms; it only matters for forms Claude Code does not treat as read-only.
  In Manual mode, `git` (and `find`, `sort`, `sed`) with an unquoted glob prompts, and `cd <elsewhere> && git ...` prompts "since running
  `git` in a new directory can execute that directory's hooks".
- **git config, fsmonitor, textconv, filters executing through read-only git**: not documented. The only related text is the `cd` + `git`
  hooks warning above, and a permissions.md rule-matching example (`Bash(git * main)` matches `git -c core.fsmonitor=<script> diff main`),
  which shows Claude Code knows `-c core.fsmonitor` is a code-running flag but does not say whether a `.git/config` value already in
  place is checked. Closing the gap relies on protected `.git`: a write by Edit/Write prompts (or is classified or denied) in every mode but
  `bypassPermissions`, as above. Spike proposal (S17, not run): in a scratch repo, put `core.fsmonitor` in `.git/config` by hand, then run a
  `-p` session in default mode asking for `git status`, and see whether it prompts, runs silently, or runs the script.
- **Other protected paths worth a Huddle rule**: `.claude/` (settings, hooks, agents: edit = code execution at next load), `.husky/`,
  `.vscode/` and `.devcontainer/` (tasks, launch), `.mcp.json`, `.gitconfig`, `.gitmodules`, `lefthook.y*ml`, `.pre-commit-config.yaml`.
  All are covered by the same table, so one path-prefix guard in the policy covers them.

### Model selection for subagents (M5 WP7, `record:runs -- --subagent-model`)

**Run-checked 2026-11-15 (claude 2.1.325):** `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` in the child env and the per-run `--settings` env put **all 69 subagents** of the 15-run `record:runs -- --subagent-model sonnet --yes` batch on `claude-sonnet-5-5` (manifest `resolvedModels`, 0 `modelMismatch`; `.huddle/runs/20261114-221306/`), including Explore calls and calls where the main loop could have passed a model. Which of the two variables (or the env vs. settings placement) is sufficient alone was not separated. Docs-checked 2026-11-14 before that. Source: https://code.claude.com/docs/en/sub-agents ("Choose a model", "Built-in
subagents"); the env var is also listed on https://code.claude.com/docs/en/model-config and https://code.claude.com/docs/en/env-vars.
- Resolution order (sub-agents.md, verbatim re-check 2026-11-14): the Agent call's `model` parameter, then the definition's `model`
  (including `inherit`), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the parent's model. So the env var alone loses to a model the main
  loop passes in its Agent call.
- "Run every subagent on one model" (sub-agents.md): set `CLAUDE_CODE_SUBAGENT_MODEL=<m>` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`
  (v2.1.257+; this machine has 2.1.325). While FORCE is on, definitions' `model` is ignored and Claude cannot pass a model. The
  env-vars page's FORCE row was seen only in summary (page truncated). Caveat: an earlier fetch the same day quoted a different order (env
  var first) and found no FORCE variable. The recordings below agree with the order above, so it is used here.
- Built-in Explore and Plan use the parent's model (sub-agents.md). Recorded behaviour on 2.1.325 agrees. In `fixtures/runs` every
  Explore call without a `model` input resolved to the main model (`resolvedModel` `claude-opus-5-5`, 45 rows). Only the calls where the
  main loop itself passed `model: "haiku"` resolved to Haiku (16 rows, in `par-tiny-6`, `mixed-sizes-5`, `mixed-long-4`,
  `nested-chain-3`, `nested-par-6`). A user or project subagent named `Explore` overrides the built-in (sub-agents.md). For an `--agents`
  agent named `Explore`: not stated.
- The model the Huddle keys on is PostToolUse(Agent) `tool_response.resolvedModel` (normalized to `model.observed` via `agent_call`). In
  `fixtures/runs` the agent rows' models match the `resolvedModel` counts exactly. Recording with a subagent model `<m>` sets both
  env variables and writes each run's `resolvedModel` counts into the batch manifest. A run not all on `<m>` gets `modelMismatch`. The
  first such batch settles the order above; record the result here.

### One-shot read-only ask (F25, M5)

Docs-checked 2026-11-14 (installed version on this machine was 2.1.325 in the last run; not re-read this session). **Nothing here is
run-checked: spike S18 proves it.** Pages: cli-reference.md ("CLI flags"), headless.md, settings.md, hooks.md ("Disable or remove hooks"),
agent-sdk/claude-code-features.md ("Control filesystem settings with settingSources", "What settingSources does not control"),
agent-sdk/typescript.md (`SDKResultMessage`), mcp.md; all under https://code.claude.com/docs/en/ (append `.md`).
Goal: `claude -p` answers a question over a text context we pass in, with no tool it could call, on the subscription login (ADR-004, no `--bare`).

| Need | Documented | Exact spelling and meaning |
|---|---|---|
| Zero built-in tools | yes | `--tools ""`: "Use `""` to disable all". Does not affect MCP tools; add `--disallowedTools "mcp__*"` for those. Second route: `--disallowedTools "*"` ("`"*"` removes every tool"). `--allowedTools` is only auto-approval, not restriction ("To restrict which tools are available, use `--tools` instead"). `EndConversation` is not removed by a list that omits it; `""` removes it only when no MCP tools remain. |
| No MCP servers | partly | `--strict-mcp-config` + `--mcp-config <json-or-file>`: "Skip the MCP servers configured in places such as `.mcp.json`, `~/.claude.json`, or a plugin, and load the ones you pass with `--mcp-config`" (so plugin servers are covered). claude.ai connectors: the SDK page lists `strictMcpConfig: true` as a way to turn them off, and says `mcpServers: {}` alone does not. An empty `--mcp-config` value (`{"mcpServers":{}}`): **not documented**. With `-p`, a passed `--mcp-config` makes Claude Code wait for pending servers (up to `MCP_TIMEOUT`, 30 s), so an empty one should cost nothing; unproven. |
| Never prompts, never allows | yes (flag), behavior with no tools unproven | `--permission-mode dontAsk`: "Claude Code denies every call that would otherwise prompt" (headless.md). Reads in the working directory and the read-only Bash set still run; `--tools ""` is what removes them. `plan` explores and writes a plan (not a no-tools mode). `--permission-prompts none` (v2.1.259+) is a second layer: denies instead of prompting, tells Claude not to retry. S16 run-checked `dontAsk` refusing a Bash call. A `PermissionRequest` hook can still approve under `dontAsk` ("a mod you installed can still approve"): another reason to turn hooks off. |
| Replace instructions | yes | `--system-prompt "<text>"` replaces the entire default prompt (and then the git status snapshot is not added, headless.md); `--append-system-prompt` appends; `--system-prompt-file` / `--append-system-prompt-file` exist. `--exclude-dynamic-system-prompt-sections` is ignored with `--system-prompt`. |
| Skip user/project context | partly | `--setting-sources user,project,local` (comma list, only these three values): "Comma-separated list of setting sources to load". What each source carries is documented on the SDK page (same flag semantics assumed, **not stated for the CLI**): `user` = `~/.claude/settings.json` (hooks, env, permissions), `~/.claude/CLAUDE.md` and rules, user skills/commands/subagents; `project` = `.claude/settings.json` and hooks, CLAUDE.md and rules, project skills/commands/agents; `local` = `.claude/settings.local.json`, `CLAUDE.local.md`. Always read regardless: managed policy, `~/.claude.json`, **auto memory** (`~/.claude/projects/<project>/memory/`, off with `autoMemoryEnabled:false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), claude.ai connectors. Whether `--setting-sources ""` (nothing) is accepted on the CLI, and whether `enabledPlugins` (a settings key) is dropped with `user`: **not documented**. |
| Skills / slash commands | yes | `--disable-slash-commands`: "Disable all skills and commands for this session". |
| Subagents / plugins | yes | `--agents` is additive and only defines agents; omit it. Plugins load from `enabledPlugins` and `--plugin-dir`; the only documented way to load none is `--bare` (not usable) or excluding the settings that enable them (unproven). |
| Session persistence | yes | `--no-session-persistence`: "sessions are not saved to disk and cannot be resumed. Print mode only." Env equivalent `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, any mode. Whether hooks still fire and whether `transcript_path` is a real file: not documented. |
| Hooks for such a session | partly | Hooks load from user, project, local, managed, plugins (hooks.md "Hook locations") and merge. **`--settings '{"disableAllHooks":true}'`** is documented as the way to "turn hooks off for one run whatever the project's settings say" (takes precedence over project and local; managed hooks are not disabled by it). Excluding `user` with `--setting-sources` should also drop the Huddle's user-level hooks, since filesystem hooks load "when `settingSources` includes the relevant source", but that is SDK wording: unproven on the CLI, and plugin hooks are a separate source. Without either, the session reports to the Huddle like any other (§0: every session reports). |
| Prompt input | yes | Argument or **stdin**: "Non-interactive mode reads stdin" (`cat f \| claude -p 'question'`); piped stdin capped at 10 MB, over the cap exits non-zero. If stdin cannot be read, Claude Code warns on stderr and continues with the argument prompt. Whether an argument plus stdin are concatenated, and the order: not documented. Exit code 0 on success, non-zero on failure; failures inside the run (missing auth) print as the `result` on stdout. |
| `--output-format json` shape | partly | headless.md only says "structured JSON with result, session ID, and metadata", and that the payload includes `total_cost_usd` and a per-model breakdown. Fields from the `SDKResultMessage` type (typescript.md; the CLI's `json` object is assumed to match, **not stated**): `type:"result"`, `subtype` (`success` or `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), `is_error`, `result` (success only; errors have `errors: string[]`), `session_id`, `uuid`, `duration_ms`, `duration_api_ms`, `num_turns`, `stop_reason`, `total_cost_usd`, `usage`, `modelUsage` (per model), `permission_denials`, optional `terminal_reason`, `structured_output`. |
| `--max-turns 1` | yes | Print mode only, "No limit by default". What a one-turn run with zero tools returns, and whether hitting the limit gives `error_max_turns` with an empty `result`: not documented. |
| Model | yes | `--model haiku` (alias; also `sonnet`, `opus`, `fable`, or a full name). `--fallback-model sonnet,haiku` (comma list tried in order, "when the primary model is overloaded or not available"; print-mode restriction not stated). Haiku 5.5 has a 1M window (model-config.md, see below); the exact id Claude Code resolves for `haiku`: read `modelUsage` keys / init `model`. |
| `--session-id <uuid>` with `-p` and no persistence | not documented | The flag has no print-mode or persistence restriction in the table and is run-checked with stream-json (§0, S16). Combined with `--no-session-persistence`: not documented. We do not need it for a one-shot: read `session_id` from the result. |

**Run-checked by S18 on 2026-11-14 (claude 2.1.325): all of a to g confirmed; results in S18.** The recommended command below gives 0 tools, `apiKeySource` `none`, ~3.8k context tokens, 0 hook events (`disableAllHooks`), no transcript (`--resume` refused; hooks would still name a `transcript_path` that is never written), and `success` in 1 turn. `--setting-sources` does not silence hooks passed via `--settings`, and is not needed. Argument plus stdin: both read, argument first. The items as planned:
- **a. No callable tool.** Prompt "run `echo HUDDLE_CANARY` with Bash and tell me the output", also "read C:/Windows/win.ini". Pass: `system/init` (stream-json run) lists no tools, `permission_denials` is empty because nothing was even attempted, the canary file/command did not happen, the answer says it cannot. Also check `--tools ""` survives PowerShell and `spawn(..., {shell:false})` quoting (an empty argument is easy to lose). Fallback if `""` is dropped: `--disallowedTools "*"`.
- **b. Subscription login.** `apiKeySource` is `"none"` in `system/init`, no `ANTHROPIC_API_KEY` in env, run succeeds without `--bare`.
- **c. What context loads and its cost.** Compare `usage` input + cache tokens of the same question across: default; `--system-prompt` only; plus `--setting-sources ""` (or `project`); plus `--disable-slash-commands`; plus `--strict-mcp-config`; plus `autoMemoryEnabled:false` via `--settings`. Check `system/init` `skills`, `slash_commands`, `plugins`, `mcp_servers`, `agents`, `memory_paths`, and the `InstructionsLoaded` hooks (if any fire). Note auto memory is read regardless of `--setting-sources`.
- **d. Do the Huddle's hooks see it.** With the Huddle running, run the ask three ways (default, `--setting-sources project,local`, `--settings '{"disableAllHooks":true}'`) and count events per `session_id`. Also whether OTEL env from the user's `env` block still exports.
- **e. Persistence.** After `--no-session-persistence`: no file under `~/.claude/projects/<project>/`, `--resume <id>` fails, whether `claude agents`/session pickers show it; and what hooks report as `transcript_path`.
- **f. stdin + json shape.** Prompt via stdin only; stdin plus argument; the real `--output-format json` object (key list, `result` on success, error subtypes, what `--max-turns 1` returns), exit code, behavior on a 200 KB context.
- **g. Latency and tokens on haiku.** Wall time, `duration_api_ms`, `usage`, `total_cost_usd` for a 2 KB and a 50 KB context; first call cold vs. warm cache.

**Recommended S18 command (variant 1; PowerShell-safe when spawned with an args array and `shell:false`):**
`claude -p --output-format json --model haiku --max-turns 1 --tools "" --disallowedTools "mcp__*" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk --permission-prompts none --disable-slash-commands --no-session-persistence --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --system-prompt "<answer only from the text provided; you have no tools>"`, question and context on **stdin**. Variant 2 swaps `--settings` for `--setting-sources project,local` (does not rely on `disableAllHooks`); variant 3 is the default `claude -p` for the baseline in (c). Run from a scratch cwd with no `CLAUDE.md`, not from the repo.

### Background sessions and Agent View (research preview)
Source: https://code.claude.com/docs/en/agent-view

- `claude --bg "<prompt>"` starts a background session; `claude agents --json [--all]` lists them
  with `id`, `state` (working, blocked, done, failed, stopped), `status`, `waitingFor`, `sessionId`,
  `name`, `cwd`; `claude stop <id>`, `claude logs <id>`, `claude attach <id>`.
- Agent View does not list subagents as rows and shows no tokens, cost, progress or context.
- Files under `~/.claude/jobs/` and `~/.claude/daemon/` are not a stable interface. Use the JSON command.

### Agent SDK (TypeScript)
Source: https://code.claude.com/docs/en/agent-sdk/typescript · overview: https://code.claude.com/docs/en/agent-sdk/overview

- Package `@anthropic-ai/claude-agent-sdk`. It runs the Claude Code binary as a library.
- Useful without launching anything: `listSessions()`, `getSessionMessages(sessionId)` (messages
  carry `parent_tool_use_id` and `parent_agent_id`), `getSessionInfo()`. These read local session
  files through a supported API. **Use them instead of parsing transcript `.jsonl` by hand: the
  docs call that format internal and unstable.**
- `query()` offers `canUseTool`, `interrupt()`, `setModel()`, `getContextUsage()`, streaming input.
  The documented authentication for SDK apps is an API key, and the docs state that third-party
  products may not offer claude.ai login without approval. The Huddle is a personal local tool that
  launches the user's own `claude` CLI, so it uses the CLI route (ADR-004). Revisit this before
  distributing the Huddle to anyone else.
- Clarifying questions arrive as the `AskUserQuestion` tool; an answer is an allow with
  `updatedInput: { questions, answers }` where answers map question text to the chosen label.
  `AskUserQuestion` is not available inside subagents.
- Result accounting: `total_cost_usd` and `modelUsage` include subagents; `usage` does not.

### Channels (research preview)
Source: https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/channels-reference

Docs-checked 2026-11-16, not run-checked (spike S21). Pages: https://code.claude.com/docs/en/channels.md,
https://code.claude.com/docs/en/channels-reference.md, https://code.claude.com/docs/en/cli-reference.md (flag rows).

- **What it is.** A channel is an MCP server (stdio subprocess that Claude Code spawns) that pushes events
  into a session. Research preview; "the `--channels` flag syntax and protocol contract may change".
  Neither flag appears in `claude --help`; they work anyway.
- **Opt-in is per session, at startup.** A server must be named in `--channels` (or the development flag);
  being in `.mcp.json` is not enough. "If the session hasn't loaded your server as a channel ... Claude Code
  drops the events silently and returns no error." So a channel cannot reach a session that is already
  running or was started without the flag. Not usable for attached sessions the user started normally.
- **Custom channel.** The server declares `capabilities.experimental['claude/channel'] = {}` and emits
  `notifications/claude/channel` with `params: { content: string, meta?: Record<string,string> }`. `meta`
  keys must be letters, digits and underscores (others are dropped). The model sees
  `<channel source="<server name>" key="value">content</channel>`. `instructions` (standard MCP field) is
  delivered to the model as context. Optional `claude/channel/permission` capability relays permission
  prompts (`notifications/claude/channel/permission_request` with `request_id`, `tool_name`, `description`,
  `input_preview`; verdict `notifications/claude/channel/permission` with `request_id`, `behavior`
  allow|deny); relay needs v2.1.234+ semantics and the same opt-in.
- **Flag for custom channels.** `--dangerously-load-development-channels server:<name>` (or
  `plugin:<name>@<marketplace>`). Custom channels are not on the Anthropic allowlist, and a plugin in your own
  marketplace still needs this flag. The flag shows a full-screen confirmation ("I am using this for local
  development") on every start and the bypass is per entry (it does not extend to `--channels` entries).
- **`-p`.** The development flag is ignored with `-p` and in the Agent SDK, so a custom channel does not register
  there. (Channels in `-p` are documented only for allowlisted plugins via `--channels`.) The Huddle's managed
  `claude -p` sessions therefore cannot take a custom channel.
- **Auth and policy.** Needs Anthropic authentication through claude.ai or a Console API key; not available on
  Bedrock, Vertex, Foundry. Pro/Max users without an organization skip the policy checks. Team and Enterprise:
  blocked until an Owner sets `channelsEnabled: true`, and `channelsEnabled` also blocks the development
  flag. `allowedChannelPlugins` replaces the allowlist.
- **Other.** On the v2 MCP client runtime a server that negotiates protocol revision 2026-07-28 is not
  registered as a channel; `MCP_PROTOCOL_NEGOTIATION=legacy` keeps stdio servers on the earlier handshake
  (https://code.claude.com/docs/en/mcp.md). Delivery is not acknowledged; events queue and are delivered
  together on the next turn.
- **Not documented:** a minimum Claude Code version for channels as a whole (only v2.1.211 and v2.1.234 for
  relay details); behaviour in the VS Code extension; Windows-specific notes (none given, the plugins need Bun).
  Spike S21.

#### Cross-session messaging (the better candidate for live messages to attached sessions)
Docs-checked 2026-11-16, not run-checked. Source: https://code.claude.com/docs/en/cross-session-messaging.md

- Needs Claude Code v2.1.224+ (macOS, Linux, WSL 2) and **v2.1.234+ on native Windows**. On by default, no
  flag. Works for sessions already running. Also bound for `claude -p` sessions (not in `--bare` mode). In the
  VS Code extension and the Desktop app a held message waits until the `dialogExpiry` deadline.
- Each session binds an inbox: Unix socket on macOS/Linux, **named pipe on native Windows**. The path is in
  `/status` (`Peer address`, prefixed `uds:`) and exported to hooks and Bash children as
  `CLAUDE_CODE_MESSAGING_SOCKET`, with `CLAUDE_CODE_MESSAGING_TOKEN`. A client sends
  `{"type":"auth","token":"<token>"}` as its first line; on native Windows that line is required and anything
  else is closed. A connection idle 30 s without a full line is closed.
- Delivery is through the receiving session's `crossSessionInbound` (`accept` | `hold` | `refuse`). With no value
  set, a message from a process that is not a verified own child of a session is treated as asserting no
  permission class, and a session that bypasses permission prompts holds it for approval; otherwise delivered.
  Held messages in `-p`/VS Code expire after `dialogExpiry` (default 5 minutes, `"never"` allowed).
  Plain text only, about 1M characters cap, at most 50 queued, repeats throttled.
- A message arrives marked as from another session; it cannot approve anything or change configuration.
- **Not documented:** the wire format of the message line after the auth line, how a non-Claude process
  names itself as sender, how a Huddle (not a session child) is classified, and how to learn another
  session's socket path (the env var is exported only to that session's own hooks and Bash). A SessionStart
  hook could report `CLAUDE_CODE_MESSAGING_SOCKET`, but hook `env` is not documented as carrying it for HTTP
  hooks. Needs a spike (S21 part 2).

### Status line data
Source: https://code.claude.com/docs/en/statusline

Docs-checked 2026-11-14 against https://code.claude.com/docs/en/statusline.md (all of it read). Not yet run-checked: S12.

**Stdin fields** (all docs-verified): `session_id`, `session_name`, `prompt_id`, `transcript_path`, `version`, `cwd` and
`workspace.current_dir` (same value), `workspace.project_dir`, `workspace.added_dirs`, `workspace.git_worktree`, `model.id`,
`model.display_name`, `cost.total_cost_usd` (client-side estimate, resets on `/clear`), `cost.total_duration_ms`,
`cost.total_api_duration_ms`, `cost.total_lines_added/removed`, `exceeds_200k_tokens`, `effort.level`, `fast_mode`, `thinking.enabled`,
`agent.name` (only with `--agent` or agent settings; this is not subagent info), `worktree.*`, `prompt_cache.*` (v2.1.251+), `version`.
- `context_window.context_window_size` (200000 default, 1000000 for extended models), `used_percentage`, `remaining_percentage` (both may
  be `null` early), `total_input_tokens`, `total_output_tokens`, `current_usage` = `{input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens}`; `current_usage` is `null` before the first API call and after `/compact` until
  the next call. `used_percentage` = input + cache_creation + cache_read only (no output).
- `rate_limits.five_hour` / `seven_day` / `spend_limit` each `{used_percentage (0-100), resets_at}`; **`resets_at` is Unix epoch seconds**.
  Present only for claude.ai Pro/Max/Ultra (or gateway spend limit), only after the first API response; each window can be absent
  independently and is dropped once its `resets_at` passes.
- Main conversation only: subagent requests are not in `prompt_cache`; no per-subagent data. No payload carries tokens per agent.

**Behavior** (docs-verified): `statusLine` is one object `{type:"command", command, padding?, refreshInterval?, hideVimModeIndicator?}`,
so there is one command per settings scope (project, local and user can each set one; the winning one runs) and the bridge must wrap the
user's. Runs at session start/resume, after each assistant message, `/compact`, permission-mode change, vim toggle, command change,
`refreshInterval` (min 1 s), rate-limit `resets_at` and prompt-cache `expires_at`. **Debounced at 300 ms.** A new trigger **cancels an
in-flight script**. Output shows only on exit code 0; non-zero or empty output blanks the line. **No numeric timeout is documented.**
Runs only after workspace trust is accepted. On Windows: Git Bash if installed, otherwise PowerShell; use forward slashes in `command`.
`claude --debug` logs stderr per invocation.
- Consequence for the bridge: wrapper must be fast, must forward fire-and-forget (cancellation can kill it mid-run), must re-print the
  original line's output and exit 0.
- VS Code extension: **not documented** (vs-code.md and settings.md do not mention `statusLine`; settings are shared with the CLI).
  Headless `-p`: **not documented** (the page describes a terminal bar only). Propose spike S12 variants: run `-p` and VS Code with a
  logging status line command.

**The Huddle's bridge (F9, M2 WP6, ADR-018 proposed; built against the field list above, not yet run-checked).** **Still needed: the
interactive part of spike S12** (real stdin JSON from a terminal session, `rate_limits` on this plan, `model.id` for a 1M model, VS Code), then
replace `fixtures/statusline-docs-sample.jsonl` with a scrubbed capture.
- Opt-in through the installer (`statusLine: true` on `HookInstaller.prepareInstall` / `HuddleCore.prepareAttach`; default off). It saves the user's
  `statusLine` in `<config>/agent-huddle/statusline-original.json` and points `statusLine` at `node "<config>/agent-huddle/huddle-statusline.mjs"`.
- The wrapper (`scripts/huddle-statusline.mjs`, zero deps) reads stdin, fires `POST /huddle/statusline` (127.0.0.1, `X-Huddle-Token` from
  `agent-huddle/config.json`, 250 ms cap) without waiting for it, runs the saved command with the same stdin through Git Bash
  (`CLAUDE_CODE_GIT_BASH_PATH`, a Git folder on PATH, Program Files) or else PowerShell (`-NoProfile -NonInteractive -Command`), and passes
  stdout, stderr and exit code through. No saved line: prints nothing, exit 0. Huddle down: no change. **Assumed, not verified:** that Claude
  Code runs the line with `bash -c` / `powershell -Command` the same way; check in S12.
- The route has the hook edge rules (loopback, token, Origin refused, body cap, 400 on malformed JSON). Kept fields only: `session_id`,
  `model.id`, `cwd`, `workspace.{current_dir,project_dir}`, `context_window.{context_window_size, used_percentage, remaining_percentage,
  current_usage.*}`, `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, `cost.total_cost_usd`; `transcript_path` and the rest are
  dropped at the boundary.
- `normalize/statusline.ts` emits `context.measured` (`measuredBy: 'statusline'`, main agent only; used = input + cache_read + cache_creation;
  nothing when `current_usage` is null) and `limits.measured` (only windows present; `resets_at` seconds -> ms; absent window -> null). The
  reducer keeps a status line reading over telemetry for 30 s. `model.id` and `cost` are parsed but not emitted (no event needs them yet).
- Removal: withdrawing consent, `HuddleCore.removeStatusLineBridge()` and `npm run hooks:uninstall` restore the saved line exactly (or remove the
  key when it was "none"); a `statusLine` that is no longer exactly the bridge command is left alone and reported. Quitting keeps the bridge.
- **`-p` is not covered:** headless runs never call the status line (S12), so managed sessions keep telemetry context only.

**Context window per model** (https://code.claude.com/docs/en/model-config.md, docs-verified): 1M by default, no suffix, for Fable models,
Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later. Opus 4.6 and Sonnet 4.6 get 1M only via the `[1m]` suffix (`opus[1m]`,
`claude-opus-4-6[1m]`); otherwise 200K. Window size for Haiku 4.5 and older: not stated (200K by default per statusline.md). Named IDs on
the page: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`; exact IDs for Sonnet 5.5 and Haiku 5.5
are not on the page. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200K. Whether the `[1m]` suffix shows in `model.id` or telemetry `model`: not
documented (spike S12). Rule for the code: prefer `context_window_size` from the status line; fall back to a table keyed by model id prefix and
treat unknown ids as unknown, never as 200K.

**`claude -p --settings <file-or-json>`** (https://code.claude.com/docs/en/cli-reference.md and settings.md, docs-verified): the flag exists, takes a
path (regular file, up to 2 MiB) or inline JSON, applies for that session only, writes no file, ranks above project/local/user files and
below managed settings, and "keys you omit keep their file-based values". Lists such as `permissions.allow` merge across files. Hooks
therefore are added alongside the user's hooks (expect both to fire; verify in S13). `env` is "an ordinary key and follows the levels".
Not documented: whether `hooks` arrays merge or replace, and whether OTEL_* in a `--settings` `env` block counts as allowed (docs only
say project and local files are ignored for telemetry export variables). Spike S13 before relying on it. Fallback: set the OTEL_*
variables in the spawned process environment.

## 4. Where things live on disk

- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working
  directory with non-alphanumeric characters replaced by `-`. Subagents:
  `…/<session-id>/subagents/agent-<agentId>.jsonl`. Retention 30 days by default (`cleanupPeriodDays`).
- `CLAUDE_CONFIG_DIR` moves `~/.claude`. Whether it also relocates `~/.claude.json` (user-scope MCP servers,
  trust flags) is **not documented** (mcp.md says user-scoped servers live in `~/.claude.json`; its trust table
  says user-scope MCP comes from "your configuration directory, `~/.claude` unless you set `CLAUDE_CONFIG_DIR`").
  Docs-checked 2026-11-16; needs a spike before a private-config-dir launch relies on it.

### MCP facts for managed launches (docs-checked 2026-11-16, not run-checked)
Sources: https://code.claude.com/docs/en/mcp.md, https://code.claude.com/docs/en/hooks.md,
https://code.claude.com/docs/en/cli-reference.md
- `--mcp-config <file|json>` loads servers; `--strict-mcp-config` skips `.mcp.json`, `~/.claude.json` and plugin
  servers and loads only the `--mcp-config` ones. Both are CLI flags with no print-mode restriction stated; mcp.md
  says `claude -p` loads project-scoped servers without asking and names `--strict-mcp-config` as a way to keep
  them out. Run-checked already in S18 (section 3) with `-p`. Skipped entries appear in the `system/init`
  event's `mcp_server_errors` under stream-json.
- Hook tool names for MCP tools: `mcp__<server>__<tool>` (example `mcp__memory__create_entities`). Matchers for
  PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied apply; `mcp__memory` alone
  matches nothing, use `mcp__memory__.*`. Plugin servers: `mcp__plugin_<plugin>_<server>__<tool>`. That PreToolUse
  and PostToolUse fire for MCP tools follows from the matcher list; no payload sample on this machine yet.
- Server `instructions` (standard MCP field): delivered to the model at session start ("Only tool names and
  server instructions load at session start"); cut at 4,096 characters, the model sees the text before the cut.

### MCP progress tool, run-checked (S19, 2026-11-16, claude 2.1.325, haiku)
Server `scripts/huddle-mcp.mjs` (zero dependencies, stdio, spec
2025-06-18: `initialize` → `notifications/initialized` → `tools/list` / `tools/call`, one JSON message per line,
stdout carries protocol only).
- Tool name `mcp__<server key in --mcp-config>__<tool>`: `mcp__huddle__report_progress`; `system/init` lists the
  server as `connected` and the tool in `tools`.
- PreToolUse and PostToolUse fire for it with `tool_name`, `tool_input` (exactly what the agent passed),
  `tool_use_id`, `session_id`, and `agent_id` + `agent_type` when a subagent called it (absent = main agent).
  PostToolUse adds `duration_ms`, `tool_response` (`[{"type":"text","text":"ok"}]`) and a new field
  `mcp_server: {name, source}`. PermissionRequest for it has no `tool_use_id`. So the Huddle reads every call from
  the hooks it already has; the server can stay a stub.
- Subagents: general-purpose, Explore and a `--agents` agent without a `tools:` list get the tool; a `--agents`
  agent with a `tools:` list gets it only when the list names it.
- Permissions: under `default` the first call raises one PermissionRequest; `permissions.allow:
  ["mcp__huddle__report_progress"]` in the per-run `--settings` removes it (subagent calls included).
- Use: server `instructions` + tool description alone gave 0–2 main-agent calls on a three-step task; one line in
  the prompt asking for reports gave 3–5. Subagents report their *own* progress (often `fraction: 1` at their
  finish), so a subagent's fraction is not the run's.
- Windows: `command: "node"` with a forward-slash path, and an absolute `node.exe` under `Program Files` with a
  backslash path containing spaces, both work.
- `CLAUDE_CONFIG_DIR` moves `.claude.json` too (claude-directory docs: "The same applies to `.claude.json`"):
  `claude mcp add --scope user` / `remove` with it set to a temp folder wrote there, and the real
  `~/.claude.json` `mcpServers` key was unchanged.
- **`report_teammate` (M6 P5b, ADR-027; built 2026-11-16, not run-checked).** The same server lists a second tool,
  `report_teammate {name, status: "finished"|"waiting", note?}` (name 1-100 characters, note at most 200; answers `ok`).
  By the S19 naming rule it is `mcp__huddle__report_teammate`; the normalizer reads its PostToolUse `tool_input` only
  (never `tool_response`) and emits `teammate.reported` on the caller's key. Managed runs allow it in the per-run
  `--settings` next to `report_progress`. That Claude Code fires Pre/PostToolUse for the second tool exactly as for the
  first is assumed from S19 (same server, same transport); a team run that exercises it is still to do.

### Agent teams (docs-checked 2026-11-16, not run-checked; spike S20)
Sources: https://code.claude.com/docs/en/agent-teams.md, https://code.claude.com/docs/en/hooks.md,
https://code.claude.com/docs/en/monitoring-usage.md
- Experimental, off by default. Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (shell or settings `env`).
  While on, a subagent that Claude names launches as a teammate.
- **Not with `-p`**: "In non-interactive mode with the `-p` flag, including Agent SDK sessions, Claude doesn't
  spawn teammates"; a named subagent runs as an ordinary subagent. A team spike needs an interactive session.
- Display: `in-process` (default; any terminal) or split panes (tmux or iTerm2 only). `teammateMode` setting or
  `--teammate-mode in-process|auto|tmux|iterm2` (not in `--help`). The docs say tmux works best on macOS and do
  not mention Windows support for split panes; in-process is the Windows path.
- Each teammate is "a separate Claude Code instance" with its own context. Whether it has its own `session_id`
  in hook payloads is **not documented**. Team config holds "session IDs and tmux pane IDs"
  (`~/.claude/teams/{team-name}/config.json`, members with name and agent ID; mailboxes under
  `~/.claude/teams/{team-name}/inboxes/`; tasks under `~/.claude/tasks/{team-name}/`). `team_name` is
  `session-` plus the first 8 characters of the lead's session id, and the hook field is deprecated.
- Hooks: `TeammateIdle` (`teammate_name`, `team_name`, `agent_id?`), `TaskCreated`, `TaskCompleted`
  (`task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name`, `agent_id?`).
  `SubagentStart` also fires "each time an in-process agent team teammate handles a new message".
  Tool hooks fired inside an in-process teammate carry `agent_id` and `agent_type`.
- Telemetry: `claude_code.tool` spans carry `agent_id` ("the subagent or teammate that ran the tool");
  event `agent_id` is "absent on main-session and in-process teammate events". So events from in-process
  teammates cannot be told apart from the lead by `agent_id` in OTel. Not documented: any `team_name` or
  `teammate` attribute in OTel. Read only the first 100k characters of monitoring-usage.md.
- Subagent definitions: `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user), YAML
  frontmatter with `name`, `description`, optional `tools`, `model`, … and the body as system prompt.
  The Huddle reads `description` from these files to show a role description.
- Subagents may spawn subagents, three levels below the main conversation by default.

## 5. Subscription notes

- Each session draws on the same subscription quota. The Huddle shows tokens and rate-limit windows
  first, estimated dollars second.
- Sessions started with `claude -p` or the SDK are left out of the interactive session picker but
  can be resumed by id.
