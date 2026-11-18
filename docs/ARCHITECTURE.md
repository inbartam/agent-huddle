# Agent Huddle — architecture

Read `SPEC.md` first for what the product does. This file says how it is built and why.
Facts about Claude Code itself live in `INTEGRATION.md`; decisions with their trade-offs in `DECISIONS.md`.

## 1. The idea in one picture

```
 Claude Code sessions (terminal, VS Code, launched by the Huddle)
   │ hooks (HTTP POST)        │ OpenTelemetry (OTLP http/json)     │ stream-json (managed only)
   ▼                          ▼                                    ▼
┌──────────────────────────── packages/core  (Node, runs inside Electron main) ─────────────────┐
│  INGEST            HookServer        TelemetryReceiver        StreamDriver      CliPoller      │
│     │  raw payloads, validated at the edge                                                     │
│     ▼                                                                                          │
│  NORMALIZE         raw → HuddleEvent[]         (the only place that knows Claude Code's shapes)│
│     │                                                                                          │
│     ├──────────────► EventStore (append-only log)                                              │
│     ▼                                                                                          │
│  STATE             reduce(state, event) → HuddleState         (pure, replayable)               │
│     │                                                                                          │
│     ├─► DETECTORS  stuck · loop · file conflict · budget · context   → attention events        │
│     ├─► BROKER     holds open approvals and questions until answered, timed out or cancelled   │
│     ├─► POLICY     auto-approve rules evaluated before anything reaches the inbox              │
│     └─► REPORTER   end-of-run report · scorecards · ask-the-huddle                             │
│                                                                                                │
│  CONTROL           HuddleCommand → the right mechanism for that session's origin               │
└───────────────┬────────────────────────────────────────────────────────────────────────────────┘
                │ IPC: events (push), commands (invoke)                    phone: SSE over LAN (ADR-024)
                ▼
        apps/desktop renderer (React): widget window · main window · palette
```

Three properties do most of the work:

1. **One normalized event log.** Everything that happens becomes a `HuddleEvent`. State is
   `events.reduce(reduce, EMPTY_STATE)`. History, replay, tests from recorded sessions and
   scorecards are then queries over one log rather than four separate features.
2. **Knowledge of Claude Code is quarantined** in `ingest/` and `normalize/`. Claude Code's
   payloads change between versions; when they do, one folder changes.
3. **Capability-driven control.** An attached session and a managed session support different
   actions. Each `AgentNode` carries `capabilities`, the UI renders from them, and the control
   layer picks the mechanism. No `if (origin === ...)` in the renderer.

## 2. Repository layout

```
agent-huddle/
├─ packages/
│  ├─ shared/          contracts only: model, events, commands, progress maths   (exists)
│  └─ core/            ingest, normalize, state, broker, policy, detectors, control, store   (M1+)
│     └─ src/
│        ├─ ingest/        hook-server.ts  telemetry-receiver.ts  stream-driver.ts  cli-poller.ts
│        ├─ normalize/     hooks.ts  telemetry.ts  stream.ts          raw → HuddleEvent[]
│        ├─ state/         reduce.ts  selectors.ts
│        ├─ broker/        approvals.ts  questions.ts  outbox.ts      held requests, queued messages
│        ├─ policy/        rules.ts  defaults.ts
│        ├─ detect/        stuck.ts  loop.ts  conflict.ts  budget.ts
│        ├─ control/       commands.ts  attached.ts  managed.ts
│        ├─ store/         jsonl-store.ts  (later sqlite-store.ts)
│        ├─ report/        run-report.ts  scorecards.ts  ask.ts
│        └─ setup/         install-hooks.ts                           product version of scripts/install-hooks.mjs
├─ apps/
│  └─ desktop/         Electron: main (hosts core), preload, renderer (React)   (M1+)
├─ scripts/            developer tools: hook installer, exit-check harnesses, MCP server   (zero dependencies)
├─ fixtures/           recorded hook and telemetry payloads, scrubbed, used by tests   (M0 output)
└─ docs/
```

Dependency rule: `shared` imports nothing. `core` imports `shared`. `desktop` imports both.
The renderer imports types and pure selectors (`shared/src/selectors.ts`) from `shared` and nothing from `core` (ADR-016).

## 3. Ingest: four sources, one event format

| Source | Gives | Used for | Notes |
|---|---|---|---|
| **Hooks** over HTTP | lifecycle, tool calls, permission requests, subagent start and stop, task created and completed, compaction, model switch | tree, status, tasks, approvals, timeline, handoffs | Synchronous: Claude Code waits for the response, so answer in milliseconds unless deliberately holding. A failed or missing endpoint is a non-blocking error on the Claude Code side. |
| **Telemetry** (OTLP http/json logs) | one `api_request` record per model call with model, token counts, estimated cost, session id, subagent id | tokens, cost, model per agent, context estimate | Arrives a few seconds late (export interval). Must be configured in user-level settings. |
| **Stream** (stream-json of a process the Huddle spawned) | every message of a managed session, including subagent messages with their parent tool call id, and the final result with per-model usage | live text, exact subagent links, result totals for managed runs | Managed sessions also fire the hooks, so hooks stay the common path and the stream adds detail. |
| **CLI poll** (`claude agents --json`) | background sessions and their state | discovering background sessions, `claude stop` | Research preview on the Claude Code side; treat as optional. |

Optional fifth source in M2: a **status line bridge** that forwards the status line JSON (context
window percentage, rate-limit windows, session cost) for interactive sessions and then prints the
user's own status line unchanged.

### Edge rules
- Bind `127.0.0.1` only. Require the token header. Reject any request that carries an `Origin` header.
- The phone listener (M6, ADR-024) is a separate, opt-in listener on one private LAN address with its own rules:
  device token, `Host` check, and `Origin` absent or equal to its own origin. It never shares the hook port.
- Validate with a schema at the edge, keep unknown fields, never throw on an unexpected shape:
  log it as an unrecognized payload and carry on.
- Truncate before storing. `tool_response` can be a whole file.
- Deduplicate: hooks by `(session_id, hook_event_name, tool_use_id)` where available; usage by request id.

## 4. Normalize and reduce

`normalize/*` turns one raw payload into zero or more `HuddleEvent`s (types in
`packages/shared/src/events.ts`). Examples:

| Raw | Events |
|---|---|
| `PreToolUse` with tool `Agent` | `tool.started` + `agent.spawn_requested` (title, brief, model) |
| `SubagentStart` | `agent.started` (role, parent) and the pending spawn request is attached as its handoff |
| `SubagentStop` | `agent.stopped` (result) |
| `PermissionRequest` | `approval.requested`, or `approval.resolved` straight away when a policy rule decides |
| `TaskCreated` / `TaskCompleted` | `task.created` / `task.completed` |
| `PostToolUse` with tool `TaskUpdate` and `tool_input.status: in_progress` | `tool.finished` + `task.started` (the task now being worked on; S4b) |
| telemetry `api_request` | `usage.recorded` + `context.measured` (input-side tokens as the context estimate) |
| first event of an unknown session | `session.started` with `startKind: 'first_seen'` before the event itself |

`state/reduce.ts` is a pure function with no I/O, no clock and no randomness: the event carries
its timestamp. That is what makes replay and fixture tests exact.

Derived values (progress estimate, roll-ups to ancestors, sort order) are selectors computed
from state, not stored in it, so changing the estimator never requires rewriting history.

## 5. The broker: holding a decision open

The central trick for approvals, shown for an attached session:

```
Claude Code                         Huddle core                           You
    │  POST /huddle/hooks/PermissionRequest                                 │
    ├───────────────────────────────►│ policy rules: allow / deny / ask?    │
    │        (connection stays open) │ if ask → approval.requested ────────►│ inbox + toast
    │                                │                                      │ click Allow
    │                                │◄──── approval.decide ────────────────┤
    │◄── 200 {decision: allow} ──────┤ approval.resolved                    │
    │  runs the tool                 │                                      │
```

Every held request has exactly four ways to end, and each must be handled:
1. the user decides → respond with the decision;
2. a policy rule decides → respond at once, log the rule;
3. Claude Code closes the connection (answered in its own terminal, or the hook timed out) →
   mark `answered_elsewhere` or `expired` and remove it from the inbox;
4. the Huddle shuts down → respond 200 with an empty body to every held request first, so no
   agent is left waiting on a dead app.

The same held-response pattern implements:
- **Pause**: hold the next `PreToolUse` of that agent until resume. The hook timeout bounds how
  long a pause can last; on expiry the agent continues, so the UI shows the remaining time.
- **Nudge**: on the next `PreToolUse`, respond with `additionalContext` carrying the queued message.
- **Follow-up**: on `Stop`, respond `decision: "block"` with the queued message as `reason`,
  which keeps the agent going with that instruction. Respect `stop_hook_active` and never chain
  more than one continuation per user message.

## 6. Control: one command, two mechanisms

| Command | Attached session | Managed session |
|---|---|---|
| approve / deny | answer the held `PermissionRequest` hook | same |
| answer question | per spike S5 | per spike S5, else through the stream |
| message | outbox → next `PreToolUse` (note) or `Stop` (follow-up) | write a user message to the process's stdin stream |
| pause / resume | hold / release the next `PreToolUse` | same |
| stop | `claude stop <id>` if it is a background session, else unsupported | interrupt, then end the process |
| set model | unsupported | send `/model <name>` as the next turn |
| launch | n/a | spawn `claude -p` with stream-json input and output in the template's folder |

Launching uses the installed `claude` CLI, not an embedded SDK, so runs use the login the user
already has and need no API key (ADR-004). The Agent SDK package is used for its typed session
readers and message types.

## 7. Storage

- **M1–M4: JSONL.** `%APPDATA%/agent-huddle/events/<sessionId>.jsonl`, one event per line, plus
  `index.json` for the session list. Zero native dependencies, trivially inspectable, good enough
  for one user.
- **M5: SQLite** behind the same `EventStore` interface, when scorecards need real queries.
  Prefer the built-in `node:sqlite` if the Electron version ships it; otherwise `better-sqlite3`
  with prebuilt binaries. Decide in M5, not before (ADR-003).
- Settings, policy rules, templates: one JSON file each in the app data folder. Nicknames are rename events in the event log (ADR-015).
- Retention default 30 days, configurable. Free text is clipped on the way in (`CLIP_LIMITS`).

## 8. Desktop shell

- **Electron main** hosts `core` in-process: fewer moving parts than a separate daemon, and the
  app owning the port is what makes "closed Huddle = hooks fail open" simple. A tray icon keeps it
  alive when windows close.
- **Two windows, one renderer bundle**: widget (frameless, always on top, skips taskbar) and main.
  Both subscribe to the same event stream and keep state in a small store.
- **IPC** (`packages/shared/src/control.ts`): `huddle:events` pushes batches at most every 100 ms;
  `huddle:command`, `huddle:get-state` and `huddle:get-events` are invocations. `huddle:get-events`
  is read-only (`{ agentKey, limit }` to that agent's recent events, zod-checked in main) so a
  timeline refills after a renderer reload (ADR-015). `huddle:query` (M4, ADR-020) is a read-only
  invocation too: `policy.preview` goes to the core, `pick.folder` is the system folder picker in main.
  The preload script exposes exactly those five functions and nothing else. New features add command and query
  *types* on these channels, never new channels: F28/F29 add the commands `skill.save`, `huddle_task.create`,
  `huddle_task.update`, `huddle_task.delete`, `huddle_task.launch` and the queries `skills.list`, `skill.read`
  (schemas in `packages/core/src/contracts/orch-schemas.ts`, joined in main's `validate.ts`; handled by
  `runtime/orchestrator.ts`, files through `runtime/skills.ts`).
- **Security posture** (details in `SECURITY.md`): `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, a strict CSP, no remote content, and all agent-produced text rendered
  as text.
- **Windows specifics**: set the AppUserModelID or toasts will not show; global shortcut default
  `Ctrl+Alt+H`; single-instance lock so a second launch focuses the first.

## 9. Performance budgets

| Path | Budget | Why |
|---|---|---|
| Hook response when not holding | under 20 ms at p99 | every tool call of every agent waits for it |
| Event to pixels | under 1 s | "is it stuck or am I?" |
| Renderer with 30 agents and 5,000 timeline rows | 60 fps scrolling | virtualize the timeline |
| Memory after 8 hours | no growth beyond the retained window | in-memory state keeps summaries, the log keeps the rest |

## 10. Testing strategy

- **Fixtures first.** Real hook and telemetry payloads were recorded from Claude Code with a prototype server.
  Scrubbed copies go to `fixtures/`. Normalizer and reducer tests replay them and snapshot the
  resulting state. When Claude Code changes a payload, a fixture test fails before a user notices.
- **Pure core.** `normalize`, `reduce`, `policy`, `detect` and the progress estimator are pure and
  tested without Electron.
- **Broker tests** use a real HTTP server on an ephemeral port and assert all four endings of a
  held request.
- **One end-to-end smoke test** per milestone: start the app, replay a fixture over HTTP, assert
  what the tree shows.

## 11. Extension points (later)

- A new agent framework = a new ingest source plus a normalizer that emits `HuddleEvent`s.
- Agent teams: `TeammateIdle` and the teammate fields on task hooks already arrive; a teammate is
  an `AgentNode` with `kind: 'teammate'`.
- Self-reported progress (F27, built in M6): a stub MCP server (`scripts/huddle-mcp.mjs`) exposes one tool; the Huddle
  reads each call from its PostToolUse hook (`normalize/self-report.ts`) as `progress.reported`, keeps the latest on
  `AgentNode.selfReport`, and `selectProgress` feeds it to `estimateProgress` for that agent only.
