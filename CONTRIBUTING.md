# Contributing to Agent Huddle

Agent Huddle is a Windows desktop app and always-on-top widget that shows every Claude Code agent on the machine as a
team (hierarchy, role, task, progress, tokens, context) and lets the user approve, answer, steer and launch them.
Electron + React + TypeScript. Single user, local only.

Read these first:

| When you are about to... | Read |
|---|---|
| build or change a feature | `docs/SPEC.md` (feature IDs F1-F29, acceptance criteria) |
| touch `packages/core` or app structure | `docs/ARCHITECTURE.md` |
| write code that depends on Claude Code hooks, telemetry, CLI flags or the Agent SDK | `docs/INTEGRATION.md` |
| add a listener, IPC channel, stored field, or render agent text | `docs/SECURITY.md` |
| make or question a design choice | `docs/DECISIONS.md` |
| build or style anything in `apps/desktop` | `docs/DESIGN.md` (tokens, layout, status glyphs, words) |

## Commands

Run `npm ci` (or `npm install`) once at the root. Node 24 or newer is required.

- `npm run dev`: start the desktop app (Electron, hot reload). `HUDDLE_DEV_CANNED=1` uses sample data; `HUDDLE_DEV_MAIN=1` also opens the main window; `HUDDLE_DEV_THEME=light|dark`.
- `npm run typecheck`: `tsc --noEmit` in every workspace that has a `typecheck` script.
- `npm test`: Vitest over every `packages/*` and `apps/*` project (`*.test.ts` next to the code). Set `NODE_OPTIONS=--max-old-space-size=6144` for the full run. A few tests hold timing budgets; on a busy machine one may fail and pass on a rerun (CI retries twice). A test that fails every time is a real failure.
- `npm run lint`: ESLint (typescript-eslint strict, type-checked). On a large tree it can need a bigger heap, for example `NODE_OPTIONS=--max-old-space-size=8192`.
- `npm run format` / `npm run format:check`: Prettier (`scripts/`, `fixtures/` and `*.md` are excluded).
- `npm run build:desktop`: production build of the desktop app into `apps/desktop/out`.
- `npm run package:desktop`: build and package the Windows installer (electron-builder, NSIS per user, unsigned) into `apps/desktop/dist`. It does not install anything.
- `npm run icon:app -w @huddle/desktop`: regenerate `apps/desktop/resources/icon.ico`.
- `npm run hooks:preview`: dry run of the hook install; prints what would change in `~/.claude/settings.json`.
- `npm run hooks:install` / `npm run hooks:uninstall`: apply or remove the hooks in the user's `~/.claude/settings.json`. Run these only on purpose, and only on a machine you are happy to change.
- `npm run test:scripts`: tests for the scripts in `scripts/` and the installer (`node --test`, no installs).
- `npm run eval:eta`: replay `fixtures/runs/*.jsonl` and print, per run, how many ETA check points contain the real finish. Run it before and after any change to the `estimateProgress` constants.
- `npm run m3:exit`, `npm run m4:exit`, `npm run m5:exit`, `npm run m6:exit`: exit-check harnesses. Without arguments each one is a dry run that prints its plan and changes nothing. Adding `-- --yes` runs real checks (some start real `claude -p` sessions against a headless Huddle on a private port); do that only on purpose.

Add new scripts to this list when you create them.

## Architecture rules (do not break these)

1. **Everything is an event.** Inputs are normalized into `HuddleEvent`s (`packages/shared/src/events.ts`),
   appended to the log, and state is derived by a pure reducer. No state changes outside reducers.
   Reducers and normalizers take no clock, no randomness, no I/O.
2. **Claude Code knowledge stays in `packages/core/src/ingest` and `normalize`.** Only those folders
   import `@huddle/shared/hooks` or know payload field names. Everything else sees `HuddleEvent`s.
3. **Dependency direction:** `shared` <- `core` <- `desktop`. The renderer imports from `shared` only: types and pure selectors, never `core` (ADR-016).
4. **Capabilities, not origin checks.** UI and commands consult `AgentNode.capabilities`.
5. **Fail open, never strand an agent.** Observation hooks answer in under 20 ms. Every held hook
   response has four endings (user, rule, closed by Claude Code, Huddle shutdown) and all are handled.
6. **Event types are a compatibility surface.** Add new ones; never change the meaning of a field.
7. **Prefer documented Claude Code interfaces**: hooks, OpenTelemetry, `claude` CLI JSON output,
   Agent SDK session readers. Do not parse transcript `.jsonl` files by hand.

## Security rules (non-negotiable)

- Listen on `127.0.0.1` only. Token header required. Reject requests that carry an `Origin` header.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, no remote content.
- Text from agents, hooks or files is rendered as text. No `dangerouslySetInnerHTML`, no `innerHTML`.
- Never store `tool_response` or file contents. Clip free text with `CLIP_LIMITS`.
- No default auto-approve rule may allow deletion, force-push, package installs or network commands.
- Never edit `~/.claude/**` directly. The only path is the installer script, after the user agrees.

## Code conventions

- TypeScript strict, ES modules, relative imports end in `.js` (NodeNext). No `any`; use `unknown` and narrow.
- Validate every external input with a zod schema at the boundary; keep unknown fields; never throw on an unexpected shape.
- Pure functions for normalize, reduce, policy, detect, progress. Side effects live at the edges.
- Windows first: no bash-only scripts, no Docker, build paths with `node:path`, npm scripts must run in PowerShell.
- Tests with Vitest next to the code (`*.test.ts`). Normalizer and reducer changes need a fixture test (`fixtures/`).
- Estimates are labeled as estimates in the UI; unknown is shown as unknown, never as 0.
- Small commits, conventional messages with the feature ID: `feat(core): hold permission requests (F10)`.
- New dependency? Say why, check it is maintained, and prefer none. Avoid native modules (ADR-003).
