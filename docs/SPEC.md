# Agent Huddle — product spec

Platform: Windows first. Stack: Electron + React + TypeScript.
Status: scope agreed in the kickoff interview on 2026-11-13. Build order is in `ROADMAP.md`.

## 1. What it is

A desktop app with a small always-on-top widget that shows every Claude Code agent running on this
machine as a team: who is working, on what, for whom, how far along, at what cost, and who is
waiting for a decision. From the same place you answer them, approve their actions, steer them,
launch new runs and get a report when they finish.

**One sentence test:** with five subagents running under an orchestrator, you can tell in three
seconds which of them needs you, and unblock it without finding its terminal.

### Goals
- G1. See the whole tree: orchestrator, agents, subagents, with name, role, model and status.
- G2. See progress per agent: current task, completed vs remaining, time estimate with a range.
- G3. See spend per agent: tokens, estimated cost, context window use.
- G4. Act from the Huddle: approve, deny, answer, message, pause, stop.
- G5. Manage: launch runs from templates, set budgets and auto-approve rules, isolate work in git worktrees.
- G6. Report: notifications when attention is needed, an end-of-run report, history you can replay.

### Non-goals (for now)
- Agents from other frameworks (LangGraph, CrewAI, OpenAI). The adapter boundary allows it later.
- Cloud sync, accounts, multi-user. Everything is local to one machine.
- Replacing the terminal or VS Code. The Huddle links back to them; it does not render full transcripts as its main view.
- Billing-grade cost figures. Cost is a client-side estimate.

### What already exists, and why build anyway
Claude Code ships an Agent View (`claude agents`) in research preview: a terminal list of background
sessions with state, peek and reply. It does not show subagents as rows, token use, cost, progress
or context, and permission prompts need an attach. Remote Control lets a phone drive one local
session. The Huddle is the cross-session, tree-shaped, metered view with an inbox. Where Claude
Code already does something well, the Huddle uses it instead of rebuilding it (`claude agents --json`,
`claude stop`, Remote Control for single-session phone use).

## 2. Vocabulary

| Term | Meaning |
|---|---|
| Session | One Claude Code conversation. The root of a tree. Its main agent is the orchestrator when it spawns others. |
| Agent | A node in the tree: the main agent of a session, a subagent, or (later) an agent-team teammate. |
| Role | The agent type: `main`, `Explore`, `core-engineer`... plus the description from its definition file. |
| Handoff | The brief a parent gives a subagent, and the result that comes back. |
| Attached | A session you started yourself (terminal, VS Code). The Huddle listens through hooks. |
| Managed | A session the Huddle launched and whose input stream it owns. |
| Inbox | Everything that needs you: approvals, questions, stuck agents, conflicts, budget alerts. |
| Run | A managed session started from a team template, with its budgets, rules and worktree. |

## 3. Surfaces

### 3.1 Widget (always on top, about 340 px wide)
```
┌ Huddle ──────────────── ● 4 working   ▲ 1 needs you ┐
│ ▸ orchestrator · voice-scout   ▓▓▓▓▓░░░ 62%   ~14 min │
│     5 agents · 182k tok · ctx 41%                      │
│ ▸ main · agent-huddle          ▓▓░░░░░░ 20%   ~40 min │
│ ▲ core-engineer wants  Bash  npm install zod   [✓] [✗] │
└────────────────────────────────────────────────────────┘
```
- One row per session, most recently active first. A row expands in place to its agents.
- The top inbox item is always visible with one-click approve and deny.
- Global hotkey shows or hides it. Position and size are remembered. Click the title to open the full window.
- Frameless, stays out of the taskbar, lives in the tray.

### 3.2 Main window
```
┌ Team tree ─────────────────────────┬ Agent detail ──────────────────────────────────┐
│ ● orchestrator  voice-scout  sonnet │ core-engineer #1   "Build hook ingest"          │
│ ├─ ✓ Explore #1   haiku   done      │ role: implements packages/core  · model sonnet  │
│ ├─ ● core-engineer #1  ▓▓▓░ 3/5     │ reports to: orchestrator                        │
│ │   └─ ● Explore #2  haiku          │ ── Now ───────────────────────────────────────  │
│ ├─ ▲ ui-engineer #1  waiting        │ task 3/5 "normalize SubagentStop"  ~6–12 min    │
│ └─ ◌ test-engineer #1  queued       │ ── Tasks ─  ✓ ✓ ● ○ ○                           │
│                                     │ ── Usage ─  in 41k · out 6k · cache 310k · ~$0.9│
│ ● main  agent-huddle  opus          │ ── Context ─ ▓▓▓▓░░ 58% · 1 compaction          │
├ Inbox (2) ─────────────────────────┤ ── Handoff ─ brief ▸  result ▸                   │
│ ▲ approval  ui-engineer  Bash …    │ ── Timeline ─ 17:02 Edit ingest.ts …             │
│ ⚠ conflict  2 agents  src/model.ts │ [Message…]  [Pause] [Stop] [Model ▾] [Open in VS]│
└─────────────────────────────────────┴─────────────────────────────────────────────────┘
```
- Left: tree of every live session, plus recently finished ones. Under it, the inbox.
- Right: detail of the selected agent, with tabs or sections for Now, Tasks, Usage, Context, Handoff, Timeline.
- Controls are enabled from the agent's capability flags, so nothing is offered that cannot work (see 5).
- Other views: History (past runs, replay), Scorecards, Templates, Rules and budgets, Settings.

### 3.3 Command palette (Ctrl+K inside the app)
Jump to agent, approve all that match the rules, pause all, resume all, stop all, launch template, ask the Huddle.

### 3.4 Phone (milestone M6)
A small web page served on the local network after pairing. Off by default (ADR-024). Since ADR-030 it is mobile first: each live session is a compact card with its main agent's status (glyph and word), the estimated progress (labeled as an estimate), what it is doing now, and the controls its capabilities allow (Message at first chance, Pause or Resume, Stop for runs the Huddle launched, with a second confirm inside the card); a disabled control says why in words. Subagents are short rows. The inbox lists approvals (Allow, Deny), held questions answered in place (single choice, several choices, typed answer) and the other items read-only. The phone cannot launch, change rules or budgets, open history or use Ask.

## 4. Features and acceptance criteria

Each feature has an ID used in `ROADMAP.md`, commits and tests.

**Visibility**
- **F1 Team tree.** Sessions and their subagents render as a tree within 1 s of the first event. Nested subagents sit under the agent that spawned them. A finished agent stays visible, dimmed, until its session ends.
- **F2 Identity.** Every node shows a name (nickname, else session title or handoff title, else role plus ordinal), a role with its one-line description, and its model. Renaming persists.
- **F3 Status.** One of: starting, working, waiting for approval, waiting for an answer, paused, idle, done, failed, stopped. Status is correct within 1 s of the event that changes it.
- **F4 Current task and progress.** Current activity (task subject, else running tool), a bar of completed vs total tasks, and a time estimate shown as a range with a confidence label. When the task list grows, the bar may move back and a "scope grew" marker shows. No estimate is shown when there is no basis for one.
- **F5 Tokens and cost.** Per agent and rolled up per session: input, output, cache read, cache creation, request count, estimated cost labeled as an estimate. Subagent usage rolls up to its ancestors. One API request is counted once.
- **F6 Context health.** Context use as a percentage where it can be measured, with its source; compaction count; warning at a configurable threshold (default 80%); list of instruction files loaded.
- **F7 Handoff inspector.** For each subagent: the brief it received and the result it returned, each expandable, with a marker when the link between them is a best guess.
- **F8 Activity timeline.** Per agent, ordered: prompts, tool calls with a one-line summary and duration, failures, approvals, tasks, compactions. Filter by kind. File contents are never shown from the log.
- **F9 Rate-limit meter.** For subscription use: 5-hour and 7-day window use when Claude Code reports them.

**Interaction**
- **F10 Approvals inbox.** A permission request appears in the inbox and the widget within 1 s, with tool, summary and agent. Allow or Deny returns the decision to Claude Code. If the Huddle is closed or does not answer, Claude Code's own prompt still works. A request answered elsewhere disappears from the inbox.
- **F11 Questions.** Multiple-choice questions from an agent are shown with their options and free text. Where the session type cannot be answered from the Huddle, the card says so and links to the terminal.
- **F12 Message an agent.** Managed: delivered at once. Attached: queued, with the UI stating when it will land (next tool call as a note, or end of turn as a follow-up).
- **F13 Pause, resume, stop.** Pause holds the agent at its next tool call. Stop ends a managed session or a background session. Pause all and stop all exist. Unsupported actions are disabled with a reason.
- **F14 Notifications.** Windows toasts for: needs approval, asked a question, stuck, conflict, budget, finished, failed. Each kind can be turned off. Clicking a toast focuses the item.
- **F15 Hotkeys and palette.** One global shortcut toggles the widget. The palette covers the actions in 3.3.

**Management**
- **F16 Launch runs.** Start a session from the Huddle with prompt, folder, model, permission mode and optional main agent. Uses the installed `claude` CLI and its existing login.
- **F17 Team templates.** Save and reuse a launch setup: prompt, folder, main agent, model, budgets, rules, worktree on or off.
- **F18 Auto-approve rules.** Rules by tool, command prefix, path glob, role and folder, with actions allow, deny, ask me. Deny beats ask beats allow. Every automatic decision is logged with the rule that made it. Ships with a conservative default set and no rule that allows deletion, force-push or network installs.
- **F19 Budgets.** Token, estimated-cost and time caps per agent, session or overall, with a warning threshold and an action: notify, pause or stop.
- **F20 Git safety net.** A run can get its own git worktree. The Huddle shows its diff summary and offers open in VS Code, keep, or discard.
- **F21 Detectors.** Stuck: no event for longer than a threshold while working and not inside a long-running tool. Loop: the same tool call repeated N times, or M failures in a row. File conflict: two agents edited the same file in the same checkout within a window. Each raises one inbox item, not a stream of them.

**Reporting**
- **F22 Run history and replay.** Every event is stored locally. A past run can be reopened and stepped through; the tree and meters show the state at that moment.
- **F23 End-of-run report.** When a session ends: what each agent did, tasks, files changed, failures, approvals, tokens, time. Saved as Markdown and viewable in the app.
- **F24 Scorecards.** Per role and model over time: tasks completed, median time per task, tokens per task, failure rate, approvals requested, stuck incidents.
- **F25 Ask the Huddle.** A question box ("what is everyone doing?", "why is ui-engineer slow?") answered by a small, read-only model call over the current state and recent events. Since the main window redesign it is a card on Home: questions and answers stack as a conversation kept only while Home is open, and a follow-up carries up to three earlier turns (clipped and masked again), which What will be sent shows.
- **F26 Phone access.** See 3.4. Acceptance: off by default; pairing with a one-time code; a held approval shows on the phone within 2 s and Allow or Deny answers it; a held question is answered from the phone with the same rules as the desktop; a message, pause, resume or stop from the phone takes the desktop's path and is logged `via: 'phone'`; every other command is refused by the listener (ADR-030).
- **F27 Self-reported progress.** A small MCP tool agents can call with percent, minutes left and a note; feeds the hybrid estimate in F4.

**Orchestration** (owner request 2026-11-17: "Huddle should be the orchestrator and create skills and tasks too"; ADR-028, ADR-029)
- **F28 Skills.** Library › Skills lists the Claude Code skills of every known project (`<project>/.claude/skills/*/SKILL.md`; known = a folder a session in the state ran in, a saved template's folder, or a task's folder; never a drive, home folder or Documents) and the user's own skills (`<Claude config>/skills`), each with the name and description from its frontmatter, shown as text. The user's skills are read-only. New skill (name `^[a-z0-9][a-z0-9-]{0,63}$`, a one-line description of at most 1024 characters, instructions) writes `<project>/.claude/skills/<name>/SKILL.md` into a project picked from the known list, never a typed path. Edit changes an existing project skill. Acceptance: a name with a separator, `..` or a capital is refused in the UI and in core; nothing is written through a link or junction, inside Claude Code's config folder or under `<home>/.claude`; an existing file is replaced only after the user presses "Replace it"; the written file parses back to the same name, description and instructions. Ask answers have "Create skill from this", which opens the form with the answer as the instructions (nothing is saved until Save).
- **F29 Tasks.** Library › Tasks keeps the Huddle's own task list: title, details, a known project folder and/or a saved template, status (to do, running, done, failed) and the run it launched. Every change is a `huddle_task.*` event (created, updated, deleted) on the Huddle's own `huddle-tasks` session, reduced by the pure reducer, replayed at start, never listed as a run, kept by the retention and by "delete all history". Launch uses the normal launch path: the template with the task text as the prompt (in the task's folder when it has one), or a plain run in the folder (default permission mode, no worktree); it is off with the reason while hooks are not attached, while the task runs, or when its template or folder is gone. Acceptance: status follows the linked run (running while its process lives, done when it completed, failed when it failed, never started or was stopped), and the outcome is written back to the task when the run exits so it survives a restart; Ask answers have "Make a task from this", which opens the form with the question as the title and the answer as the details. The widget and the phone show nothing new.

## 5. Capability matrix

What each action can do depends on how the session was started. The UI must reflect this table.

| | Attached (terminal, VS Code) | Managed (launched by the Huddle) |
|---|---|---|
| Tree, status, tools, tasks | yes, hooks | yes, hooks and stream |
| Tokens and model per agent | yes, telemetry | yes |
| Context % | main agent with the status line bridge, otherwise an estimate from telemetry | yes |
| Approve / deny | yes, held PermissionRequest hook | yes, same mechanism |
| Answer multiple-choice questions | yes, held PreToolUse(AskUserQuestion) answered with `updatedInput.answers` (spike S5, interactive; single-select, multiSelect and typed "Other" answers; S5, S14 b) | not applicable: headless sessions have no AskUserQuestion tool (S5); their questions arrive as text and are answered with a message |
| Message | queued: note at next tool call, or follow-up at end of turn | live |
| Pause | yes, hold at next tool call | yes |
| Stop | background sessions only | yes |
| Switch model | no | between turns |

## 6. Rules the product must keep
1. **Never make agents less safe than without the Huddle.** If the Huddle is closed, slow or crashed, sessions behave as if it was never installed.
2. **Local only.** Listens on 127.0.0.1. Nothing leaves the machine, except through two explicit opt-ins: phone access, and Ask the Huddle (F25), which sends a masked state summary to Anthropic through the Claude Code login (ADR-022).
3. **Honest numbers.** Estimates are labeled. Unknown is shown as unknown, not as zero.
4. **Private by default.** Logs hold summaries, not file contents. Retention is configurable.
5. **Reversible setup.** Installing and removing the hooks is one click each, with a backup.
