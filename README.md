# Agent Huddle

A Windows desktop app and always-on-top widget that shows every Claude Code agent running on your machine as a team:
who is working, on what, for which session, how far along, and how many tokens it has used. When an agent needs you
(a permission request, a question), you answer it from the Huddle instead of hunting for its terminal.

The test it is built against: with five subagents running under one session, you can tell in three seconds which one
needs you, and unblock it without finding its window.

> Status: v0.6, used daily by its author on Windows 11. Unsigned builds. Not affiliated with Anthropic.

## What it does

**See**
- Sessions and their subagents as a tree, with status shown by shape and word, not colour alone.
- Per agent: current activity, a progress bar (tasks done of total, plus a time estimate labelled as an estimate),
  tokens, and context-window use.
- A timeline per agent: prompts, tool calls, failures, approvals, tasks.
- Simple view by default; an Advanced view adds model ids, token breakdowns and every timeline filter.

**Act**
- Allow or deny permission requests; answer an agent's questions (single choice, several choices, or your own words).
- Send a message to an agent, pause, resume or stop it.
- From your phone on the same Wi-Fi, after pairing: the same approvals, answers, messages, pause and stop.

**Manage**
- Launch runs from saved templates, optionally in their own git worktree, with token budgets.
- Auto-approve rules (allow / deny / ask) with every automatic decision logged. No default rule allows deletion,
  force-push, package installs or network commands.
- A task list the Huddle launches as runs, and a skill editor that writes `SKILL.md` files into a project's
  `.claude/skills/` folder.

**Remember**
- Every event is stored locally. Reopen a past run and step through it; get an end-of-run report as Markdown;
  per-role scorecards over time.
- "Ask the Huddle": a question box answered by a small, read-only model call over the current state.

## How it works

Claude Code reports to the Huddle through its documented interfaces: HTTP hooks and OpenTelemetry, pointed at
`127.0.0.1`. The Huddle normalises those into events, appends them to a local log and derives everything you see from
that log. Held hooks (an approval waiting on you) always end: answered by you, by a rule, closed by Claude Code, or
released when the Huddle quits. With the Huddle closed, Claude Code behaves as before.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Install

Requirements: Windows 10 or 11, [Node.js](https://nodejs.org) 24+, [Git for Windows](https://git-scm.com/download/win)
(Claude Code needs it on Windows, and the Huddle uses git for worktrees), Claude Code installed and logged in.

```powershell
git clone https://github.com/inbartam/agent-huddle
cd agent-huddle
npm ci
npm run package:desktop      # builds apps/desktop/dist/Agent Huddle Setup <version>.exe
```

Run the installer (per user, no admin rights). On first start the Huddle shows exactly what it will add to
`%USERPROFILE%\.claude\settings.json` (hook entries and telemetry variables) and asks before writing; it keeps a backup.

### Uninstall

Quit the Huddle from its tray icon first. Then remove what it added to Claude Code's settings **before** you uninstall
it, so Claude Code is left clean:

```powershell
& "$env:LOCALAPPDATA\Programs\Agent Huddle\Agent Huddle.exe" --remove-hooks
```

Then uninstall Agent Huddle from Windows Settings › Apps (its uninstaller offers the same clean-up, but a silent
uninstall skips it). If you only ran it from a clone and never installed it, `npm run hooks:uninstall` in the clone
does the same job. Your event history stays in `%APPDATA%\@huddle\desktop` until you delete that folder.

### Phone access

Off by default. Settings › Phone access turns on a listener on your private network address and shows a pairing
code. Each paired phone gets its own token that you can revoke. Windows Firewall will ask the first time; allow it on
private networks only. See [docs/SECURITY.md](docs/SECURITY.md).

## Develop

```powershell
npm ci
npm run dev                          # Electron with hot reload
$env:HUDDLE_DEV_CANNED=1; npm run dev  # sample data, no Claude Code needed
npm run typecheck
npm test
npm run lint
npm run test:scripts                 # Node tests for the hook installer and helper scripts
```

Layout:

| Path | What |
|---|---|
| `packages/shared` | Types, events, pure selectors (used by the renderer) |
| `packages/core` | Ingest, normalise, reduce, broker for held hooks, rules, budgets, history, phone server |
| `apps/desktop` | Electron main (hosts the core), sandboxed preload, React renderer, phone page |
| `scripts/` | Hook installer, hook forwarder, MCP progress server, exit-check harnesses |
| `fixtures/` | Scrubbed recordings of real Claude Code sessions used by the tests |
| `docs/` | Spec, architecture, decisions, security model, design, roadmap |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture and security rules, code conventions and every dev command.

## Privacy and security

- Everything stays on your machine. No accounts, no analytics, no network calls except to Claude Code on
  `127.0.0.1` and, only if you turn it on, your paired phone on your local network.
- The one exception is "Ask the Huddle", which you start yourself: it sends a masked summary of the current state
  (shown to you under "What will be sent") to Anthropic through your own `claude` login. Nothing is sent otherwise.
- Every listener requires a token. The hook listener on `127.0.0.1` rejects any browser `Origin`; the phone listener
  accepts only its own origin (`http://<ip>:<port>`, the page it serves, ADR-024). The Electron renderer is sandboxed with a
  strict content security policy; agent text is always rendered as text.
- The event log stores prompts, commands and file paths (clipped, with common secret shapes masked), never tool output
  or file contents. It lives in `%APPDATA%\@huddle\desktop`; History settings control how long it is kept.
- Cost figures are client-side estimates at list prices, not what a subscription costs you.

Report a security problem privately: see [SECURITY.md](SECURITY.md).

## Known issues

- An approval card shows a command that spans several lines on one line. Nothing is hidden, but line breaks are not
  marked, so read multi-line commands carefully before allowing them.
- History can list one project folder more than once when its path was reported with different spelling
  (`C:\proj`, `c:\proj`, `C:/proj`).
- With phone access on, the phone's live connection is renewed every 15 minutes, so the "phone connected" indicator
  blinks briefly and the log gets a disconnect and connect pair each time.
- `npm run hooks:uninstall` restores your Claude Code settings to the same content, but not byte for byte: empty
  `hooks` or `env` blocks are dropped, and a byte-order mark or CRLF line endings are not kept. Claude Code reads
  both forms the same way. A backup of the original file is kept next to it.
- Builds use Electron 45.3.2. A newer patch release exists. The app loads only its own local pages, under a strict
  content security policy and sandbox.

## License

[MIT](LICENSE)
