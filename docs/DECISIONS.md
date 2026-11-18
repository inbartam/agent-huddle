# Decisions

Short records of choices that shape the code. Add one whenever a choice would surprise a new
reader or was hard to make. Format: context, decision, consequences, what would change it.

S-numbers (S5, S16, …) name experiments run on the author's machine during development; the experiment log is not published.

## ADR-001 — Electron + React + TypeScript, core in the main process
**Context.** Needs an always-on-top widget, tray, global hotkey and Windows toasts; the owner works
on Windows without Docker and chose one language end to end.
**Decision.** Electron with electron-vite, React renderer, TypeScript everywhere. The core
(ingest, state, broker) runs inside Electron's main process.
**Consequences.** No Rust toolchain. Higher memory than Tauri. One process owns the port, so
"Huddle closed" and "port closed" are the same thing, which keeps hooks failing open.
**Would change it.** A need to keep ingest running with the UI closed and memory tight → split the
core into a small background service.

## ADR-002 — Event-sourced state
**Context.** History, replay, scorecards, reports and tests all need "what happened, in order".
**Decision.** Every input is normalized into an append-only `HuddleEvent` log. State is derived by
a pure reducer. Derived numbers (progress, roll-ups) are selectors, not stored.
**Consequences.** Replay and fixture tests come almost for free. Event types are a compatibility
surface: add, do not repurpose. Memory needs care on long runs (keep summaries in state, detail in the log).
**Would change it.** Nothing foreseeable; this is the load-bearing choice.

## ADR-003 — JSONL first, SQLite when queries demand it
**Context.** Native Node modules are a common source of Windows build trouble, and M1–M4 only need
append and read-by-session.
**Decision.** `EventStore` interface; JSONL implementation first; SQLite in M5 for scorecards,
preferring built-in `node:sqlite` if the Electron runtime has it.
**Consequences.** Zero native dependencies early. A migration step in M5 (replay JSONL into SQLite).
**Would change it.** History view becoming slow before M5.

## ADR-004 — Launch through the `claude` CLI, not an embedded SDK session
**Context.** The owner uses a Claude subscription. The Agent SDK documents API-key authentication
and says third-party products may not offer claude.ai login without approval. `claude -p` without
`--bare` uses the existing login and loads the same hooks.
**Decision.** Managed runs spawn the installed `claude` with stream-json input and output. The SDK
package is a dependency for types and for reading stored sessions only.
**Consequences.** Works with the subscription, and approvals for managed runs use the same hook
path as attached ones. Fewer live controls than the SDK's `Query` object (no `setModel()` call,
model changes go through `/model`). Depends on spike S8.
**Would change it.** Moving to API-key billing, or distributing the app → reconsider an SDK driver
behind the same `StreamDriver` interface, and re-read the terms.

## ADR-005 — Hooks are the common path for every session
**Context.** Attached sessions can only be observed through hooks. Managed sessions also fire them.
**Decision.** Build tree, status, tasks and approvals on hooks for all sessions. The stream of a
managed session adds detail but nothing depends on it for correctness.
**Consequences.** One code path to test. Per-tool-call latency matters (budget in `ARCHITECTURE.md`).

## ADR-006 — Fail open for observation, never hold without a way out
**Context.** A monitoring tool that can stall the thing it monitors is worse than none.
**Decision.** Short timeouts on observation hooks. A held request always ends: user, rule, Claude
Code closing it, or Huddle shutdown releasing everything with "no decision". No `onFailure: block`.
**Consequences.** With the Huddle closed, auto-approve and budget rules do not apply; Claude Code's
own permission settings are the floor. Say so in the UI.

## ADR-007 — User-level hook install, by a reversible script
**Context.** The point is to see agents in every project, and telemetry env vars are ignored in
project settings.
**Decision.** The Huddle edits `~/.claude/settings.json`: dry run first, backup, tagged entries,
one-step uninstall, never overwrite existing telemetry settings.
**Consequences.** A sensitive file is modified; the script is small and tested, and the app must
show the diff before applying.

## ADR-008 — Capability flags instead of origin checks
**Decision.** `AgentNode.capabilities` says what can be done to an agent right now. The UI and the
command layer consult only that.
**Consequences.** Adding a new origin (background session, agent team, another framework) does not
touch the renderer.

## ADR-009 — Token-first metering
**Context.** On a subscription, dollars are an estimate at list price and not what is paid.
**Decision.** Tokens and rate-limit windows are the primary numbers; estimated cost is secondary
and always labeled. Budgets can be set in tokens, estimated dollars or minutes.

## ADR-010 — Progress without a task tool (S4 refuted)
**Context.** The design read "completed vs remaining" from `TaskCreated`/`TaskCompleted` hooks or the task tool's input. Claude Code
2.1.323 offered no to-do tool in any session tried (headless and interactive), so neither source exists.
**Decision.** Progress (F4) comes from what is observable, in this order: (1) for an agent with subagents, subagents finished / started;
(2) agent-reported progress through a small `report_progress` MCP tool (an opt-in, built in M6; the owner moved it back from M2, so M2 has no such source); (3) task hooks, kept in
the normalizer for versions or setups where they fire. With none of these, the UI shows activity (current tool, tool count, elapsed time)
and **no percentage**: unknown is shown as unknown.
**Consequences.** ETA needs a denominator, so for a single agent with no reports there is no ETA. The M2 exit criterion on ETA accuracy
applies only to runs that have a denominator.
**Would change it.** A Claude Code version or setting that brings the task tool back. (Owner check B, 2026-11-13: a fresh interactive
session has none either.)
**Update (2026-11-14, S4b).** The tools are gated by model, not missing: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` brings them back and the
task hooks fire. The owner sets it as a Windows user variable (`setx`), not in `~/.claude`. With it, basis `tasks` applies; without it
this ADR's order stands.

## ADR-011 — Pause is a held PreToolUse, bounded by the hook timeout (S6) — superseded in part by ADR-019
_Superseded in part by ADR-019 (2026-11-14): PreToolUse is installed with a 600 s timeout, option (a) below. The 5 s default now
applies to the other observation hooks only._
**Context.** A held `PreToolUse` pauses an agent cleanly; parallel calls are held independently; at the hook's `timeout` Claude Code
closes the request and the call proceeds. The installer gives observation hooks 5 s so a hung Huddle cannot stall agents.
**Decision.** Keep 5 s by default. The pause feature (F13) needs a longer `PreToolUse` timeout; M3 decides between (a) installing
PreToolUse with a long timeout (e.g. 600 s) and relying on the ~2 ms answer path, or (b) a separate long-timeout entry that only answers
for paused agents. The countdown in the UI is the configured timeout.
**Consequences.** A pause cannot exceed the timeout; when it lapses the agent continues, and the UI must say so.
**Would change it.** A documented way to pause without a held hook.

## ADR-012 — Async subagents: status and links (S0, S2)
**Context.** Subagents frequently run async. The main agent `Stop`s while they work, and their completion re-enters as a
`UserPromptSubmit` carrying a `<task-notification>`. `PostToolUse(Agent).tool_response.agentId` links an Agent call to its subagent.
**Decision.** (1) A session is idle only when its main agent has stopped **and** `background_tasks` is empty. (2) Prompts that are task
notifications are shown as "subagent finished", not as user prompts. (3) Parent links use the Agent call's `agent_id` (caller) plus
`tool_response.agentId` (child); the first-pending-call heuristic stays only until the PostToolUse arrives, and is marked `heuristic`.
Telemetry `parent_agent_id` is a cross-check.
**Consequences.** Normalizer tests must cover `parallel-subagents.jsonl` (async) and `nested-subagents.jsonl` (foreground).

## ADR-013 — Cost from telemetry, identity attributes dropped at ingest (S3)
**Context.** `api_request` carries `cost_usd`, which summed exactly to Claude Code's own session cost. Every record also carries the
user's email and account ids.
**Decision.** Use `cost_usd` as the estimated cost instead of a price table (still labeled an estimate, ADR-009). The telemetry normalizer
drops `user.*` and `organization.id` before anything is stored.
**Consequences.** No price table to maintain. Event logs and fixtures hold no account identity.

## ADR-014 — Hook noise while the Huddle is not running (S10) — accepted 2026-11-13: attach while running
**Context.** With the HTTP hooks installed and the Huddle stopped, an interactive Claude Code terminal prints a red
`hook error · connect ECONNREFUSED` line for every hook: each prompt, before and after every tool call, and on Stop (owner check F).
Work is not affected, but the noise is not acceptable for a tool meant to stay installed.
**Options.** (a) Route every event through a small command-hook forwarder that exits silently when nothing listens. It is quiet, but each
hook starts a Node process (a few hundred ms per call on this machine, see S10), which breaks the 20 ms observation budget.
(b) Keep HTTP hooks, and have the Huddle install them at start and remove them at quit (and offer "uninstall" in the tray). It stays fast,
but a crash leaves the hooks in place and edits user settings on every run.
(c) Keep HTTP hooks and document the noise. Rejected: the owner saw it and it is too loud.
**Leaning.** (b) with a cheap fallback: a "Huddle not running" check in the existing SessionStart command hook that tells the user once per
session how to remove the hooks. To be settled in the M1 plan with the owner.
**Decision (owner, 2026-11-13).** Option (b), "attach while running". First check with `/verify-claude-api` whether HTTP hooks have a
quiet-failure setting; if so, keep the hooks installed. Otherwise the app adds the hooks at start and removes them at quit, after one consent
on the first-run diff screen. Telemetry env vars stay installed (a dead exporter is silent). Backups are rotated. The SessionStart forwarder
gives a one-line "Huddle not running, remove hooks?" hint once per session to cover a crash. Re-read settings.json before every write.

## ADR-015 — M1 additions: link/model/role events, a read-only events channel, nicknames as events
**Decision (owner, 2026-11-13).** Add the event types `agent.linked`, `model.observed`, `role.described`, an optional
`PromptSubmitted.kind` and `TurnEnded.backgroundAgentIds` (additions only). Add a fourth IPC function, `huddle:get-events(agentKey, limit)`
(read-only, zod-checked), so timelines refill after a renderer reload without shipping them in every state batch. (ADR-020 adds a fifth,
read-only one, `query` on `huddle:query`; the preload now exposes those five functions and nothing else.) Store nicknames as
`control.applied` rename events in the event log instead of a separate JSON file, so replays show them (ARCHITECTURE §7 updated).

## ADR-016 — Tree selectors live in `shared` (2026-11-13)
**Context.** WP6 built pure selectors (`selectTree`, `selectAgent`, `selectNeedsYouCount`, `selectTimeline`) over `HuddleState` and
`HuddleEvent[]`. The renderer may not import `core`, so it could not use them.
**Options.** (a) Move them to `shared`: pure functions over shared types, like the progress maths already there. (b) Compute views in
main and send them over IPC: changes the `getState` contract and repeats work per window. (c) Let the renderer write its own view logic:
two copies to keep in step.
**Decision.** (a). `packages/shared/src/selectors.ts`, no imports beyond `shared`. The rule becomes "the renderer imports types and pure
selectors from `shared`, nothing from `core`". The reducer's own memory stays in core as `ReducerState.book`; main sends
`toHuddleState(state)` over `huddle:get-state`, so bookkeeping never crosses IPC.

## ADR-017 — Setup status and consent through state and one command (2026-11-13)
**Context.** The first-run screen must show the `settings.json` change and send the user's consent; the windows must show "not connected"
and "port in use". The four IPC functions (ADR-015) carry neither.
**Options.** (a) Optional `HuddleState.connection` (status, message, preview diff) filled by main next to the reducer's state, plus a
`setup.attach` command. (b) Two new IPC channels. (c) A native dialog from main.
**Decision (owner, 2026-11-13).** (a). Additions only; still four IPC functions. `connection` is setup status, not derived from events,
so the reducer never sets it. The preview never carries the token in clear.
**Consequences (2026-11-14).** "One consent" means one consent per change: the stored consent carries the fingerprint of the approved
change (ADR-019), and a later Huddle that would write a different hook table goes back to `needs_consent` with the new diff.

## ADR-018 — Status line bridge: wrap and restore, and it stays when the Huddle quits (2026-11-14) — proposed, awaiting owner review
**Context.** F9 needs the status line JSON (exact context, rate limits). Claude Code runs one `statusLine` command per scope, so the bridge
must replace the user's line and run it itself (INTEGRATION.md "Status line data"). ADR-014 removes the hooks at quit because a stopped
Huddle makes HTTP hooks print errors. Should the bridge be removed at quit too?
**Options.** (a) Remove at quit, put back at start, like the hooks. Every start and quit edits `statusLine`, and a crash leaves it anyway.
(b) Leave it installed until the owner removes it. The wrapper is silent when the Huddle is down: the POST fails quietly within 250 ms and
the user's own line prints exactly as before. (c) No wrapper; ask the user to add a forwarding line to their own script. Rejected: not
restorable, and most users never wrote their status line.
**Proposed decision (default chosen by the core engineer; status stays proposed until the owner reviews it).** (b). Opt-in (off by default), shown in the first-run diff. The installer
saves the user's `statusLine` exactly (or "none") in `<claude config>/agent-huddle/statusline-original.json` (written only by the installer)
and writes `{type:"command", command: node "<that folder>/huddle-statusline.mjs"}`, keeping `padding`, `refreshInterval` and
`hideVimModeIndicator`. Ownership is an exact match on that command, like the hooks. Quit (detach) and every start leave `statusLine`
alone. Withdrawing consent, `HuddleCore.removeStatusLineBridge()`, the installer's `restoreStatusLine` and the M0 script's `--uninstall` put the saved object back deep-equal, or removes the
key when there was none; a `statusLine` the user changed since is not ours and is left alone, with a note saying so.
**Consequences.** One extra Node start (~150 ms, S12) per status line refresh while installed, Huddle running or not. `-p` runs never call the
status line (S12), so headless sessions keep telemetry-only context. The M0 script `scripts/install-hooks.mjs` cannot install the bridge;
its `--uninstall` restores it from the saved file, and leaves it (with a note) when that file is missing. No renderer UI yet: the option and the remove action exist only in `HuddleCore`.

## ADR-019 — PreToolUse hook timeout is 600 s (2026-11-14) — accepted (owner approved 2026-11-14)
**Context.** ADR-011 left open how `PreToolUse` gets a timeout long enough to hold for a pause (F13) and for a question window (F11).
S6 showed that a held `PreToolUse` waits quietly, that parallel calls are held independently, and that at the hook's `timeout` Claude Code
closes the request and the tool call proceeds. Observation answers take about 2 ms (S10), so a long timeout costs nothing while the Huddle
answers promptly.
**Options.** (a) Install `PreToolUse` with a 600 s timeout and keep answering unheld calls at once. (b) A second, long-timeout
`PreToolUse` entry that answers only for paused agents. Rejected: Claude Code would POST twice per tool call, and how it merges two
answers to one event (which `permissionDecision` or `additionalContext` wins) is unproven. (c) Rewrite `settings.json` with a long
timeout whenever a pause starts and back when it ends. Rejected: it edits user config repeatedly, a crash mid-pause leaves the long
value behind, and sessions that are already running may not pick the change up.
**Decision.** (a). `TIMEOUTS.PreToolUse = 600` in `packages/core/src/setup/install-hooks.ts`, exported as `HOLD_TIMEOUT_S` (and the
PermissionRequest value as `PERMISSION_TIMEOUT_S`) so the normalizer and the broker use the same number. `scripts/install-hooks.mjs` uses
the same table; a parity test in `install-hooks.test.ts` runs the script's dry run and compares its hook entries with the core plan. Other
events keep their timeouts (5 s; SessionEnd 1 s; PermissionRequest 600 s). `--timeout PreToolUse=<s>` still overrides it.
**Consequences.** A frozen Huddle (process alive, not answering) can stall a tool call for up to 600 s; a crashed or stopped Huddle fails
open at once (connection refused, the call proceeds). The question hold window defaults to 120 s, well inside the limit. The broker releases
its own holds at `HOLD_TIMEOUT_S − 5 s` (`hold_limit`), so Claude Code's own timeout is a backstop, not the normal ending; the pause
countdown in the UI counts to that release. Settings written with the M2 table (PreToolUse 5 s) differ from the new plan: the install plan
is a change and its fingerprint differs, so the owner must re-install the hooks. The app's remembered consent is tied to the change
that was approved (gap closed 2026-11-14): Connect stores `consentedFingerprint` (`SettingsPlan.consentFingerprint`, a SHA-256 of the
Huddle's hook entries and telemetry env with port and token masked and the status line left out) next to `consentedAt` and
`consentedFor` in `huddle-settings.json`. A start attaches by itself only when the change it would write has that fingerprint; otherwise it
shows the diff again (`needs_consent`) and writes nothing. A consent saved before the field existed has no fingerprint, so it asks once more:
the owner sees the 5 s to 600 s diff once after this update, which is intended. Withdrawing consent clears all three fields.
**Supersedes.** ADR-011's "Keep 5 s by default" for `PreToolUse` and its open choice between (a) and (b). The rest of ADR-011 stands: a
pause cannot outlast the timeout, and when it lapses the agent continues and the UI says so.

## ADR-020 — M4: managed runs, worktrees, rules and budgets (2026-11-14) — accepted (owner approved the plan 2026-11-14)
**Context.** M4 (F13 stop, F16–F20) makes the Huddle start and govern runs. Plan: `huddle-architect`, 2026-11-14. The choices below
were put to the owner with alternatives; the owner took the recommended option each time.
**Decisions.**
1. **Launch** spawns `claude -p --input-format stream-json --output-format stream-json --verbose` with an args array, `shell:false`;
   the prompt goes over stdin (S8), never on the command line. A team template defines its agents with `--agents` JSON, so the user's
   repo is not written to. Launching needs an attached connection: the product never adds hooks through `--settings` (S13 left open
   whether user and `--settings` hooks merge; if they do, every hook would post twice and PermissionRequest has no `tool_use_id` to dedupe).
   Only exit harnesses use `--settings`, on a private port with the app closed.
2. **Worktrees** are created by the Huddle with `git worktree add`, not Claude Code's `--worktree`, so the path, branch and base commit
   are known and diff, keep and discard are deterministic. Location `%LOCALAPPDATA%/agent-huddle/worktrees/<runId>`, branch
   `huddle/<runId>`. Discard removes the worktree **and** the branch; it refuses a path the Huddle did not create and a run whose process
   is alive. Cost: gitignored files (`node_modules`, `.env`) are not in the worktree; the launch dialog says so.
3. **Rules** (F18) are evaluated on `PermissionRequest` only, so a rule can remove a prompt Claude Code would show, never widen what is
   allowed. Precedence deny > ask > allow. Rules read the raw tool input in memory (`normalize/hook-facts.ts`), never the stored, clipped
   and masked `toolInput`; an allow rule never matches a clipped/masked input or a compound command. A rule's deny message names the rule
   and does not use the user's `DENY_PREFIX`. Default set allows only read-only commands (`git status|diff|log` without `--output`,
   `ls`/`dir`/`Get-ChildItem`, `pwd`, `node|npm|claude --version`); nothing deletes, force-pushes, installs packages or uses the network.
   Until S15 was run, rules applied to managed sessions only: setting `policy.applyToAttached` defaults to `false`. S15 ran 2026-11-14 (no late-Allow window: the hold closes about 60 ms after a terminal answer), so it no longer blocks turning it on; the default stays `false` until the owner decides.
4. **Budgets** (F19) count tokens as input + output + cache creation (cache reads excluded). Enforcement uses the M3 pause (held
   PreToolUse), not `--max-budget-usd` (cost only, ends the run). Telemetry lands 1–3 s late, so a run can overshoot by about one call;
   the UI says so. When a budget pause reaches the hold limit (595 s) on a **managed** run, the run is stopped (this differs from a user
   pause, which lapses and continues, ADR-011). An attached session cannot be stopped; it continues and the budget item stays in the inbox.
5. **Messages to a managed root**: stdin is read only after a turn's `result` (S8), so a message to a working root goes through the M3
   outbox (note at the next tool call); stdin is used when the root is idle. Managed subagents get `message: 'queued'`.
**New events (additive, no existing field changes meaning).** `run.launched`, `run.exited`, `run.result`, `worktree.created`,
`worktree.summarized`, `worktree.closed`, `budget.set`. Reused: `limits.measured` gains source `stream`; `message.delivered` gains
`via:'stream_input'`; `control.applied` gains `launch`, `stop`, `interrupt`; `attention.raised` gains kind `budget`.
**Other surface.** One read-only IPC invoke `huddle:query` (`policy.preview`, `pick.folder`); stored files `policy-rules.json`,
`templates.json` in the app data folder. No new listener, HTTP route or dependency.
**Deferred.** Background sessions (`claude agents --json`, `claude stop`) and the status line toggle (waits on the ADR-018 review).
**Reducer fixes that come with it.** A managed root stays managed when a later hook `SessionStart` says `attached`.
**Added during the build (security reviews, 2026-11-14).**
- An allow matches only when all hold: the session's trusted folder is known (`AgentNode.sessionCwd`, set once: `run.launched`,
  else the first `SessionStart`) and the payload `cwd` is inside it; the run is live (a managed root whose run exited, e.g. resumed
  with `claude --resume` in a terminal, is treated as attached); the input was not clipped or masked; the command is printable ASCII,
  one plain command (no compound, redirect, substitution, glob, backslash or tilde in Bash; no `::`, provider drive, wildcard or
  grouping in PowerShell), no `--ou…`/`--ext…` argument, no double separator (network paths); and no path or token, as written,
  normalized or resolved, touches a Claude Code protected path (INTEGRATION.md §3), a `..`, or an 8.3 short name. File-tool allows
  must name paths inside the trusted folder. Rules that allow a whole shell tool, or a bare program name other than `ls`, `dir`, `pwd`,
  `Get-ChildItem`, `Get-Location`, are refused on save. A template with its own `ruleIds` is refused at launch (not applied yet).
- `claude` is resolved once to an absolute `.com`/`.exe` from the run env's PATH (absolute local entries only; a `.cmd` shim is
  refused), never spawned by bare name in the run folder. Folder inputs must be local absolute paths (no UNC, device or NT forms)
  before any file-system call. Nested Claude Code session markers are removed from a run's environment (list in INTEGRATION.md §3).
- The Huddle's own git calls in a worktree run hardened: `core.fsmonitor=false`, disabled hooks and attributes, filter drivers
  blanked, no submodule recursion, no external diff or textconv, `protocol.allow=never`; the `.git` link is verified against the
  git folder recorded at create. Discard never follows junctions.
- Known limits (accepted for M4): shell arguments are not contained in the session folder (a default `Get-ChildItem C:\other`
  still lists names outside it); user allows on two-word prefixes that run code (`node -e`, `npm run`) are only warned about in the
  editor; Glob's `pattern` is not checked.
- Crash recovery (follow-up, 2026-11-14): `runs.json` in the app data folder lists `{runId, pid, startedAt, command}` of every live
  run (written after the spawn, removed at the exit). At start, after replay and once the port is bound (a second Huddle on the
  same folder fails there first), before launching is allowed, each listed run and each replayed run without `run.exited` is
  checked: a live pid whose command line (PowerShell `Get-CimInstance Win32_Process`, `wmic` as fallback, `ps` elsewhere) carries
  `--session-id <runId>` has its tree killed (`taskkill /T /F`); a pid that cannot be verified is never killed (pid reuse). Then
  `run.exited{how:'stopped', exitCode:null}` with the reason in `error` (stopped / had already ended / could not be checked),
  `message.dropped agent_ended`, and `worktree.summarized`, so discard works. A verified process that survives the kill gets no
  `run.exited`, an error item, and stays listed. Known limit: a crash between the spawn and the `runs.json` write (milliseconds)
  leaves a run that is ended in the log as "could not be checked" while its process may live on.
- Messages to a managed root (follow-up to §5, 2026-11-14): whatever is still in the root's outbox when its turn ends (driver idle
  after `result`) is written to stdin as one user message, in queue order, and each is recorded `message.delivered
  via:'stream_input'` at once, so no later PreToolUse can deliver it again. Usually a `next_tool` note that missed the last tool
  call; also an `auto` or `turn_end` message queued after the turn's Stop was answered.

## ADR-021 — M5: SQLite event store, migration, retention and the history service (2026-11-14) — accepted (owner approved the plan 2026-11-14)
**Context.** M5 (F22–F24) needs history queries, search and scorecards over every stored event. ADR-003 planned SQLite for this and
preferred a built-in module. Plan: `huddle-architect`, 2026-11-14.
**Decisions.**
1. **Store.** `SqliteEventStore` on built-in `node:sqlite` (`DatabaseSync`): no native dependency, so ADR-003 holds. Electron 45 ships
   Node 24.22, so `engines.node` is `>=24` (Node 22.12 still needs a flag). One table of events as masked JSON (`id` UNIQUE, indexes on
   session, agent and type) is the source of truth; `sessions`, `sessions_fts` (FTS5, built in), `run_derivations` and `agent_runs`
   are derived, versioned and rebuildable. One connection, WAL, `busy_timeout` 500 ms in the app (the wait is synchronous on the thread
   that answers hooks). Database and side files user-only (0o600), folder 0o700. Both stores share one serializer (`store/codec.ts`):
   `tool_response` dropped, `maskSecrets` again on write.
2. **Migration.** One-shot import of the M1–M4 JSONL at start-up, before the hook server listens; batches keyed on `id`, so a rerun is a
   no-op; every event masked again on the way (the "redaction pass" for old data); per-session id check; only then `events/` is renamed
   to `events.migrated-<date>`. The migration deletes nothing. Rollback: rename the folder back, move `huddle.sqlite` aside. If the
   database cannot be opened the app records to JSONL instead (`storeKind: 'jsonl-fallback'`) and leaves the file untouched. Dual-write
   was rejected (two sources of truth, double I/O on the hook path).
3. **Start-up window.** Only open sessions, the last 24 h, the budget session, runs still in `runs.json`, and every session active since
   the overall budget in force was set are reduced into live state; older runs stay in the database for History.
4. **Replay** is the pure reducer over a prefix: `stateAt(i)` = the nearest in-memory checkpoint (every 500 events, wider past 400
   checkpoints; never on disk) plus the events after it, read and reduced 500 at a time with a yield between, so no synchronous step
   exceeds about 500 events whatever the interval (security review L2); a session over 2,000,000 events is not indexed and replay
   answers `failed` saying so; LRU of 3 sessions; 250-row chunks with yields (hook p99 9–23 ms during a 20k-event replay). Nothing derived is
   stored for replay, so a reducer change never invalidates history. It runs in main behind `history.stateAt` because the renderer
   cannot import the reducer (ADR-016).
5. **Reports** are written on the root's `session.ended`, `run.exited` (taskkill sends no SessionEnd, S16) and the worktree summary,
   debounced, off the hook path, atomically to `<dataDir>/reports/<id>.md` (0o600). The in-app view is built from the structured
   `RunReport` as text nodes; the Markdown escapes agent text so it cannot form links, images or HTML in another viewer.
6. **Retention and delete all, an explicit exception to "append-only".** Retention (default 30 days; at start, daily, and at once when
   lowered after a confirmation) and "delete all history" delete whole sessions: events, search and derived rows and report files, in
   chunked transactions with `secure_delete` on; VACUUM only when little is left. They never delete a live session or the budget
   session, and retention never deletes a session an overall budget in force is counting. A new event `history.pruned {sessionIds,
   reason, count}` in a Huddle-own session lets the reducer drop those sessions, so state still changes only through events (rule 1).
   Agent nicknames are copied into settings first and survive. Delete all also removes the older JSONL folders without following links
   or junctions (`runtime/safe-remove.ts`); once `jsonl_migrated_at` is set, retention removes each such folder whose newest file is
   older than the cutoff and keeps (and logs) one that holds a newer file. On the JSONL fallback both delete whole
   `<sessionId>.jsonl` files by file time, never a live session's or the budget session's (security review M1). Lowering the
   retention must carry the run count the preview showed; the core counts again in the same queued job and refuses a mismatch (L4).
**New events (additive).** `history.pruned`. **New stored files.** `huddle.sqlite` (+ `-wal`, `-shm`), `reports/<sessionId>.md`.
**New IPC.** None: queries ride `huddle:query`, commands `huddle:command`.
**Known limits.** After a *failed* import retried on a later start, a resumed session's old events get higher `seq` than its new ones
(`readSession` order). The POSIX permission tests are skipped on Windows and have not run yet.

## ADR-022 — M5: Ask the Huddle sends a masked summary to Anthropic, opt-in (2026-11-14) — accepted (owner decision 2026-11-14)
**Context.** F25 answers a question with a model call. That sends text off the machine, which `SECURITY.md` ("Nothing leaves the
machine") and `SPEC.md` §6.2 ruled out. The owner chose: opt-in and off by default, Haiku, answers never stored, refuse when an API key
is set (it would bill the key instead of the subscription, ADR-004).
**Decisions.**
1. **Consent.** `ask.enabled` defaults to false; the switch in Settings says in plain words what leaves the machine. "What will be sent"
   shows the exact text (system prompt and stdin) before asking, also while Ask is off; nothing is sent from that view.
2. **Command** (S18, run-checked on 2.1.325): `claude -p --output-format json --model haiku --max-turns 1 --tools "" --disallowedTools
   "mcp__*" --strict-mcp-config --mcp-config {"mcpServers":{}} --permission-mode dontAsk --permission-prompts none
   --disable-slash-commands --no-session-persistence --settings <disableAllHooks, autoMemoryEnabled false, telemetry-off env>
   --system-prompt <fixed>`, stdin = the context. No tool can be called (an injected "run this" did nothing), no hook fires, no
   transcript is written, about 3.8k context tokens, 2.5–6 s. The cwd is an empty temp folder; `claude` is resolved to an absolute exe
   and spawned with `shell:false`; a 30 s timeout kills the tree; one ask at a time.
3. **Telemetry.** `disableAllHooks` does not switch off the installer's OTEL variables in the user's `env` block; S18 h showed every ask
   exporting to the Huddle port (2 posts). The ask's `--settings` `env` and child env turn telemetry off and point the endpoint at a
   closed port (S18 h: 0 posts). `runtime/ask-guard.ts` stays as defence in depth (drops the ask session's events).
4. **Context.** A bounded summary (≤ 50 KB): sessions, agents, open items and the last 40 events, every piece masked, one line and
   clipped; `<huddle-context>` markers in agent text are neutralised; never `tool_response`, tool input, briefs or full prompts.
5. **Answer.** Plain text in component state only: never in the event log, on disk or in logs (only outcome, time and token counts are
   logged). Nothing in it can become a command.
6. **Refusals.** `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set → `api_key_set`, shown before asking (`HuddleState.ask`).
**Doc amendments.** `SECURITY.md` "What must stay true" #3 and `SPEC.md` §6.2: nothing leaves the machine unless you turn on phone
access or Ask the Huddle.
**Refusals, added after the M5 security review (L1).** `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` set
(not empty, not "0") → `other_provider`. The key names (never values) of the `env` block of the user's `settings.json` are read
too, before every ask: the credential names there → `api_key_set`, the provider names → `other_provider`, and an `apiKeyHelper`
→ `api_key_set`. `HuddleState.ask.otherProvider` (optional) shows it before asking.
**Known limits.** `apiKeyHelper` and the variables above are detected in the user's `settings.json` only, not in managed
(enterprise) settings. "Not logged in" is detected by conservative text matching (S18 never ran logged out).
When an ask times out or is cancelled, held telemetry of a brand-new session is dropped (seconds of usage). "Copy answer" goes through main
(`ask.copyAnswer`, validated and clipped there, written with Electron's clipboard), because the renderer's clipboard API is
blocked by main's permission handler; if the copy fails the view still selects the text for Ctrl+C.

## ADR-023 — ETA priors from scorecards live outside the reducer (2026-11-14) — accepted
ETA priors come from the scorecards and live in `HuddleState.priors`, which the core fills next to the reducer's state (like
`connection`, ADR-017). It recomputes them, debounced and cached, after the backfill and after each new report. The reducer never writes
them and the selectors receive them as an argument, so replay and tests stay pure; a `priors.updated` event was rejected because it
would put derived values in the log. The prior is judged by leave-one-out over `fixtures/runs`: each run is scored with priors from the
other runs only, because tuning and scoring on the same runs would flatter it. On the 15 recorded Haiku/Opus runs this raised the judge
group from 6/10 to 8/10 runs and from 33/48 to 37/48 check points (median error 11.2 s → 9.2 s), with tune unchanged, so
`USE_ETA_PRIORS` defaults to on. Re-checked with all 30 runs (15 more with Sonnet subagents, 2026-11-15, `npm run m5:exit`):
judge 8/20 → 12/20 runs and 54/98 → 63/98 check points (median error 12.1 s → 11.6 s); tune 24/38 → 25/38 points with the median
error 14.0 s → 14.4 s, so the default stays on. A subagent's prior is the mean over its parent's direct subagents' (role, model) priors; an agent's
own prior is used for its task basis only.

## ADR-024 — M6: phone access is a second, opt-in listener on one LAN address (2026-11-16) — accepted (owner approved the design 2026-11-16)
**Context.** F26 asks for approvals from a phone. Everything else listens on `127.0.0.1` and rejects any request with an
`Origin` header, which a phone browser always sends. Alternatives: Claude Code's Remote Control (one session at a time, no
team view), a cloud relay (breaks "nothing leaves the machine"), self-signed TLS (certificate warnings on every phone, a
new dependency), WebSocket (no server in Node's standard library).
**Decision.** A separate `node:http` listener in `packages/core/src/phone/`, never sharing the hook port:
- Off by default and off after every restart (only the last chosen address is saved, so a café network handing out the
  same private IP never opens it by itself). Binds one private LAN IPv4 this computer has now (RFC 1918 or link-local),
  never `0.0.0.0`, loopback or a public address; closes when that address goes away.
- Pairing: a 6-digit code shown on the desktop, single use, 2 minutes, 5 tries, never stored or logged; a per-device
  random token, stored only as its sha-256 in `phone-devices.json` (owner-only). Revoke takes effect at once.
- Every request: rate limit, `Host` exactly `<ip>:<port>` (DNS rebinding), `Origin` absent or exactly the listener's own
  `http://<ip>:<port>` (**the one exception to "reject any Origin"**: the phone page is served from this origin, so its
  own requests carry it), `Authorization: Bearer` for the API, JSON bodies up to 4 KiB, strict CSP, no CORS headers.
- Scope: the phone reads live sessions, agents (name, role, status, progress) and open inbox items with masked
  summaries, and may Allow or Deny approvals already held, through the same broker path as the desktop
  (`approval.resolved.via: 'phone'`). It may not message, answer questions, pause, stop, launch, change rules or budgets,
  open history or use Ask (as decided then). **Widened by ADR-030 (2026-11-17):** a phone may now also answer held questions, message,
  pause, resume and stop (managed runs), through an explicit allowlist; launch, rules, budgets, history and Ask stay out.
- Live updates by server-sent events read with `fetch` (the token stays in a header, never in a URL).
- Plain HTTP: the Settings text says to use it only on a trusted network. Auto-off after 8 hours without a phone action
  (pairing, a fresh page open, Allow, Deny; stream reconnects do not count, owner 2026-11-16).
**Consequences.** Anyone who can read the Wi-Fi traffic can read a device token and the masked view, and approve held
requests until it is revoked or auto-off closes access; the trusted-network warning, the narrow scope and auto-off are
the mitigations. The hook listener's rules are unchanged.

## ADR-025 — M6: self-reported progress through the PostToolUse hook; how the MCP server is registered (2026-11-16) — proposed (P4)
**Context.** F27 lets an agent say how far along it is. S19 confirmed a zero-dependency stdio MCP server (`scripts/huddle-mcp.mjs`) whose
`report_progress` tool only answers `ok`; Claude Code fires PreToolUse/PostToolUse for `mcp__huddle__report_progress` with the agent's
`tool_input` and `agent_id`, so the Huddle reads every report from the hooks it already has (P2: normalizer, `AgentNode.selfReport`).
The server needs no connection back to the Huddle. What remains is how a session gets the server.
**Decision.**
1. **Managed runs: per-run `--mcp-config`, not strict.** Each run with self-report on gets `<dataDir>/run-mcp/<runId>/` (owner-only) with a
   copy of the server script, `mcp.json` (`node` as an absolute path found on PATH, M2) and a per-run `--settings` file holding only
   `permissions.allow: ["mcp__huddle__report_progress"]` (S19 d). The launch prompt gets `HUDDLE_PROGRESS_PROMPT_LINE` (S19 e: 0-2 main-agent
   calls without it, 3-5 with it), and every template agent with a `tools:` list gets the tool appended (S19 c). The folder is removed at
   the run's exit or failed start and swept at core start. **No `--strict-mcp-config`**: it would drop the user's own MCP servers for the
   run, which a template's agents may rely on; S19 used it only to isolate the spike. Switches: the global `selfReport.enabled` setting
   (default on, `settings.update`) and `TeamTemplate.selfReport: false`; the global switch wins. Every failure (no script shipped, no
   `node`, a write error) launches the run without self-report (fail open). Nothing is written under the Claude config folder.
   This amends ADR-020 §1 in one point: the product now passes `--settings`, but that file carries one permission entry and never hooks.
2. **Attached sessions: opt-in, through Claude Code's own CLI only.** `~/.claude.json` falls under the same rule as `~/.claude/**` (owner,
   2026-11-16): the Huddle never writes it. Registration runs `claude mcp add --scope user huddle -- <node> <config dir>/agent-huddle/huddle-mcp.mjs`
   (argv array, no shell) after the user saw the exact command and the `mcpServers.huddle` diff (`setup.selfReportPreview`; the command
   carries the preview's fingerprint, like the hook consent) and is undone by `claude mcp remove --scope user huddle`, by withdrawing
   consent, and by `install-hooks.mjs --uninstall`. A `huddle` server that is not the Huddle's (any entry whose only argument is not our
   copy) is never replaced or removed. The file is read back after each command and checked. Off unless the user agrees; it is not
   undone at quit (the server is a stub that answers `ok`, harmless while the Huddle is closed). `CLAUDE_CONFIG_DIR` moves `.claude.json`
   (S19 g); for the default `~/.claude` the variable is not set for the child, because setting it would move the file.
   Attached sessions do not get the prompt line, so their agents report less (S19 e).
**Alternatives.** Strict per-run config (isolation, but drops the user's servers); `--allowedTools` instead of a `--settings` permission
(not run-checked, and variadic on the command line); writing `.claude.json` directly (forbidden by the owner rule); a server that
posts to the Huddle (needs the token in the server's env and a new route; the hooks already carry the report).
**Known gaps.** An attached session's first call may raise a PermissionRequest (no allow entry is added to the user's settings.json).
Whether a user-scope `huddle` server and the per-run one collide in a managed run is not run-checked (same tool name; harmless when both
are ours). A `mainAgent` that is a user agent file with a `tools:` list does not get the tool. The packaged build must ship
`huddle-mcp.mjs` next to the forwarder (P6).

## ADR-026 — M6: packaging with electron-builder, NSIS per user, no auto-update (2026-11-16) — accepted (owner decision 2026-11-16)
**Context.** P6 makes an installer for the owner's own machine. Claude Code runs the Huddle's scripts (SessionStart
forwarder, status line bridge, self-report MCP server) with the user's own `node`, and the core serves the phone page
with plain fs, so none of them can live inside `app.asar`. The installer must never touch `~/.claude/**` (ADR-014: only
the app changes it, after consent).
**Decision.**
1. **electron-builder** (dev dependency, 26.18.x), NSIS one-click, `perMachine: false` (installs to
   `%LOCALAPPDATA%\Programs\Agent Huddle`, no admin), x64, unsigned (SmartScreen warns on first run). `appId` equals the
   AppUserModelID main sets (`AgentHuddle.Desktop`), so toasts group under the Start menu shortcut. Electron is taken from
   `node_modules/electron/dist` at the pinned version (no download). Fuses: RunAsNode, NODE_OPTIONS and inspect
   arguments off; asar integrity validation and only-load-from-asar on.
2. **extraResources**: `huddle-forward-hook.mjs`, `huddle-statusline.mjs`, `huddle-mcp.mjs`, `phone/` and `tray.ico` sit
   in `resources/` next to `app.asar`; `core-config.ts` resolves them there when packaged (S23 b).
3. **No auto-update.** `publish: null`, no updater code, no feed. A new version is a new installer run by hand.
4. **Uninstall leaves Claude Code alone.** The NSIS uninstaller does not touch `~/.claude` or `~/.claude.json`; it shows
   a reminder (quit from the tray, then `"Agent Huddle.exe" --remove-hooks`) with Cancel, removes only the login item's
   registry values, and keeps the app data folder. The packaged "remove hooks" command (M1 carry-over) is the exe with
   `--remove-hooks`: hooks, telemetry env vars and the status line bridge, through the core's `HookInstaller`; refused
   while the app runs. The forwarder's "Huddle not running" hint names it. *Amended 2026-11-16 (owner):* it is the full
   clean-up: also the remembered consent (`forgetConsent`, the same change as withdrawing consent) and the self-report
   MCP registration through `McpRegistrar.removeIfOurs` (`claude mcp remove --scope user huddle`; a foreign `huddle`
   server is left and named in the result). The app version is 0.6.0.
5. **Start with Windows**: optional, off by default, a Settings switch through `settings.update`
   (`UserSettings.startWithWindows`, owned by desktop main, read from the Windows login item, never stored). Only in the
   packaged app.
**Alternatives.** electron-forge with Squirrel (per-user too, but Squirrel's update-first layout and shortcuts are more
than a one-machine install needs); a portable zip (no Start menu entry, no uninstall); the uninstaller running
`--remove-hooks` itself (it would edit `~/.claude` from an installer, against ADR-014's single path); auto-update through
GitHub releases (needs signing and a feed for one user).

## ADR-027 — M6: agent teams: idle is not done; the lead checks on idle teammates (2026-11-16) — accepted (owner decision 2026-11-16, P5b)
**Context.** S20 showed how a teammate looks in hooks: `agent_id` = `a` + `agent_type` + `-` + 16 hex, `agent_type` = its
name, the lead's `session_id`; `SubagentStop` then `TeammateIdle` about 20 ms later after every turn. A teammate that went
idle waits for messages: it may be finished, or waiting for a result from another teammate. Claude Code does not say which,
so counting idle as done would fill the lead's bar too early, and counting it as open forever would never fill it.
**Decision.**
1. **Idle is not done.** A teammate node (`kind: 'teammate'`, always under the lead) is idle after `teammate.idle` (endedAt
   null) and counts as open in the lead's subagent basis (ADR-010). It counts as finished only when done.
2. **The lead says which.** The Huddle MCP server gets a second tool, `report_teammate {name, status: finished|waiting,
   note?}` (answers `ok`, like `report_progress`). Its PostToolUse becomes the additive event `teammate.reported` on the
   caller's key. The reducer finds the teammate in the caller's session by name; `finished` makes an idle teammate done
   with endedAt = the event time, `waiting` changes nothing. A done teammate that acts again (a tool event or a new
   `agent.started`) is working again with endedAt null; only teammates revive like this, a plain subagent's done stays.
3. **The Huddle asks.** When a teammate goes idle, the Huddle queues ONE message to the lead through the outbox (F12),
   source `huddle`, delivery `auto` (next PreToolUse note or Stop continuation), text: *Agent Huddle (an automatic check,
   not a message from the user): teammate "<name>" is idle. Check with it whether it is finished or waiting for a result,
   then call the tool report_teammate with name "<name>" and status "finished" or "waiting".* A delivery made only of
   Huddle messages carries no "from the user" prefix (`QueuedMessage.author: 'huddle'`, additive); a mixed one keeps it.
   The name comes from the agent, so it is stripped of control, bidi and quoting characters and clipped to 100.
4. **Only where the tool exists.** Sent only when the lead has the server: a managed run started with self-report on
   (RunHost, in memory), or the user-scope registration (ADR-025 §2) is active. The registration is read from
   `.claude.json` off the hook path (at start, after register/unregister, after consent is withdrawn, with each preview)
   and cached; the hook path never reads a file. Also needed: the lead can be messaged (`capabilities.message`), it has
   not ended, and the setting `teams.askLeadOnIdle` is on (default on). Never for the main agent.
5. **Dedupe, per teammate.** One message per idle period; a new one only after the lead answered (`teammate.reported`
   naming it) AND the teammate then worked again; never while the previous one is undelivered; at most 3 per teammate
   while the core runs (memo in memory, like the detectors'). Work before the answer does not re-arm: the lead's own
   check wakes the teammate, and counting that would make every check cause the next one.
6. Managed runs get `mcp__huddle__report_teammate` in the per-run `permissions.allow` next to `report_progress`.
**Alternatives.** Idle = done (wrong for a teammate waiting on another); `TaskCompleted` (not observed in S20: the lead
drove teammates with `Agent`, not tasks); a timer that calls an idle teammate done after N minutes (a guess); answering
`TeammateIdle` with exit 2 to keep the teammate working (changes the team's behaviour, and the Huddle answers
observation hooks with an empty 200); asking the user instead of the lead (the lead knows; the user often does not).
**Limits.** Only where the server is registered or the run has it; elsewhere nothing is sent and idle teammates stay open.
Each check costs the lead a few tokens and may wake a lead that had stopped for one more turn (the Stop continuation).
An attached session's first `report_teammate` call may raise a PermissionRequest (no allow entry in the user's settings).
Under `-p` there are no teammates (S20 a), so a managed lead is asked only if a future Claude Code spawns teammates there.
A lead that never answers is not asked about that teammate again until it does. Not run-checked against a real team yet:
the end-to-end path is tested over HTTP with S20-shaped payloads and the derived fixture `agent-team-report.jsonl`.
This is the one exception to "the broker never writes a message the user did not write" (broker rules), chosen by the
owner; the message says it is from the Huddle.

## ADR-028 — F28: the Huddle writes Claude Code skills only into known project folders (2026-11-17) — accepted (built overnight on the owner's request; owner accepted 2026-11-17)
**Context.** The owner asked that "Huddle should be the orchestrator and create skills and tasks too". A skill is a
folder with `SKILL.md` (YAML frontmatter `name`, `description`, then instructions) under `<project>/.claude/skills/` or
the user's `~/.claude/skills/`. Writing files from a desktop app that agents can influence is new for the Huddle: until
now it wrote only into its own data folder, its worktrees, and (through the installer, after consent) `settings.json`.
**Decision.**
1. **Where.** Only `<project>/.claude/skills/<name>/SKILL.md`, and the project must be one of the *known projects*
   (`selectKnownProjects`: a folder a session in the state ran in, a saved template's folder, or a task's folder), picked
   from a list; the renderer names it, the core finds it in its own list and uses the path it has. Never a typed path.
   The user's own skills folder is listed read-only and never written (CONTRIBUTING.md: never edit `~/.claude/**`).
2. **Checks** (runtime/skills.ts): the name pattern `^[a-z0-9][a-z0-9-]{0,63}$` (no separator, dot or drive); a plain
   local absolute path (`isLocalAbsolutePath`, before any file system call, and again on the real path, so a link to a
   network share `\\server\share` or a device path `\\?\`, `\\.\` is refused); the real path not too broad
   (`isTooBroadFolder`: a drive, a home folder or Documents, so `<home>/.claude/skills` is never a target); `.claude`,
   `skills` and the skill folder each a real folder, not a symlink or junction, made one level at a time; none inside
   Claude Code's config folder or `<home>/.claude`; `SKILL.md` a plain file; a temp file (`wx`) renamed over it after
   the folder is checked again. An existing file is replaced only with `overwrite: true`, which the UI sends only after
   "Replace it" (the first answer is `{ ok: false, exists: true }`).
3. **Not an event.** A skill file is configuration that lives in the project (like templates.json for templates): no
   event is written and the Huddle stores nothing of its content.
4. **Frontmatter parsed by hand** (no YAML dependency): `key: value` lines, quoted values and `>`/`|` blocks; values are
   clipped and flattened to one line and shown as text. The writer emits the description as a JSON string (a valid YAML
   double-quoted scalar), so typed text cannot end the frontmatter or add a key.
5. **No "Draft with Huddle".** Reusing the Ask runner to draft instructions would send the whole Huddle context (the
   state and recent events) for a job that does not need it. Instead an Ask answer has "Create skill from this", which
   only fills the form; the user reviews and saves. Alternatives considered: a separate one-shot `claude -p` with no
   context (a second runner to keep safe; deferred), and picking skills in the launch form (not needed yet).
6. **Known limit: check then use.** Every check is a separate file system call before the write, so a folder swapped
   for a link by another program in the moment between the last check (just before the rename) and the rename is not
   detected; Node has no portable "open relative to this folder handle, never follow links" call to close that window.
   Accepted because the Huddle is local and single user: the only thing that can swap the folder is a program already
   running as the user, which can write the file itself, and every path checked lies under a project folder the user
   already works in. The rename (retried when Windows briefly holds the file) replaces `SKILL.md`, so a hard link to
   another file is never written through.
7. **Known projects are not capped for checks.** `MAX_KNOWN_PROJECTS` (50) caps only what `skills.list` shows and
   searches; whether a skill or task may use a folder is checked against every known project (release review
   2026-11-17: the 51st project was refused).

## ADR-029 — F29: the Huddle's task list is a log of huddle_task.* events on its own session (2026-11-17) — accepted (built overnight on the owner's request; owner accepted 2026-11-17)
**Context.** The Huddle should hand out work: a list of tasks that launch runs and follow their outcome. Claude Code's
own tasks already use `task.created` / `task.started` / `task.completed` (agents' TaskCreate), so those names are taken.
**Decision.**
1. Three additive event types, `huddle_task.created`, `huddle_task.updated` (only the fields present change) and
   `huddle_task.deleted`, filed under the Huddle's own session `huddle-tasks` (TASKS_SESSION_ID, with the budget,
   history and phone sessions in `HUDDLE_SESSION_IDS`). The reducer keeps `HuddleState.huddleTasks` (at most 500,
   oldest out); `selectHuddleTasks` (shared) derives the shown status from the linked run while the state has it.
2. The session is replayed at every start (with the budgets), never listed as a run, and kept by the retention and by
   "delete all history" like the overall budgets: it is the user's to-do list, not run history. Deleting a task appends
   `huddle_task.deleted`; the earlier events (clipped, masked text the user typed) stay in the local log. Alternative:
   a `tasks.json` file like templates (no history, simpler deletion); rejected because "everything is an event" is a
   binding rule and the status history is useful in replay.
3. Launch goes through `RunHost.launch`, the path of `run.launch`: the task's template with the task text as the prompt
   override (in the task's folder when it has one), or a plain run in the folder (default permission mode, no
   worktree, no agents). The run id links the task (`huddle_task.updated {runId, status: running}`).
4. When a linked run's `run.exited` goes through the core, the core appends `huddle_task.updated {status}` (source
   huddle: completed is done, anything else failed), so the outcome survives the run leaving the replay window. This is
   edge logic like the detectors; the reducer stays pure.
5. A status the user may set is only `todo` or `done`; `running` and `failed` come from the run.

## ADR-030 — Phone controls: answer, message, pause, resume and stop from a paired phone (2026-11-17) — accepted (owner asked for the feature; built overnight; owner accepted the decisions below 2026-11-17)
**Context.** ADR-024 let a paired phone only Allow or Deny held approvals. The owner asked to fully interact with agents
from the phone: answer held questions (single, multi-select, typed "Other"), message an agent, pause, resume and stop a
session, on a mobile-first page. The listener, pairing, tokens, Host/Origin checks, body limit and auto-off stay as in
ADR-024.
**Decision.**
1. **One new route with an explicit allowlist.** `POST /api/act` takes a JSON body whose `type` is one of
   `PHONE_ACTION_TYPES` (shared): `question.answer`, `agent.message`, `agent.pause`, `agent.resume`, `agent.stop`. A body
   whose `type` is anything else (`run.launch`, `all.stop`, `agent.setModel`, rules, budgets, settings, history, Ask,
   phone commands) is 403 before the core sees it; a wrong shape is 400 (zod). The action is rebuilt field by field, so
   unknown fields never pass. Same token, Host, Origin and content type as every API route; its body limit is
   `MAX_ACT_BODY_BYTES` (10 typed answers × 1000 characters × 6 bytes, the worst JSON escape, plus 4 KiB, about 62 KiB;
   read only after the device token passed), the other routes keep 4 KiB (release review 2026-11-17: a full answer did
   not fit 4 KiB). Plus its own rate limit per address (burst 20, then one every 3 s). An action counts as use for the 8-hour auto-off.
   Alternatives: one route per action (more surface, same checks), or forwarding any `HuddleCommand` with a deny list
   (a new command would be reachable by default). The allowlist is the smallest surface that does the job.
2. **The target must be on the phone now, and allowed there.** HuddleCore runs an action only when its agent is in the
   phone view (a live session heard from since start) or its question is an open item there, and the view's control is
   enabled. Controls come from the desktop's own selectors: `selectControls` (message, pause, resume, answer; these read
   `AgentNode.capabilities`) and `selectRunControls` (stop: the main agent of a run this Huddle launched, process alive).
   The capability is checked once more next to the command. Disabled controls carry the desktop's reason words, which
   the page shows. The view reads the connection as attached, as the broker does: the phone only lists sessions whose
   hooks are arriving.
3. **The desktop's path, marked `via: 'phone'`.** Answers, messages, pause and resume go through `Broker.command` with
   the origin `{ via: 'phone' }` (never read from a body or an IPC command), a managed root's live message and stop
   through the run host. `question.answered`, `message.queued` and `control.applied` gain the optional field
   `via?: 'desktop' | 'phone'`, like `approval.resolved.via` (additive; absent = desktop, every older event).
4. **Answers by option index, not label.** The phone view masks every string again; a label changed by masking could
   stop matching. The page sends `answers[i] = {choices: number[], other?}` per question; the core maps indexes to the
   labels the inbox shows and calls `question.answer`, so the broker's checks (one choice for single-select, not both a
   choice and a typed answer, ambiguous questions to the terminal) apply unchanged. A question longer than the phone
   view shows (10 questions, 20 options) is not answerable there ("answer in the terminal").
5. **Messages use delivery `auto`** (first chance: the next tool call, or the turn's end), and the page shows where it
   lands (`whereMessageLands`). Typed text from the phone is refused past 1000 characters (`PHONE_TEXT_MAX`, so any
   answer fits the `/api/act` body limit) and clipped to CLIP_LIMITS.message in core. Typed answers are masked in the log by the
   broker as on the desktop; a message is stored as the desktop stores it (clipped, as written: it is the user's own).
6. **Page.** Each session is one card: the main agent's status (glyph and word), the estimated progress, what it is
   doing now (current task, else running tool), and Message / Pause or Resume / Stop; each disabled one says why.
   Subagents are short rows without controls (the server would accept them; kept off the page to stay light, a follow-up
   if wanted). Stop asks once more inside the card; no browser dialogs. Text only (`textContent`), no new dependency.
**Consequences.** Someone holding a device token can now also message, pause, resume and stop (managed runs only), not
just approve; the trusted-network warning, revoke, the 8-hour auto-off and the allowlist are the mitigations, and every
such action is in the log with `via: 'phone'`. Launching, rules, budgets, history and Ask stay desktop only.
