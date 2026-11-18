# Roadmap

Feature IDs (F1 to F29) are defined in [SPEC.md](SPEC.md). Decisions behind them are in [DECISIONS.md](DECISIONS.md).

## What ships in v0.6

**See**
- A live team tree of every Claude Code session and its subagents, with identity, role, status, current task and a
  progress bar with a labelled time estimate (F1 to F4).
- Tokens, estimated cost, context-window health and the rate-limit meter (F5, F6, F9).
- A handoff inspector (the brief each subagent received and the result it returned) and a per-agent activity timeline
  (F7, F8).
- Self-reported progress through a small MCP tool that agents can call (F27).

**Act**
- Approvals inbox, questions, messages to an agent, pause, resume and stop, on the desktop and from a paired phone
  on the same network (F10 to F13, F26).
- Windows toasts per attention kind, a global hotkey, and a command palette (F14, F15).

**Manage**
- Launch runs with a prompt, folder, model, permission mode and main agent; save them as team templates (F16, F17).
- Auto-approve rules (allow, deny, ask) with every automatic decision logged, token, cost and time budgets, and a git
  worktree per run with a diff summary (F18 to F20).
- Stuck, loop and conflict detectors (F21).
- A skill editor for a project's `.claude/skills/` folder, and the Huddle's own task list (F28, F29).

**Remember**
- Local run history with replay, end-of-run reports as Markdown, and per-role scorecards (F22 to F24).
- "Ask the Huddle": a read-only question box answered over the current state (F25).

## Planned next

None of these is scheduled; each would get a feature ID in SPEC.md first.

- Daily digest: what ran today, what it cost in tokens, what is still open.
- Compare two runs of the same template side by side.
- Cost forecast before launch, from scorecards.
- Quiet hours: toasts held back during a meeting or focus block.
- Prompt and skill inspector: which skills, MCP servers and instruction files each agent loaded.
- Diff review queue: per-agent file changes to approve or revert before they are committed.
- Voice: read out "needs approval" and answer by voice.
- Replay as test: turn a recorded run into a regression test for your own agent setup.
- Idle reaper: suggest stopping sessions that have been idle for hours.
- Model advice: where a smaller model succeeds as often at a fraction of the tokens.
- Export: a run as a shareable, scrubbed HTML page.
- VS Code panel: the widget as a sidebar view inside the editor.

## Known limits

- Windows 10 and 11 only. Builds are unsigned, so SmartScreen warns on first run.
- Claude Code only. Agents from other frameworks are out of scope for now; the adapter boundary allows them later.
- Local to one machine: no cloud sync, no accounts, no multi-user.
- Cost figures are client-side estimates at list prices, not what a subscription costs you.
- Time estimates are estimates; unknown values are shown as unknown, never as 0.
- What you can do to a session depends on how it was started. Sessions the Huddle launched can be messaged and
  stopped at once; sessions it only watches have fewer controls, and unsupported actions are disabled in the UI
  (see the capability matrix in SPEC.md).
- Phone access works on a private network address only and is off by default.
- Claude Code changes quickly. Hook and telemetry details the Huddle relies on are recorded in
  [INTEGRATION.md](INTEGRATION.md); a new Claude Code version can change them.
