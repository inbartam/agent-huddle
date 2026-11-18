# Agent Huddle — design direction

The owner asked for a modern, sleek UI (2026-11-13). This file is the contract for `apps/desktop`; `ui-engineer` builds from it.
It was written with the `frontend-design` skill. Build passes should also use `ui-ux-pro-max` and `frontend-design`.

## Subject, audience, job
- **Subject:** a team of coding agents at work on one Windows machine.
- **Audience:** one developer, glancing over from an editor or terminal, often while three other things are happening.
- **Primary job:** answer "who is doing what, who is waiting on me, is anything stuck?" in under two seconds.

So this is a Windows instrument, not a web page. It should feel like part of Windows 11, quiet until something needs the user.

## The one bold thing: the tree's rails carry meaning
Spend boldness on the team tree's connector lines.
- **Solid rail:** the parent link is exact (`agent.linked`).
- **Dashed rail:** the link is still a best guess (`heuristic`). It turns solid when the link arrives. That one transition is the
  only animation that runs without the user doing anything.
- **Rail colour:** follows the child's status, so a waiting subagent lights the path up to its root.
- **Width:** 1.5 px rails with 4 px rounded elbows.

Everything else stays quiet and disciplined.

## Colour
Neutral charcoal since Widget v2 (2026-11-14; it was cool graphite, see below), not black. The status colours are the only saturated colours in the UI. Selection uses a soft indigo that no status uses.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#17181B` | `#F3F3F1` | window base (Mica shows through where Windows supports it) |
| `--surface` | `#1E1F23` | `#FFFFFF` | panes |
| `--line` | `#313238` | `#DEDFDC` | dividers, idle rails |
| `--text` | `#ECEDEF` | `#1A1B1E` | primary text |
| `--muted` | `#9FA1A8` | `#5C5F66` | secondary text, done or dimmed agents |
| `--select` | `#6E73E6` @ 18% fill, 100% edge | same | selected row, focus ring |
| `--working` | `#3FB5A3` | `#1F8F7F` | working, starting |
| `--needs-you` | `#E9A23B` | `#B7741A` | waiting for approval or answer |
| `--failed` | `#EC6F64` | `#C4433A` (text `#B5382F`) | failed |
| `--paused` | `#9A9DF0` | `#5A5FCF` (text `#4F54C4`) | paused |
| `--idle` / `--done` | `--muted` | `--muted` | idle, done, stopped |

- **Theme:** follow the system (`prefers-color-scheme`), and let Settings override it.
- **Contrast:** every text and status pair meets WCAG AA on its surface. In light mode, status *labels* use darker text tokens,
  `--needs-you-text` `#8F5A12` and `--working-text` `#17756A`, because `#B7741A` and `#1F8F7F` are under 4.5:1 on white. Glyphs and rails
  keep the base colours, since graphics need only 3:1 (WP10 critique, 2026-11-13).
- **Colour is never alone:** see the glyph table below.

## Status: shape, label and colour together
| Status | Glyph | Label |
|---|---|---|
| starting | ◌ | starting |
| working | ● (a slow 2 s opacity breath, off under reduced motion) | working |
| waiting for approval | ▲ | needs approval |
| waiting for answer | ▲ | needs an answer |
| paused | ‖ | paused |
| idle | ○ | idle |
| done | ✓ | done |
| failed | ✕ | failed |
| stopped | ■ | stopped |

Not a status: `!` is the warning mark for an inbox item that is not a request (looks stuck, may be in a loop, file
conflict, near a budget). It shows in Needs you, the title bar and Home ("! 3 stuck"), always with its words.

## Type
- **UI:** `Segoe UI Variable` (Text optical size for body, Display above 20 px), falling back to `Segoe UI` and `system-ui`.
  - It is Windows 11's own face, so the app reads as native.
  - It needs no bundled or remote font, which the CSP forbids anyway.
- **Code-like content only:** `Cascadia Mono`, falling back to `Consolas`. Use it for tool commands, file paths, ids and model ids.
  Never use it for labels.
- **Scale (px):** 11 (meta), 12 (dense rows), 13 (body, default), 15 (pane titles), 20 (agent name in detail).
- **Weights:** 400 and 600 only.
- **Numbers:** `font-variant-numeric: tabular-nums` for times, counts and tokens.
- **Case and length:** sentence case everywhere; no all-caps labels; no eyebrow labels above headings. Keep line length under 80
  characters in prose areas such as briefs and results.

## Layout
### Main window (min 960 × 600)
```
┌ ▣ Huddle ─────────────────────────────── [search Ctrl+K] ─ – ▢ ✕ ┐  title bar overlay, native caption buttons
│ Team                      │ core-engineer #1                      │
│ ● main  agent-huddle opus │ implements packages/core · sonnet     │  name 20/600, role line muted
│ ┝━● core-engineer #1      │ reports to main                       │
│ ┆  └─ ● Explore #2  haiku │ Now   Timeline                        │  section switch: a text tab row, no cards
│ ┕━▲ ui-engineer  needs…   │ 17:02  Edit   packages/core/…  120 ms │  timeline: 28 px rows, time | tool | summary
│                           │ 17:01  Read   docs/SPEC.md      8 ms  │
│ Finished                  │ …                                     │
│ ✓ Explore #1  done        │                                       │
└───────────────────────────┴───────────────────────────────────────┘
```
- **Tree pane:** 340 px, resizable from 280 to 480 px. Left-aligned throughout.
- **Rows:** 28 px in the tree and timeline.
- **Spacing:** 4 px grid: 8 px gutters inside panes, 16 px pane padding.
- **Detail pane:** fills the rest. Sections sit one after another, separated by spacing and a hairline, never boxed as cards.
- **Corner radius depends on hierarchy** (Widget v2 adds 12 px cards, 8 px inset blocks and pill buttons):
  - 8 px for the window and widget;
  - 6 px for buttons and inputs;
  - 4 px for the selected-row highlight;
  - 0 for rows.
- **Shadows:** only the widget's window shadow, which Windows supplies. (The needs-you outline is a 1.5 px spread with
  no blur, an outline rather than a shadow.)

### Main window shell (main window redesign, 2026-11-16; supersedes the two-pane layout above)
```
┌ ▣ Huddle ───────── [ Search runs, agents, or ask…  Ctrl+K ] ── ● 3 working ▲ 1 needs you ! 0 stuck ─ – ▢ ✕ ┐
│ ⌂    │ Needs you 1                 │ Home                              [ⓘ Explain this screen] [Start a run] │
│ Home │ ▲ core-engineer needs appr… │ Monday 16 Nov · 4 projects · 6 sessions today                         │
│ ◷    │   waiting 2m · proj · title │ ┌ ● 3 Working ┐ ┌ ▲ 1 Need you ┐ ┌ ! 0 Stuck ┐  one-line meaning each  │
│ Hist │   Bash  npm test            │ ┌ Ask the Huddle  read-only · Haiku ┐ ┌ Today ──────────── All ┐   │
│ ▤    │   [Allow] [Deny] Open       │ │ conversation, box, What will be sent│ │ ▲ Run milestone 5      │   │
│ Lib  │ Projects          + New run │ └────────────────────────────────────┘ └────────────────────────┘   │
│ ⚙    │ ▾ agent-huddle      ● 3 ▲ 1 │                                                                       │
│ Set  │   ▲ Run milestone 5  Opus·… │                                                                       │
│      │   ├ ▲ core-engineer         │                                                                       │
│ ?    │ Earlier · 14 ended sessions │                                                                       │
└ rail 56 ┴ sidebar 312 (280–420) ───┴ main ───────────────────────────────────────────────────────────────┘
```
- **Title bar:** brand, Search Ctrl+K (the palette), and the live counts with glyph and word (`selectHomeCounts`). Only
  this copy of the counts is `aria-live`. *Since the glance pass (2026-11-18):* the counts are body size (13 px), the
  loudest words in the chrome; the search box is at most 360 px; the Simple | Advanced switch is not here (Settings ›
  View and the palette keep it).
- **Rail, 56 px:** Home, History, Library (Templates · Rules · Skills · Tasks tabs), Settings; Guide at the bottom (opens the guide
  dialog). The current place has the selection tint and `aria-current="page"`; Up and Down move between items.
- **Sidebar, 312 px (280 to 420, splitter and keyboard):** Needs you only when something waits (Waiting on you, then
  Warnings, then "N older" for ended or stale sessions; compact cards with Allow / Deny / Open, the full card on Open;
  *glance pass:* a warning is one row (glyph, agent, kind, Open), the "Waiting on you" subheading shows only when
  Warnings follow, and the sidebar is one scrolling column so no card is cut);
  Projects (collapsible, `● n` working, `▲ n` needs you) → sessions (glyph, readable title, model · age) → agents on
  rails, where a row shows its status word only when it is not plain "working" (glance pass, below); "Earlier · N ended
  sessions" opens History; "Show all" brings back hidden test and empty runs. At a 960 px
  window the sidebar is 280 px.
- **Home** (the default place): the day as the heading ("Tuesday 17 Nov"), project and session counts, a quiet ⓘ
  (Explain this screen), Start a run as a secondary button; sections on the page, not in cards (glance pass); Today
  first, in the wider column (sessions active today, each opening its session view); then the Ask card (read-only ·
  Haiku pill, "Not saved after you leave", questions and answers stacked as a conversation, What will be sent; while
  Ask is off, only the reason, Turn on in Settings and What would be sent, no question box). *Changed 2026-11-18 (slop
  review):* the three count cards (working, need you, stuck) are gone; they repeated the title-bar counts and pushed
  Today below the fold at 960 × 600. The sketch above still shows them.
- **Session view** (compact head since 2026-11-17, see "Names, Simple view and bars" below): the session's name with
  Rename and, on the same row, Message, Pause or Resume, Stop; one status line (glyph, word, project, model, started,
  agents, what the lead is doing, "started in a terminal" when it was); each off action with its reason in words under
  the row, except a Stop that can never work here (a session started in a terminal), which is not drawn at all; tabs
  Live · Replay, and Report once the run has ended. No breadcrumb and no explanation banner. Live is the picked agent's
  panel alone: the session's tree is the sidebar's and is not drawn twice (glance pass). The message box at the panel's
  foot is one "Message…" row until opened (by it, or by the head's Message, which puts the focus in it); it stays open
  while messages wait. On an open approval or question, "Why it is asking" holds the request itself (the shared inbox
  card with Allow, Deny…, Pass to terminal), then one muted line: "Claude Code asks before running this; no Huddle rule
  answered it.", and Make a rule from this…,
  which opens Library › Rules with the editor filled in (tool, command prefix, folder) and its preview run; nothing is
  saved without Save.
- **Explanations:** "ⓘ Explain this screen" on Home, a note in the flow with a hairline at its left edge (never over
  content; no indigo fill since the glance pass, because indigo means selection). Simple view:
  hidden until asked for. Advanced: shown until the viewer hides it, remembered per viewer in localStorage.
- **Guide:** a four-step dialog (sessions as a tree; the signs; when an agent needs you; looking back and asking),
  shown once per viewer after the consent screen, reopened from the rail's Guide. Esc and Skip close it.

### Widget (340 px wide, height grows with content, max 480)
Superseded by "Widget v2" below (2026-11-14): one card per session instead of one row. Kept for the record.
```
╭ Huddle                     ● 4  ▲ 1 ╮   drag region; click the title to open the main window
│ ● orchestrator  voice-scout   6 agents│
│ ● main  agent-huddle         working  │
│ ▲ core-engineer wants Bash            │   top inbox item pinned (actions arrive in M3)
│   npm install zod                     │
╰───────────────────────────────────────╯
```
- **Material:** Acrylic (`backgroundMaterial: 'acrylic'`) with a translucent `--surface`. Falls back to solid `--surface`.
- **Rows:** one row per session, most recently active first; 30 px rows. A click expands a row in place to that session's tree,
  using the same component and rails as the main window.

## Windows-native chrome
- **Main window:**
  - `titleBarStyle: 'hidden'` with `titleBarOverlay` (native caption buttons, colours from tokens);
  - `backgroundMaterial: 'mica'` on Windows 11.
- **Widget:** frameless, `skipTaskbar`, always on top, rounded, Acrylic.
- **Focus:** a visible 2 px `--select` ring on every interactive element; full keyboard path through the tree (arrow keys) and
  sections.

## Motion
Motion only answers something that happened:
- **A node appears:** its row expands from 0 to 28 px (120 ms).
- **A rail settles:** dashed turns solid (200 ms).
- **Status changes:** the glyph cross-fades (150 ms).
- **Working:** the slow breath on ●.
- **Session faces (owner, 2026-11-18):** each mood moves a little, so the widget reads at a glance. Working: the head
  breathes and the feet step in place. Needs you: two quick hops every 2.4 s, the one face that asks to be looked at.
  Done: a cheer (a hop and a wiggle) every 4.5 s, since one jump at the finish was easy to miss. Failed: one shake. Idle: a slow doze. Open eyes blink about every 5 s. Amplitudes
  stay at 1–4 px, and the phase follows the face colour so a row of faces never moves in unison.

There is nothing else: no hover lifts, no entrance choreography. All of it is off under `prefers-reduced-motion`.

## Words
- **Name things by what the user sees:** "needs approval", not "PermissionRequest"; "reports to", not "parentKey".
- **Unknown shows as `—`**, never 0. Estimates carry `~` and "est.".
- **Empty states give direction:**
  - No sessions: "No agents running. Start Claude Code in any terminal and it shows up here."
  - Hooks not installed: "Huddle isn't connected to Claude Code yet. Review the change it makes to your settings." with a
    `Review changes` button.
- **Errors say what happened and what to do:** "Port 47821 is in use, probably by another Agent Huddle or another program. Close it and restart Huddle."

### Words for interacting (M3)
Reasons on disabled controls come from `CONTROL_REASONS` in `packages/shared/src/selectors.ts`; the words below are the
renderer's own (`apps/desktop/src/renderer/src/view/inbox.ts`, `composer.ts`, `settings.ts`).
- **Inbox:** "Inbox", "Recently handled", empty: "Nothing is waiting on you." Kinds: "needs approval", "asked a question",
  "looks stuck", "may be in a loop", "file conflict". Buttons: "Allow", "Deny…" (then a note field "Tell the agent why
  (optional)" with "Deny" and "Back"), "Pass to terminal" ("Terminal" in the widget), "Answer in terminal", "Dismiss".
  Questions: picking an option only selects it; "Send" (one question, shortcut S) or "Send answers" (several) sends,
  off until a pick with "Pick an answer first." / "Pick an answer for every question first." (Widget v2).
  A request card that just appeared ignores clicks and shortcuts for 600 ms (longer than a double-click), its buttons
  off with "Just arrived. Wait a moment before answering." (`view/arming.ts`, security review 2026-11-14).
  After a press: "Allow: Sent. Waiting for Claude Code…".
  When the summary does not show the whole command (a secret was masked, or it was cut at the summary limit; AX-01),
  every approval card adds one plain text line, no colour of its own: "Part of this command is hidden (masked or too
  long). Check the full command in the agent's terminal before allowing." Allow stays on the desktop; the phone shows
  the same note with Deny only, and its server refuses Allow ("Answer this one on the computer.").
- **Widget cards (Widget v2):** "<n> sessions", "<n> need you", one line: "<n> working", "Collapse to one line" / "Expand", "not connected" / "port in use" / "connection error"; "Open in the main window", "Hide until it
  does something new" (the ×), "<n> session(s) hidden until they do something new" with "Show", "<n> more waiting in
  this session · open the inbox", "Show in the main window" (a card with nothing to open). Progress line: "3/5
  Drafting", "2/3 subagents done · ~2–9 min left, est.", "~40% est."; no basis: the session's folder instead and a
  hatched "unknown" bar, never 0.
- **Time limits are estimates:** "~9:42 left, est.", "time limit reached, est.", "time limit unknown"; questions:
  "terminal in ~1:10, est.", "in the terminal now, est.".
- **How an approval ended:** "Allowed from Huddle." / "Denied from Huddle." (with "With the note: …") / "Allowed by a
  rule." / "Passed to the terminal." / "Time limit reached. Claude Code asked in the terminal." / "Answered elsewhere,
  most likely in the terminal." / "Released when Huddle quit. Claude Code asked in the terminal."
- **How a question ended:** "Huddle answered" plus the answer and "The terminal shows it as if you had typed it." /
  "Handed to the terminal. Answer it there." / "Time limit reached. Answer it in the terminal." / "Answered elsewhere,
  most likely in the terminal." / "Released when Huddle quit. Answer it in the terminal." Unknown: "Handled at 17:02."
- **Pause:** "Pause", "Resume", "Cancel pause" (a pause still waiting), "resumes by itself in 9:42", "pausing at the next
  tool call". How a hold ended: "resumed", "released before the time limit", "ended by Claude Code", "released when Huddle
  quit" ("last pause released before the time limit at 17:04"). "Pause all", "Resume all"; off: "No running agent can be
  paused right now." / "Nothing is paused."
- **Messages:** modes "First chance", "Next tool call", "End of turn"; "Lands after the next tool call or when this turn
  ends." (from `whereMessageLands`), idle: "The agent is idle: it gets this when it next works."; queued list "Waiting to
  be delivered", each "at the next tool call, queued 17:02" with "Cancel"; "Write a message first."
- **Palette:** "Type an action or an agent's name", "Allow the top request", "Deny the top request", "Pass the top request
  to the terminal", "Pause all", "Resume all", "Open settings", "Show the team", "Go to <agent>", "Nothing matches."
- **Settings:** toasts "An agent needs approval", "An agent asked a question", "An agent looks stuck", "An agent may be in
  a loop", "Two agents edited the same file", "An agent finished or failed"; shortcut "Ctrl+Alt+H shows or hides the
  widget." or the failure and "Ctrl+Alt+H still works." / "No shortcut works right now."; number fields "Enter a whole
  number from 1 to 240."

### Words for remembering (M5)
The views are designed in "M5: Remember" at the end of this file; these are their strings.
- **Navigation:** title bar "History", "Ask"; tabs "Runs", "Scorecards" (History) and "Report", "Replay" (a run); "← All
  runs"; palette "Show history", "Show scorecards", "Ask the Huddle…", "Ask the Huddle: “<typed text>”"; agent detail
  "Open the report", "Replay this run".
- **Run outcomes:** "completed", "failed", "stopped", "running", "no end recorded". Origin: "started in a terminal",
  "launched by Huddle". Untitled: "Untitled run".
- **History:** search label "Search runs", placeholder "Search title, folder or prompt"; "<n> runs match"; filters
  "Outcome", "Folder", "All", "Clear filters"; day headers "Today", "Yesterday", "Wed 12 Nov", "3 Nov 2026"; "Show 200
  more"; match line "prompt: …", "folder: …", "title: …". Footer "Runs older than 30 days are deleted. Change this in
  Settings." Empty: "No runs stored yet. Every session that reports to Huddle is kept here for 30 days." No match: "No runs
  match “<query>”." with "Clear search". Loading: "Loading history…". Import: "Bringing in older history from the JSONL
  folder: 1,200 of 3,400 runs." / "3 older files couldn't be brought in. They stay in <path>." Error: "Couldn't read the
  history: <message>. The live team is not affected." with "Try again".
- **Replay:** band "Replay · not live" and "Nothing here can be approved or sent."; "Still running. Showing events up to
  17:40." with "Load newer events" and "Show live"; "The log starts after the session began: Huddle wasn't running before
  17:02."; "event 412 of 1,280"; buttons "First event", "Back one event", "Forward one event", "Last event", "Previous
  attention", "Next attention"; "Jump between" with "Everything that needed you", "Stuck or looping", "Failures",
  "Approvals and questions"; "Follow the event"; "Team at 17:14"; thumb "(+12:04 quiet)"; gap mark "12 min with no
  events"; "Why it needs attention" (heading over the open items),
  "Also needs attention at this point:", "Last tool call", "started 17:02:01, no result by this
  point", "finished in 120 ms", "failed: <error>", "Quiet for 12:04 since this agent's last event", "Waited 1:12 for an
  answer so far"; "Later:" plus "Cleared at 17:20 <why>." (by item kind: stuck "when the agent reported again"; budget "when usage was no
  longer over the budget, or the budget was set again or removed"; loop "when the agent moved on: a different or successful
  tool call, a new prompt, or the end of its turn"; file conflict "when the conflict window passed with no new edit, or
  fewer than two of the agents were still running"; any other kind "Cleared at 17:20 by Huddle.") / "Dismissed at 17:20." /
  "Still open when the log ends." / the approval and question endings above; "Time left isn't shown in a replay."; "Events up to here", "Show earlier", "nearest row to this point" (screen
  readers only). Loading
  "Loading 1,280 events…"; empty "This run has no stored events."; error "Couldn't read this run's events: <message>.";
  deleted "This run was deleted by the history setting."
- **Report:** sections "Summary", "Agents", "Files changed", "Failures", "Approvals"; "Open Markdown file", "Copy path",
  "Copied."; "Show in replay"; "Helper requests (titles, compaction): 2.1k tokens, not counted above"; "at least: some
  agents have no usage record" / "at least: some requests carried no cost"; "no usage recorded"; failure kinds "tool
  failed", "turn failed", "run failed", "interrupted by you"; "No answer recorded."; "Showing 50 of 120 files (Huddle keeps
  the first 50)."; git states "modified", "added", "deleted", "renamed", "untracked"; worktree "kept", "discarded", "still
  there"; empties "No files changed.", "No failures.", "No approvals asked."; "No report yet: the run is still going. Huddle
  writes it when the session ends." with "Replay so far"; "No report for this run yet." with "Make the report"; "Writing
  the report…"; "Couldn't write the report: <message>." with "Try again"; Open off: "The file is gone: it was moved or
  deleted." with "Write it again"; "The log has no end for this session, so its outcome is unknown."
- **Scorecards:** intro "From the runs in your history (the last 30 days). Times are per task: a task from the agent's
  list, or the whole run when it kept none."; columns "Role and model", "Runs", "Tasks", "Time per task", "Tokens per
  task", "Failed runs", "Failed tool calls", "Approvals", "Stuck", "Used for estimates"; "n=10"; "few runs"; "yes",
  "needs 3 runs"; "model unknown"; tooltip "Only 2 finished runs: one long run can set this number alone."; "Compare
  models", "Model A", "Model B", "Close comparison"; differences "<B> takes 2.1 min less per task", "<B> uses 9k fewer
  tokens per task", "8% vs 0%", "Too few finished runs to compare (needs 3 each)."; caveat "These runs did different work.
  A difference is a hint, not a test."; empty "No finished agent runs yet. Scorecards fill in as runs finish."; loading
  "Working out scorecards…".
- **Ask the Huddle:** "Ask the Huddle", "Your question", placeholder "What is everyone doing? Why is ui-engineer slow?",
  "Ask", "Asking…", "Cancel", "Write a question first."; intro "Answers come from Haiku through your Claude Code login. It
  sees only the text it is sent, and has no tools."; off: "Ask the Huddle is off. It sends a summary of your agents to
  Anthropic, so it waits until you turn it on." with "Turn on in Settings"; "What will be sent" / "What would be sent",
  "3.4 KB · ~900 tokens, est.", "as of 17:04:10", "Refresh", "Instructions to the model", "Your question", "Summary of your
  agents", "Cut to 50 KB: the oldest events are left out.", "Secrets are masked and long text is clipped, as best effort:
  a secret in an unusual format can still show. Never file contents or tool output."; answer "Answer", "A model's answer.
  It can be wrong, and it saw only the text that was sent.", "Ask again", "Copy answer", "Show what was sent", "Kept until
  you ask again or leave this view. Never saved to disk."; errors "Huddle couldn't find the `claude` command. Install Claude
  Code, or add it to PATH, then ask again." / "Claude Code isn't logged in. Run `claude` in a terminal, log in, then ask
  again." / "No answer within 30 seconds. Ask again, or ask something shorter." / "Claude Code couldn't answer:
  <message>." / "Stopped: Ask the Huddle was turned off."
- **Settings:** sections "History" (note "Stored on this computer") and "Ask the Huddle" (note "Off by default"); "Keep
  history for" … "days"; "Enter a whole number from 1 to 365."; "1,284 runs · 212 MB · oldest 15 Oct"; lowering:
  "Runs older than 7 days will be deleted (212 runs)." with "Delete them" and "Back"; "Delete all history…", the
  confirmation (text in the Settings section below), "Type delete to confirm", "Type delete first.", "Deleting…",
  "History deleted: 1,284 runs, 212 MB.", "Some history is left: <message>. Try again."; Ask switch "Send a summary of my
  agents to Anthropic when I ask the Huddle a question".

## Checked against generic defaults
- **Dark, near-black with one acid accent:** still rejected. A lime accent was tried for Widget v2 and dropped the same day
  at the owner's request: colour comes only from status, which carries meaning. *Partly superseded:* the base is now
  neutral charcoal rather than cool graphite (the owner picked a reference).
- **SaaS card kit (same radius, grey shadows, gradients):** *superseded for the widget and the inbox* (Widget v2,
  2026-11-14): the owner picked a reference with one card per session, so the widget and inbox items are cards (12 px).
  Still no grey drop shadows and no gradients; the main window's tree, timeline and detail sections stay uncarded.
- **Monospace for small labels:** used only for code-like content.
- **All-caps eyebrows, middle-dot meta strings:** no eyebrows. Middle dots appear only in the role line, where they separate real
  fields.
- **Default web font (Inter or similar):** replaced by the platform's own face, which also suits a no-remote-content CSP.

## Widget v2 (2026-11-14, owner's choice)
The owner picked a sleeker card design from a reference video. The widget is rebuilt around one card per session; the
main window takes the new tokens (neutral charcoal, pill buttons, card radius on inbox cards) and keeps its layout.
Code: `views/WidgetView.tsx`, `components/SessionCard.tsx`, `components/Face.tsx`, `view/cards.ts`, `view/face.ts`,
`view/hidden.ts`, `cardProgress` in `view/meters.ts`.

**No accent colour.** A lime accent was in the first draft and removed the same day at the owner's request. Status
colours carry all colour, as before: the progress bar and the "3/5" lead take the session's status colour (working teal,
needs-you amber, paused indigo; idle and done `--muted`), a card that needs the user gets a 1.5 px `--needs-you` outline
with its need in `--needs-you-text`, and the header dot is `--working` while anything works.

### Tokens (tokens.css)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--widget` | `#17181B` | `#F3F3F1` | widget base (also the window colour in `main/windows.ts`) |
| `--card` | `#222327` | `#FFFFFF` | a session card, an inbox card |
| `--card-edge` | `#2A2B30` | `#E3E3DF` | 1 px card edge |
| `--card-inset` | `#2B2C31` | `#F0F0EC` | the request block inside a card |
| `--primary-fill` / `--primary-ink` | `#ECEEF0` / `#17181B` | `#1A1B1E` / `#FFFFFF` | primary pill (Allow, Send) |
| `--secondary-fill` / `--secondary-ink` | `#36373D` / `#ECEDEF` | `#E0E0DA` / `#1A1B1E` | graphite pills (Deny…, Terminal, Answer in terminal) |
| `--face-0` … `--face-7` | pastel | deeper | face colours, one per session |
| `--face-off` | `#5D5F66` | `#B4B6BB` | stopped or stale face |
| `--radius-widget` 14, `--radius-card` 12, `--radius-inset` 8, `--radius-pill` 999 | | | radii; the window corner itself is drawn by Windows 11 (about 8 px), so `--radius-widget` is defined but not painted: a 14 px window corner needs a transparent window, which loses the system shadow |

The widget now paints a solid `--widget`, so Acrylic no longer shows through it (the reference is solid).

### Card anatomy (340 px)
```
╭─────────────────────────────────────────╮
│ ▣▣  Session name (15/600)   +3   [↗][×] │  name ellipsizes; × only when the card can be hidden
│ ▀▀  ● working · Edit src/a.ts           │  glyph + label in the status colour, activity muted
│     3/5 Drafting               ~$0.58   │  progress lead in the status colour; usage (est.) at right
│     ━━━━━━━━━━━━━━──────────            │  4 px bar, status colour; none without a basis
│  ┌ ~9:28 left, est. ──────────────────┐ │  needs the user: 1.5 px --needs-you outline, and the
│  │ Bash npm test -- parser (mono)     │ │  oldest request inline in an inset block, rendered by the
│  │ (Allow) (Deny…) (Terminal)         │ │  shared InboxCard (same words, shortcuts, reasons)
│  └────────────────────────────────────┘ │
╰─────────────────────────────────────────╯
```
- Padding 10–12 px, 6 px between cards, face 36 × 40 at left.
- Line 2 when the user is needed: "▲ needs approval · <subagent>" in `--needs-you-text`. A subagent's request shows on
  its session's card; further requests say "<n> more waiting in this session · open the inbox".
- Line 3: the progress words (`cardProgress`): tasks basis "3/5" plus the task in progress (`selectCurrentTask`), else the next pending one, with bar = done/total; subagents
  "2/3 subagents · ~2–9 min left, est."; other estimates "~40% est."; no basis or not running: the folder name and no
  bar. Context over the warning line shows as "ctx 86%".
- Click the card: it opens in place to its task list (✓ done, ◐ "in progress" in the working colour, ○ to do) and the shared TeamTree, whose rails hang below
  the face. A card with nothing to open shows the session in the main window instead. ↗ opens the main window at the
  agent that needs the user, else the session.
- × hides the card until the session does something new (`lastActivityAt` moves past the mark) or needs the user;
  in memory only, nothing is sent to Claude Code. A line at the bottom counts hidden cards and offers "Show".
- A request whose agent has no card (not in state) is pinned at the bottom, outlined like a needing card, so none
  becomes unreachable. Requests from a stale session stay in the main window's inbox, as before.
- Header: dot + "Huddle" (opens the main window), "5 sessions" muted, "▲ 3 need you", the collapse chevron and one ↗
  button. Only buttons with behaviour behind them. The connection row and the Limits line stay, compact and muted.
- Collapsed to one line (chevron ⌃/⌄, "Collapse to one line" / "Expand", aria-expanded): dot, "Huddle", "6 working",
  "▲ 3 need you" in needs-you text, ⌄ and ↗; nothing else, except a short state word ("✕ port in use", "▲ not
  connected", "✕ connection error") when not attached. It never expands by itself (toasts alert; the amber count is the
  signal); a click on the counts expands. The choice is the `widgetCollapsed` user setting, saved by the core, so it
  survives a restart; the window shrinks to the 40 px line (`WIDGET_MIN_HEIGHT` in main/widget-bounds.ts is 40).

### Faces (decorative, `aria-hidden`)
A blocky mascot drawn as React SVG elements: a rounded body, two square eyes, a short mouth, two legs. The colour is
`faceHue(sessionId)` (FNV-1a over 8 hues), stable per session. The glyph and label always sit next to it, so neither
colour nor face is ever the only signal.

| Status | Mood | Eyes, mouth |
|---|---|---|
| starting, working | focused | square eyes, flat mouth; the head rises 1 px on the 2 s breath |
| needs approval / an answer | alert | wide eyes with a glint, small open mouth |
| idle | sleepy | closed arcs |
| done | happy | square eyes, small smile |
| failed | failed | × eyes, slight frown |
| paused | flat | flat bars |
| stopped, stale | off | greyed body, dim features |

The breath is the only motion and is off under `prefers-reduced-motion` (the global rule in main.css).

### Contrast (WCAG AA, checked 2026-11-14)
- Dark on `--card` / `--card-inset`: text 13.4 / 11.9, muted 6.1 / 5.4, working 6.2 / 5.5, needs-you 7.3 / 6.4,
  failed 5.3 / 4.7, paused 6.3 / 5.6; primary pill 15.3. Needs-you outline on the widget base 8.2.
- Light on `--card` / `--card-inset`: text 17.2 / 15.1, muted 6.4 / 5.6, working text 5.5 / 4.9, needs-you text
  5.8 / 5.1, failed text 5.9 / 5.2, paused text 6.2 / 5.4; primary pill 17.2. Bars and outlines use the base status
  colours (3:1 is enough for graphics: working 4.0, needs-you 3.8 on white, 3.4 on the widget base).
- Secondary pills: 10.1 (dark), 13.0 (light). Faces are decorative; their features use a dark ink on every hue (4.2:1
  or more).

## M5: Remember (U0, 2026-11-14)
History (F22), Replay (F22), Report (F23), Scorecards (F24), Ask the Huddle (F25) and two Settings sections. They use
the tokens, glyphs, type scale and components above, and add no colour. The strings are in "Words for remembering (M5)".
Suggested code: `components/History.tsx`, `Replay.tsx`, `Report.tsx`, `Scorecards.tsx`, `Ask.tsx`, with pure words and
shapes in `view/history.ts`, `view/replay.ts`, `view/report.ts`, `view/scorecards.ts`, `view/ask.ts`.

Rules for all of them:
- Agent text is rendered as text: names, titles, topics, prompts, results, errors, summaries, paths and the Ask answer.
  Line breaks are kept with `white-space: pre-wrap`. *Changed 2026-11-18:* prose a model writes (the Ask answer, a
  subagent's Result, a hand-off, a task's details) is drawn from its Markdown by `MessageText` (headings, paragraphs,
  lists, **bold**, `code`, code blocks, tables) as React elements with text children only: no link, image or HTML is
  ever built, so `[x](url)` and `<a>` still show as typed. One-line previews drop the marks (`plainLine`). Names,
  titles, paths and commands stay literal. The in-app report
  is built from `RunReport` fields, never by reading the `.md` file back.
- Unknown is `—`. A lower bound (`tokensPartial`, `costPartial`) shows as `≥182k` or "~$0.91 est." with "at least: …" in
  the tooltip and the accessible name. Cost always carries `~` and "est."; time per task is a measured median, so it has
  no `~`.
- These views are read-only. The only commands in them are "Make the report", "Delete all history" and "Ask", and none of
  them goes to an agent.
- No new motion. The scrubber thumb jumps; there is no animated playback.

### Where each view lives
- **Main window only.** The widget gets nothing new; it stays the live glance. There are no new toasts.
- **Title bar:** two more quiet buttons, in this order: Launch…, Templates, Rules, **History**, **Ask**, Settings. Like the
  others, each one swaps the detail pane and toggles back to the team. *Superseded by the main window redesign (WP2,
  2026-11-16):* the title bar holds the brand, Search Ctrl+K and the live counts (● working, ▲ need you, ! stuck); a 56 px
  icon rail holds Home, History, Library (Templates · Rules · Skills · Tasks tabs), Settings and, at the bottom, Guide; Launch is
  "+ New run" in the sidebar and "Start a run" on Home; Ask is in the palette and on Home; the team and the inbox are the
  sidebar's Projects and Needs you. "Back to Home" replaces "Back to the team".
- **History** has a text tab row, "Runs · Scorecards", styled like the agent detail's Now / Timeline row. Opening a run
  shows the run view, with tabs "Report · Replay" and "← All runs".
- **The left pane (live team and inbox) never changes.** Live requests keep their buttons there, and the replayed tree is
  drawn inside the detail pane. I considered two alternatives. Swapping the left pane for the replayed tree puts past and
  live in the same place and hides the live inbox. A separate replay window doubles the chrome and the focus handling.
- **Palette:** "Show history", "Show scorecards", "Ask the Huddle…". When the typed text matches nothing, the palette offers
  "Ask the Huddle: “<text>”". It opens Ask with the question filled in and never sends it; only the Ask button sends.
- **From the live team:** the agent detail of a session's main agent gets two quiet buttons in its head. "Replay this run"
  shows whenever the session has stored events. "Open the report" shows once the session has ended.

### Run outcome
A run's outcome uses the status glyphs. Each outcome gets a shape and a label as well as a colour, like a status.

| Outcome | Glyph | Label | Tone |
|---|---|---|---|
| `completed` | ✓ | completed | `--muted` |
| `failed` | ✕ | failed | `--failed` |
| `stopped` | ■ | stopped | `--muted` |
| `unknown`, session live now | ● (breathes: it is live) | running | `--working` |
| `unknown`, not live | ◇ | no end recorded | `--muted` |

The origin shows as "started in a terminal" (attached) or "launched by Huddle" (managed).

### History (F22)
```
History                                                       Runs   Scorecards
[ Search title, folder or prompt…            ]  Outcome [All ▾]  Folder [All ▾]
Today
✓ completed  Fix parser tests  "fix the failing…"  agent-huddle  17:02  14 min  sonnet  182k  4
● running    Widget polish                          agent-huddle  16:40  running opus   ≥61k  2
Yesterday
✕ failed     Migrate store                          agent-huddle  09:14  1:02 h  opus    1.2M  7
◇ no end r…  Untitled run  "summarize the repo"     voice-scout   08:01  —       haiku   —     1
────────────────────────────────────────────────────────────────────────────────────
Runs older than 30 days are deleted. Change this in Settings.
```
- **Rows:** 28 px, one line, newest start first, under day headers ("Today", "Yesterday", "Wed 12 Nov" within a week, then
  "3 Nov 2026"). Day headers are 12/600 `--muted` and are not focus stops.
- **Columns:**
  - outcome glyph and label, always both;
  - title, which is the session title, else the topic in quotes, else "Untitled run". When there is both a title and a
    topic, the topic follows in `--muted`. This column takes the spare width and ellipsizes, with the full text in the
    tooltip;
  - folder name in Cascadia Mono, with the full path in the tooltip;
  - start time (the day is in the header);
  - duration (`duration()`; "running" while live; `—` when unknown);
  - model (`shortModel`, plus "+1" when subagents used another);
  - tokens: input plus output (`workTokens`), `shortCount`, with `≥` when partial;
  - agents.
- **Narrow windows:** below 720 px of pane width the Agents and Model columns drop, and below 640 px Tokens drops too.
  The title, outcome, start and duration columns always stay.
- **Search:** a text input labelled "Search runs", debounced 250 ms, over the store's full-text index (title, folder, first
  and last prompt).
  - Words are plain words. Quotes and `*` are matched literally, and the core escapes them before they reach FTS.
  - A topic or prompt match adds a `--muted` match line under the title (11 px, to the row's end): "prompt: …the matched
    words…". That row grows to 44 px (28 + 16); every other row stays 28 px. A line after the title on the same row was
    tried, and the title column's ellipsis hid the mark.
  - A title match is marked inside the title cell, and a folder match inside the folder cell when the words are in the
    folder name it shows. A folder match only in the parent path, or a title or folder snippet that does not line up with
    the cell, gets the match line instead ("folder: …", "title: …").
  - The match is marked with `<mark>` (`--select` 18% fill, `--text` ink). The renderer builds the mark by splitting
    the plain text at offsets the core returns. The core never returns markup.
  - The head says "<n> runs match" while there are hits; with none, only the no-match message shows. Esc clears the
    search.
- **Filters** are native selects: Outcome (All, Completed, Failed, Stopped, Running, No end recorded) and Folder (All,
  then folders by most recent run). They combine with the search. "Clear filters" shows while any filter is set.
- **Paging:** the first 200 rows, then "Show 200 more".
- **Keyboard:**
  - Ctrl+F, or `/` when focus is not in a text field, focuses the search. Down moves from the search into the list.
  - In the list, Up and Down move, Home, End, PageUp and PageDown jump, and Enter opens the run.
  - Coming back from a run puts focus on that run's row again.
- **States:**
  - loading: "Loading history…", shown only after 300 ms so it does not flash;
  - migration running: a `--muted` line above the list ("Bringing in older history…"). The list shows what has arrived so
    far: while the last answer says the import is running, the list asks again every 2 s (one question at a time, and once
    more when the window regains focus or the list is shown again) and stops when it is done. The search box, the scroll
    position and the selected run stay as they are;
  - empty, no match and error: see Words.
  - The footer always names the retention.
- **Opening a run:** the run view opens on Report when the run has ended and has a report, otherwise on Replay.

### The run view (shared head)
```
← All runs                                                        Report   Replay
Fix parser tests                                                   (20/600)
C:\code\agent-huddle (mono) · Today 17:02 · 14 min · ✓ completed · launched by Huddle
"fix the failing parser tests"                                     (topic, muted, one line)
```
Alt+Left and "← All runs" go back. The tabs follow the WAI-ARIA tabs pattern: arrow keys move between them and Enter
activates.

### Replay (F22)
```
╭ Replay · not live   Nothing here can be approved or sent.                   ╮  band, --card-inset
│ [|◀] [◀] [▶] [▶|]   [◂ Previous attention] [Next attention ▸]   Jump between [Everything ▾]  │
│ ═══▲══════!═══════⋯═══════●═══════════════▲═════════✕══════════════════  │  range input, markers below
│                  17:14:05 · looks stuck · core-engineer #1  (+12:04 quiet)     event 412 of 1,280 │
├───────────────────────┬────────────────────────────────────────────────────┤
│ Team at 17:14         │ core-engineer #1   ● working · reports to main     │
│ ● main                │ Why it needs attention                             │
│ ┝━● core-engineer #1  │ ! looks stuck  No activity for 12 min               │
│ ┆  └─ ✓ Explore #2    │   Still inside Bash npm test -- parser. Nothing…    │
│ ┕━▲ ui-engineer       │   Last tool call   Bash  npm test -- parser (mono)  │
│                       │                    started 17:02:01, no result by…  │
│ [Follow the event ✓]  │   Quiet for 12:04 since this agent's last event     │
│                       │   Later: Cleared at 17:20 when the agent reported…  │
│                       │ Progress  ━━━━━━━━━━──────  3/5 tasks               │
│                       │   Time left isn't shown in a replay.                │
│                       │ Usage     in 41k · out 6k · ~$0.31 est.             │
│                       │ Context   58% · status line                         │
│                       │ Events up to here          [All][Tools][Failures]…  │
│                       │ ▌17:14:05  looks stuck     No activity for 12 min   │  current row: --select fill
│                       │  17:02:01  Bash            npm test -- parser       │
╰───────────────────────┴────────────────────────────────────────────────────╯
```
- **Marked as not live, three ways:**
  1. A band at the top on `--card-inset`: "Replay · not live" (13/600), then "Nothing here can be approved or sent." in
     `--muted`.
  2. A 1 px `--line` frame with `--radius-inset` around the whole replay.
  3. **Nothing breathes**: ● is static, because the breath means live.

  There are no controls in the frame. There is no Allow, Deny, Pause, Message, Rename or Stop, and no `ControlButton`.
  Request and stuck items show as text only. The live title bar counts stay visible above it.
- **Reused components:**
  - `TeamTree` with a new `mode="replay"`: rows can be expanded and selected, and nothing else. Rails keep their meaning
    at that moment, so a link that was still a guess then is dashed.
  - The `ProgressSection`, `UsageSection` and `ContextSection` meters. Progress drops its ETA and shows "Time left isn't
    shown in a replay." This is because the estimate depends on the clock and on today's scorecards, so it would not be
    what was shown then.
  - `Timeline` rows for "Events up to here".

  `AgentDetail` itself is not reused, because it carries controls.
- **Scrubber:** a native `<input type="range">` from 0 to n−1 with step 1, at full width. The position is an event index,
  not time.
  - Its accessible name is "Replay position". Its `aria-valuetext` is, for example, "Event 412 of 1,280, 17:14:05, looks
    stuck, core-engineer #1".
  - The label under the thumb shows:
    - the clock time with seconds, plus the date when it is not the first day;
    - what the event was, in the timeline's words ("Tool started", "Approval requested", "looks stuck");
    - the agent's name;
    - "(+12:04 quiet)" in `--muted` when the gap since the previous event is a minute or more.
  - "event 412 of 1,280" sits at the right.
- **Markers under the track**, 10 px glyphs. Each marker has a colour and a shape, and clicking it jumps there:
  - ▲ `--needs-you`: an approval or question was asked;
  - ! `--needs-you`: an item was raised for stuck, loop, file conflict or budget;
  - ✕ `--failed`: a tool, turn or run failed.

  Markers closer than 6 px merge into one, which shows the most urgent glyph and a count in the tooltip.
- **Quiet stretches:** the track is by event, so a 12-minute silence would otherwise take no space. A gap longer than the
  stuck threshold (Settings, Warnings) draws a `--muted` "⋯" between the two events, with the title "12 min with no
  events".
- **Stepping:**
  - Left and Right step one event, and Shift+Left and Shift+Right step 10. Home and End jump to the first and last event.
    These keys work while the slider has focus.
  - N and Shift+N go to the next and previous attention point anywhere in the frame, except in a text field.
  - Buttons:
    - |◀ "First event"
    - ◀ "Back one event"
    - ▶ "Forward one event"
    - ▶| "Last event"
    - "◂ Previous attention"
    - "Next attention ▸"

    Glyph-only buttons have that text as their accessible name and tooltip.
  - "Jump between" picks what counts as an attention point:
    - "Everything that needed you" (default): approvals, questions, and every raised item except `finished` and
      `context_high`, plus failures;
    - "Stuck or looping";
    - "Failures";
    - "Approvals and questions".
  - At the last point, Next attention is off with "No more of these after this point."
- **Selection:** "Follow the event" is on by default (a toggle with `aria-pressed`). While it is on, the selected agent is
  the agent of the current event. Picking an agent in the tree turns it off and keeps that agent, and pressing it again
  turns following back on.
- **Where it opens:**
  - from History or "Replay this run": the last event;
  - from "Show in replay" in the report: that event.
- **The moment pane** shows the selected agent at index i:
  1. **Head:** the name (15/600), the status glyph and label as of i, and "reports to".
  2. **"Why it needs attention":** one block per item open at i, meaning raised at or before i and not resolved by i.
     Each block shows:
     - the inbox glyph and kind words ("! looks stuck");
     - the item's title and detail. These are core text, shown as text, so a stuck item already says "No activity for
       12 min" and "Still inside Bash npm test…";
     - "Last tool call": the tool name, then its one-line summary in mono, then its fate as of i ("started 17:02:01, no
       result by this point", "finished in 120 ms", "failed: <error first line>");
     - "Quiet for 12:04 since this agent's last event", measured from the agent's last event before i to the event at i;
     - for a request: the summary in mono and "Waited 1:12 for an answer so far";
     - "Later:" and how it ended, taken from the events after i. The words are the existing approval and question endings
       ("Allowed from Huddle.") or "Cleared at 17:20 <why>." in the item kind's words (Words, above) or "Still open when the
       log ends."

     Only the selected agent's items get blocks. Under them, when other agents have items open at i, one compact line
     reads "Also needs attention at this point:" and names each of those agents with its glyph and kind words ("!
     Map token kinds looks stuck"); a click selects that agent, like a pick in the tree. "Follow the event" and N select
     the item's own agent, so the block N lands on is always shown in full.

     This block is what meets the exit criterion: N lands on the stuck item, the agent is selected, and the block says
     what it was doing, for how long nothing came, and what happened next. With no open item, the block is replaced by a
     single line with the current activity and the last event's age.
  3. **Meters at i** (above).
  4. **"Events up to here":** this agent's timeline rows up to i, newest first, with the timeline's filter buttons. The
     row at i has the `--select` fill. When the event at i is not a row (a tool finished, an item cleared, usage
     recorded), the nearest row before it gets the fill, and its accessible name ends with "nearest row to this point".
     A raised stuck, loop, file conflict or budget item is a row here ("looks stuck" and its detail), as in the sketch,
     though the live timeline leaves it to the inbox. Enter or a click on a row moves the scrubber to it. The list shows 50 rows, then
     "Show earlier".
- **States:**
  - Loading shows "Loading 1,280 events…" with a bar when the count is known.
  - A far jump that takes time shows "…" in the thumb label. The previous moment stays on screen at `--muted` until the
    new one is ready, so nothing flashes empty.
  - A live session is a snapshot: the band adds "Still running. Showing events up to 17:40." with "Load newer events" and
    "Show live". "Show live" selects the agent in the team and closes History.
  - A log that does not start with `session.started` adds "The log starts after the session began: Huddle wasn't running
    before 17:02."
  - Empty, error and deleted: see Words.

### Report (F23)
```
[Open Markdown file] [Copy path]  C:\…\agent-huddle\reports\2026-11-14 fix-parser.md (mono, muted)
Summary
  ✓ completed · 14 min · ended: prompt_input_exit · 4 agents · 7 tasks done
  Tool calls 212 (3 failed) · Approvals 5 · Stuck 1
  Tokens  in 41k · out 6k · cache read 310k · cache written 12k · 88 requests
  Helper requests (titles, compaction): 2.1k tokens, not counted above
  Cost    ~$0.91 est.
Agents
  Name                 Role           Model   Outcome      Time    Tasks  Tools    Approvals  Stuck  Tokens  Cost
  main                 main           opus    ✓ completed  14 min  3/3    80 (1)   2          0      21k     ~$0.40 est.
  ├ core-engineer #1   core-engineer  sonnet  ✓ completed  9 min   4/5    120 (2)  3          1      26k     ~$0.48 est.
  └ Explore #2         Explore        haiku   ✓ completed  1 min   —      12       0          0      —       —
Files changed (12)
  packages/core/src/a.ts (mono)   Edit ×3 · core-engineer #1
  Worktree huddle/run-1a2b · 9 files · +120 −40 · 2 untracked · kept
Failures (3)
  17:04:12  core-engineer #1  tool failed  Bash  exit code 1: 2 tests failed      [Show in replay]
Approvals (5)
  17:03:40  ui-engineer  Bash  npm test (mono)  Allowed by a rule.  default:npm-version  [Show in replay]
```
- **Sections**, separated by spacing and a hairline (no cards), with counts in the headings: Summary, Agents, Files
  changed, Failures, Approvals. Tokens and time are covered by the Summary and the Agents table.
- **Summary:** outcome, duration, end reason (`—` when none), agents, tasks done, tool calls with failures, approvals,
  stuck, the token breakdown and the cost. Helper requests get their own line.
- **Agents table:**
  - 28 px rows in start order, indented by depth with the tree's elbow glyphs (plain characters, not rails). Tasks show
    as "done/created", or `—` when the agent kept no list. Tools show as "calls (failures)".
  - Enter or a click expands a row to show:
    - "Title from its parent";
    - "Result": the subagent's final message, as pre-wrapped text, 12 lines and then "Show all";
    - "Tools used": "Bash 40 (2 failed) · Edit 12 · Read 30".
  - Below 760 px of pane width, Role, Approvals and Stuck move into the expanded row.
- **Files changed:**
  - The path is in mono, relative to the run folder when it is under it, with the full path in the tooltip.
  - A tool source shows the tools with their writes ("Edit ×3") and the agents' names.
  - A worktree source shows the git state words.
  - The worktree line shows the branch, file count, +insertions −deletions, untracked and how it was closed. When
    `listed < filesChanged`, the list ends with "Showing 50 of 120 files (Huddle keeps the first 50)."
  - It never shows contents or a diff.
- **Failures:** time, agent, kind words, tool, and the error's first line, which expands to the clipped text.
  "interrupted by you" shows when it applies.
- **Approvals:**
  - time, agent, tool and the summary in mono;
  - how it ended, in the existing words ("Allowed from Huddle.", "Denied from Huddle.", "Allowed by a rule.", "Passed to
    the terminal.", "Time limit reached. Claude Code asked in the terminal.");
  - the rule id in mono when a rule answered;
  - "No answer recorded." when it is unresolved.
- **Show in replay** opens the Replay tab at that event.
- **Open Markdown file** asks main to open the file the core wrote, by run id. The renderer never sends a path. **Copy
  path** puts the path on the clipboard and shows "Copied." (`role="status"`) for 2 s. When the file is missing, Open is
  off with its reason and "Write it again" shows beside it.
- **No report:**
  - running: "No report yet…" with "Replay so far";
  - ended with no report (before M5, or written while the app was closed): "No report for this run yet." with "Make the
    report". It builds the report from the stored events and writes the file;
  - no end in the log: the report still builds, with the outcome ◇ and "The log has no end for this session, so its
    outcome is unknown.";
  - writing and error states: see Words.

### Scorecards (F24)
```
History                                                       Runs   Scorecards
From the runs in your history (the last 30 days). Times are per task: a task from the agent's list,
or the whole run when it kept none.
Role and model     Runs  Tasks  Time per task     Tokens per task  Failed runs  Failed tool calls  Approvals  Stuck  Used for estimates
core-engineer  2 models                                                                                    [Compare models]
  sonnet           12    41     4.2 min  n=10     18k  n=10        8%           3%                 9          1      yes
  haiku             2     3     2.1 min  n=2      9k   n=2         0%           1%                 0          0      needs 3 runs   few runs
Explore  1 model
  haiku            40    0      1.1 min  n=38     6k   n=38        3%           2%                 0          2      yes
```
- **Layout:** a plain `<table>`. Each role is a `<th scope="rowgroup">` row (13/600, with the model count). Model rows sit
  under it, with the model in mono (`shortModel`; "model unknown" for null). Roles are sorted by runs, and models by runs
  within a role.
- **Values:**
  - Time per task: `medianTaskMs` with `n=sampleSize`.
  - Tokens per task: `tokensPerTask` with `n=tokenSampleSize`.
  - Failed runs: `failureRate`. Failed tool calls: `toolFailureRate`.
  - All are `—` when null. n is always shown, in `--muted`.
- **Small samples:** when n is below `MIN_PRIOR_SAMPLES` (3):
  - the value turns `--muted`;
  - the row gets a "few runs" label as text, not colour alone;
  - the tooltip reads "Only 2 finished runs: one long run can set this number alone.";
  - "Used for estimates" says "needs 3 runs".

  It says "yes" exactly when `priorUnitMsFor` would return that row's median. This is how the user sees which numbers
  feed the ETA.
- **Comparing two models on one role** (exit criterion): a role with two or more models shows "Compare models". It opens
  one inline block under that role and closes any other. The block has:
  - two selects, "Model A" and "Model B", defaulting to the two known models with the most runs. A row whose model is
    unknown is never picked by default (it can still be chosen by hand); with fewer than two known models, A starts on the
    known one (if any), B on "—", and the block says "Too few finished runs to compare (needs 3 each)." until both are chosen;
  - a table with the columns metric | A | B | difference, and rows for time per task, tokens per task, failed runs,
    failed tool calls, approvals per run, stuck per run, runs, and the first and last run;
  - differences in neutral words, never "better" or "worse": "haiku takes 2.1 min less per task", "haiku uses 9k fewer
    tokens per task", "8% vs 0%";
  - when either n is below 3: the values still show, and the difference cell says "Too few finished runs to compare (needs
    3 each).";
  - the caveat line under the table: "These runs did different work. A difference is a hint, not a test."

  Esc or "Close comparison" closes the block, and focus returns to the button.
- **Keyboard:** Tab reaches every Compare button and select. The table has no row selection.
- **States:** loading, empty and error follow History; see Words.

### Ask the Huddle (F25)
```
Ask the Huddle                                                    Back to the team
Answers come from Haiku through your Claude Code login. It sees only the text it is sent, and has no tools.
┌ Your question ───────────────────────────────────────────┐
│ why is ui-engineer slow?                                  │   textarea, 3 lines, 500 characters
└───────────────────────────────────────────────────────────┘
(Ask)  Enter asks · Shift+Enter adds a line
▸ What will be sent   3.4 KB · ~900 tokens, est. · system prompt 1.2 KB · as of 17:04:10   [Refresh]
Answer   claude-haiku-5-5 (mono) · 17:04 · 4.1 s · 3.9k tokens · ~$0.001 est.
A model's answer. It can be wrong, and it saw only the text that was sent.
  ui-engineer has waited 6 minutes for approval of npm test …   (plain text, pre-wrap, max 80 ch)
(Ask again)  [Copy answer]  ▸ Show what was sent
Kept until you ask again or leave this view. Never saved to disk.
```
- **Off (default):** the textarea and Ask are off (`aria-disabled`, with the reason "Ask the Huddle is off…"). "Turn on in
  Settings" opens Settings at the Ask section and never turns anything on by itself. "What would be sent" still opens, so
  the user can read the text before agreeing.
- **Question box:**
  - The label is "Your question", and it holds at most 500 characters. A counter shows from 400.
  - Enter sends, Shift+Enter adds a new line, and Ctrl+Enter also sends. Enter while an IME is composing adds nothing
    and sends nothing. The keys line reads "Enter asks · Shift+Enter adds a line". Focus lands in the box when the pane
    opens.
  - Ask is off with "Write a question first." while the box is empty.
  - Only one ask runs at a time: while it waits, the button reads "Asking…" and Cancel shows.
- **Before asking (`HuddleState.ask`, filled by the core; absent means unknown and the view behaves as without it):**
  - **API key in the environment** (`apiKeySet`): the api_key_set words ("ANTHROPIC_API_KEY is set on this computer, so
    the ask would be billed to that API key…") show up front as `inline-error`, and Ask is off with them as its reason,
    before anything is sent. The box stays readable and can still be typed in, so the preview can be read. The
    disclosure reads "What would be sent".
  - **Another ask is running** (`busy`, for example one started before the view was reopened): "Another question is
    still being answered. Wait for it, or cancel it." with Cancel (`ask.cancel`), and Ask is off with the same reason.
    The ask this view started is not "another": it shows as "Asking…" with its own Cancel. After that ask ends, or after
    this Cancel succeeds, the notice waits for a newer state before it shows again.
  - A refusal that says the same thing as an up-front notice is not shown a second time.
  - **On or off:** `HuddleState.ask.enabled` wins over `settings.ask.enabled` when both are present. It is the value the
    core checks when it refuses `huddle.ask`, read in the same snapshot as `apiKeySet` and `busy`.
- **"What will be sent":**
  - A `<details>`, closed by default. Its summary shows the stdin size and "~ tokens, est.", then, when the core sends a
    system prompt, its own size ("system prompt 1.2 KB") apart from the stdin bytes.
  - When the core sends the system prompt (`AskPreview.systemPrompt`), it comes first, as its own labelled part
    "Instructions to the model (system prompt)", in its own read-only `<pre>` of the same style, as text nodes. The
    stdin's first part is then labelled "Instructions to the model (in the input)", so the two are told apart.
  - Then the exact text the core will put on stdin, in three labelled parts: "Instructions to the model", "Your
    question", "Summary of your agents". The core builds it masked, clipped and capped at about 50 KB. It shows in a
    read-only `<pre>`, Cascadia Mono 12 px, pre-wrapped, at most 320 px tall with its own scroll.
  - Under it: "The system prompt is passed to claude as a command-line setting; the rest is sent as its input. The size
    above counts the input." (only with a system prompt), the masking note, and "Cut to 50 KB…" when the cap was hit.
  - The text is built when the disclosure opens and when Refresh is pressed, and stamped "as of 17:04:10". Ask rebuilds
    it at that moment, and the answer's "Show what was sent" holds exactly what went.
- **Answer:**
  - The meta line shows the model id from the result (mono), the clock time, the wall time, the tokens and the cost. Each
    is `—` when the result lacks it.
  - The label line follows, then the body: plain text, 13 px, pre-wrapped, under 80 characters a line.
  - Nothing in the answer is clickable. Agent names are not linked, a URL is not linked, and no button is built from it.
    So an injected "approve all" in agent text can at most come back as words.
  - "Ask again" (primary, before "Copy answer") sends the question in the box again, exactly like Ask, with the same
    reasons when it is off. The new answer replaces this one.
  - "Copy answer" copies the text.
  - The answer lives in renderer memory only.
- **Errors** show as `inline-error` with `role="alert"`, and the question stays in the box (words: claude not found, not
  logged in, timeout, other, switched off mid-ask). There are no toasts for Ask.

### Settings additions
Two sections, after Rules and before Shortcut.

**History** (note "Stored on this computer"):
- A `NumberRow`: "Keep history for" … "days", from 1 to 365, default 30. Help text: "Runs older than this are deleted
  once a day, with their events and reports. Running sessions and the overall budget are never deleted."
- Lowering the number opens an inline confirmation before saving: "Runs older than 7 days will be deleted (212 runs)."
  with "Delete them" and "Back". The count is `—` when the core cannot tell.
- A stats line ("1,284 runs · 212 MB · oldest 15 Oct"), `—` when unknown.
- **"Delete all history…"** (`control-danger`, like Discard in the run panel) opens an inline group,
  `role="group"`, never `window.confirm`:
  > **Delete all history?** This deletes from this computer: every stored event, every run report and its Markdown file,
  > and the older JSONL history folder (`<path>`, mono).
  > It keeps: settings, templates, rules, agent nicknames, and the overall budget. Sessions running now keep what they have logged so far,
  > so the team view and budgets stay right. If an overall budget is set, its usage will count only what is left.
  > This cannot be undone.
  >
  > Type delete to confirm `[        ]`  (Delete all history) (Back)
- The button stays off with "Type delete first." until the field holds `delete` (trimmed, any case). While it runs it
  reads "Deleting…". The result shows as `role="status"` ("History deleted: …") or as an error. Esc or Back closes the
  group and returns focus to "Delete all history…".

**Ask the Huddle** (note "Off by default"):
- A switch with `role="switch"`: "Send a summary of my agents to Anthropic when I ask the Huddle a question." It is off
  until the user turns it on. Turning it on needs no second confirmation, because the switch and its words are the
  consent. Turning it off is immediate and cancels an ask in flight.
- The help text under it, word for word:
  > When you ask, Huddle runs `claude -p` with Haiku on your Claude Code login and sends it your question and a summary of
  > your agents: names, roles, models, status, current task, recent tool calls as one line each (commands and file
  > paths), tokens and context use. It never sends file contents or tool output. Secrets are masked as best effort. The
  > model has no tools, so it can only answer. Answers are not saved. This is the one Huddle feature that sends anything
  > off this computer; you can read the exact text under "What will be sent" before you ask.

### What these views need from the core (for the plan, not decided here)
Each item below is a read-only `huddle:query` or a new command. Every new channel goes into `IPC` and is validated in
main:
- run list rows: id, title, topic, cwd, start, duration, outcome, live flag, model(s), work tokens with the partial flag,
  agent count. The query takes search text, outcome and folder, and search matches come back as text plus offsets;
- a run's events, and the state at index i. The reducer is in core and the renderer imports only shared (ADR-016), so
  either core answers "state at i" or the reducer moves to shared;
- `RunReport` by run, "make the report", open and copy by run id;
- `Scorecard[]`;
- the Ask preview text, ask and cancel;
- history stats, a count of what a new retention value would delete, and delete-all.

## Names, Simple view and bars (owner review, 2026-11-17)
The owner's screenshot showed "Untitled session" in the sidebar, "main" in the header, "— · started 2d ago",
"reports to you", "not seen since Huddle restarted" twice, a purple banner restating the screen, eight filter chips and
a huge Message box. These rules replace that.

### One naming rule
`selectSessionIdentity` (`packages/shared/src/identity.ts`) names a session the same way in the sidebar, the session
head, the widget card, tree rows, the palette and toasts:
nickname or Claude Code session title → first typed prompt (Claude Code tags stripped) → last typed prompt → the first
subagent's task → "<project folder> session" → "Session <HH:MM>" (its start time). Never the raw "main", never
"Untitled session". Rename (session head) renames the session; the new name shows everywhere at once (the store's
optimistic rename). Inside a session, its main agent is **"Lead agent"** (tree row and panel); a subagent "reports to
Lead agent". Two sessions that read the same and have no topic still get " · 14:02".

### Simple and Advanced view
A per-viewer choice (localStorage `huddle.viewMode`, default **Simple**), switched in Settings › View ("Simple |
Advanced"; the title-bar copy was removed in the glance pass) and in the palette ("Switch to advanced view"). Advanced shows everything as before.
Simple hides implementation detail:

| Where | Simple | Advanced |
|---|---|---|
| Model | "Opus 5.5" (raw id on hover) | `claude-opus-5-5` in the code face |
| Tokens | a bar: this agent's share of the session's tokens, "318k of 412k tokens in this session" | the usage table |
| Context | one bar, "86% full" or "—" | bar, tokens, source, compactions, instruction files |
| Timeline filters | All, Failures, Approvals (only those with rows) | every filter that has rows |
| Timeline rows | commands without their flags, no durations | full command, duration |
| Agent facts | no Folder, no Ended while running, no role description line | everything |
| Sidebar session row | name and age | name, model and age |
| Explanations | hidden until asked for | shown until hidden |
| Library › Skills, Tasks | no intro paragraph | intro paragraph |

Filters that would always be empty are never drawn, in either view. No "hook", "PreToolUse" or "telemetry" in the
words of agent views; the consent screen and the uninstall note still name hooks, because that is exactly what they
change.

### Bars
`Bar` (`components/Meters.tsx`) is the one bar: `role="progressbar"`, `aria-valuenow` when known, `aria-valuetext`
for the words ("2 of 3 subagents done; the bar is an estimate"). Unknown (`null`) draws a hatched empty track with
`aria-valuetext="unknown"` and "—" beside it, never a 0 bar. Colours come from tokens.css through the tone; the
words next to every bar carry the meaning, so colour is never alone. Used for: widget card progress (tasks done/total,
subagents done/started labelled "est.", other estimates "~40% est.", unknown when running with nothing to measure),
progress in the agent panel, context-window use, token share, budgets.

### Clutter
- Session head: one row (name, Rename, actions) and one status line; a stale session says "not seen since Huddle
  restarted (last heard 18:03)" once, in the head.
- The agent panel: "Lead agent" or the subagent's name with Rename, one fact line (role, model, reports to), the status
  line and its Pause on one row (subagents only; the lead's status and Pause are in the head), then Timeline · Details.
- Message box: two rows that grow with the text (`field-sizing: content`, at most about ten lines); the "lands" words
  sit on the same row as Send; the reason when it cannot be sent replaces them.
- Sidebar: Pause all · Resume all in one row at the foot (with "Nothing is running or paused." when both are off);
  "Recently handled" below the projects when nothing waits.
- Every off button says why in words next to it, not only in its tooltip: session actions under the head, inbox cards
  under their buttons ("Allow: …", or one line when all share the reason; "Pick an answer or type one first." under a
  question's Send), Pause in the agent panel, a task's Launch and a read-only skill's Edit in Library.

### Slop review (2026-11-18)
Found with the `ai-slop-detect` skill.
- **Tree rows put the name first.** A role, model or age that does not fit whole drops out of view (the text box is one
  line tall and wraps) instead of being cut to "t…"; the name ellipsizes only when it alone is too long.
- **Numbers carry their unit or a column name:** History has column names over the runs.
- **The code face is for values only:** a rule reads "tool `Bash`, command starts with `git status`", words in the UI face.
- **No spec ids, raw enum values or internal names in the UI:** not "(F18)", not "acceptEdits" in a summary, not "the core".
- **Phone:** each Needs-you item names its session; the "From this phone you can…" note is at the foot, not above the
  first approval.

## Glance pass (2026-11-18, owner-approved plan)
A design pass against the primary job ("who is doing what, who is waiting on me, is anything stuck?" in under two
seconds). Every screen was shot at 960 × 600 and 1440 × 900, light and dark, Simple and Advanced, plus the widget at
340 px and the phone page at 390 px, then critiqued; the owner approved 15 changes, ranked by how much they help the
glance. Each line is the decision and its reason.

**Widget**
- Cards sort by need: waiting on the user, then working or starting, then paused, then the rest, then stale; stable
  inside each group (most recently active first). A third waiting session sat fourth, below the 480 px fold.
- The name takes the width and two lines before it is cut. The open and hide buttons appear on hover or keyboard focus
  (`:focus-within`) over a card-coloured backing, instead of reserving 56 px on every card.
- Plan limit bars use `--muted`, not teal: teal means working.
- Faces stay (owner's choice in Widget v2).

**Title bar and palette**
- The live counts are body size; the search box is at most 360 px; Simple | Advanced moved to Settings and the palette.
  The answer to "who needs me" was 11 px muted text beside a once-a-week setting.
- With a request waiting, the palette starts with "Open the top request" (navigation only), then Allow, Deny, Pass. The
  first entry still only navigates, so Enter right after Ctrl+K can never decide anything; the decide actions also keep
  their `guarded` rule. "Show the team" named a page that no longer exists: it is "Show the selected agent".

**Session view**
- "Why it is asking" holds the request (the shared InboxCard: Allow, Deny…, Pass to terminal); the why is one muted
  line. It was the loudest box on screen and could not answer anything.
- Live does not draw the session's tree a second time; the sidebar's tree is the tree. Replay keeps its own tree,
  because a past moment differs from now.
- The message box is one "Message…" row until opened; it stays open while messages wait. At 960 × 600 the always-open
  box left room for one timeline row.
- A Stop that can never work for the session (`RUN_REASONS.notManaged`: started in a terminal) is not a control: no
  button, no sentence; the status line says "started in a terminal" with the reason as its tooltip. A Stop that is off
  for a passing reason keeps its words under the row. (Same rule as Delete on shipped rules in the slop review.)

**Sidebar**
- *Changed rule (owner-approved):* tree rows show a status word only for states other than plain work. Eight identical
  "working" words drowned the one "needs approval". Working keeps its shape (● with the breath) and colour, and says
  "working" in the row's accessible name and its tooltip ("working: <activity>"). Starting, waiting, paused, idle, done,
  failed, stopped, stale and teammate rows keep their word.
- One scrolling column: Needs you was capped at half the height, so a card was always cut in half. When several things
  wait, Projects moves down a scroll; what waits on the user outranks the tree.
- Warnings are one row each (glyph, agent, kind, Open; place and detail in the tooltip): requests are framed cards,
  warnings are not, so five warnings no longer push Projects off a 1440 × 900 window.
- "Waiting on you" shows only when Warnings follow ("Needs you" already says it). No inset fill inside a compact card:
  the outline is its one frame; the command is set apart by the code face.

**Home and page heads**
- Home's sections sit on the page (no card frame): a heading, a hairline per row, a 40 px gap between the columns.
  DESIGN's Layout already said the main window draws no cards.
- Today's rows start at the edge: the list kept the browser's 40 px indent.
- The heading is the day; the rail already says Home. Start a run is a secondary button (it was the page's heaviest
  element). Explain this screen is a quiet ⓘ, its name kept for screen readers.
- No "Back to Home" on History, Library and Settings (the rail has Home); the panels' `onClose` prop is gone. The h1
  that repeated the rail item or tab is visually hidden (kept for the outline), and a head with nothing visible left has
  no padding, so Settings and Library no longer open on an empty band.
- A rule's allow / ask / deny is glyph and word in `--text`, not a teal, amber or red pill: those colours mean
  working, needs you and failed.

**Words**
- Model names read "Opus 5.5" everywhere (`shortModel`). The report says how a session ended in words ("you exited
  Claude Code", "cleared with /clear", "logged out", "resumed in another session"); an unknown reason shows as given. A
  running run's Took column shows "12 min so far". A long session name takes two lines in the session head.

**Phone (390 px)**
- Session cards start collapsed: status, title, project, then one line: what the session needs ("▲ needs approval ·
  see above", only the words its status does not already say), else its progress and what it is doing. A tap on the
  summary (a real button with `aria-expanded`) opens the controls and subagents; the choice survives live updates.
- A Stop that can never work from the phone is not drawn; one line at the foot of Agents says "Sessions started in a
  terminal can be stopped only from that terminal." (It was the same sentence on every card.)
- No bare "—" progress line and no "Nothing running right now.".
- The pairing heading has its gap above the card.

**After the code review (same day)**
- Sorting cards by need moves them, so a waiting card can slide into the spot the user just clicked. Its inline
  request's arming delay is keyed on the item *and* its slot (`InboxCard` `armKey`): a card that moves is armed again,
  like a new request, and a double-click cannot answer it.
- The head's Message is one-shot: once it has opened the box and focused it, re-picking the lead does not repeat that.
- A working session row says "working" first in its tooltip; on touch screens (`hover: none`) a widget card's open and
  hide buttons stay visible; the same request shown twice (sidebar and session) gets distinct form ids.
- Report, Simple view: the Agents table names models in words ("Haiku"), the code face only in Advanced.
- Checked, no change: a run Huddle launches carries its session id from the first event (`run.launched` with
  `claudeSessionId`, the CLI's `--session-id`), so a launched session never shows "started in a terminal".

**Model text (same day, owner's screenshot of an Ask answer)**
- The Ask answer showed raw Markdown ("**Agent Huddle, milestone 5**", "- " dashes) and cited sessions by raw id. Model
  prose is now drawn by `MessageText`; the ask's instructions allow short Markdown (bold, bullets, code; no headings,
  tables or links) and ask for sessions by name, and each session in the context leads with the name the app shows.
- The same rule now covers a subagent's Result in a report, hand-off texts, and task details (often an Ask answer);
  timeline rows and skill descriptions show one plain line without the marks.
- The answer's model reads "Haiku 5.5" in Simple view (the id in its tooltip); its actions sit 12 px below the answer.

**Owner's second round (same day)**
- Ask: the question leaves the box as soon as it is sent (it shows as "You asked"); a failed ask puts it back.
- Simple tokens count work (input + output), as History does; cache reads (the context read again on every request)
  made a long session read "43.8M". The share bar shows only when other agents share the session: alone it was always
  "100%".
- A timeline row opens in the reader whenever its line is long enough to be cut, not only when it has more lines.
- Empty Progress and Context say why in one line instead of an empty bar and "—"; a subagent's Folder is its session's.
- A session first seen mid-run (no SessionStart) learns its folder from its next prompt (`prompt.submitted.cwd`, an
  optional field), in the tree and in History. Sessions that ended before this have no folder recorded and keep "—".

**Not changed, on purpose**
- Faces, the rails, the charcoal palette, Segoe UI Variable and the glyph set: argued above and still right.
- History, Scorecards and Report tables: already quiet and dense in the right way.
- The `<img onerror>` sample session title: it shows agent text stays text.
- The "← All runs" focus ring seen in screenshots: the run view focuses it on open for keyboard users, and Chromium
  shows `:focus-visible` after a programmatic focus when the last input was not a pointer (the screenshot harness
  clicks without one). To confirm with a real mouse.

## Agent types by role (2026-11-18, owner's choice: guess + override, all three steps)
Claude Code names each subagent by its definition ("code-reviewer", "ui-engineer", "Explore"). Those names are free
text, so the Huddle sorts them into nine types: lead, planner, builder, designer, reviewer, tester, researcher, writer,
general (`packages/shared/src/roles.ts`).

- **How a type is decided:** the user's choice for that role name in Library › Roles wins. Otherwise the type is guessed
  from the role name, and then from its description only when the name says nothing, because descriptions mention
  reviewing or testing in passing. A main agent with subagents or teammates is a lead. Nothing is stored in events, so
  a correction also re-types old history.
  - *Alternatives:* only a user list (exact, but needs upkeep for every new role), or a field in the agent definition
    file (Claude Code does not define one, and the Huddle never edits `~/.claude`).
- **What a type changes**, which is more than a picture:
  - A **reviewer or researcher that starts a file edit** raises one warning in Needs you ("A reviewer is changing
    files"). A mis-briefed agent is caught before the edit lands. It has its own notification switch.
  - **Stuck timing:** the quiet limit is scaled by the type. Reviewers, researchers and planners get 2×, testers 1.5×.
    Reading a large codebase is quiet work.
  - **Estimates:** a role with no history borrows the mean of its type on the same model. `eval:eta` is unchanged on the
    recorded runs, since they only use roles that already have priors.
  - **Finish lines:** a finished row and its toast say "review ready", "findings ready", "plan ready" instead of "done".
- **How it looks:**
  - The type word sits on subagent rows after the name, in `--text` against the muted role. It is not a chip: chips
    were cut in the glance pass.
  - The detail view's role line leads with the type; its tooltip says what the Huddle expects of that type.
  - A session's face wears a hat per type (owner: "make the difference by a hat"): a gold crown for a lead, a
    mortarboard with a gold tassel for a planner, a yellow hard hat for a builder, a red beret for a designer, a top hat
    with a red band for a reviewer, a propeller beanie for a tester, a pith helmet for a researcher and a green knit
    beanie for a writer. General agents go bareheaded. The first try (flat black shapes in the face's ink) read as blobs
    or hair; hats now have their own colours (the same in both themes, since they sit on the face) and a shaded brim or
    band like the legs, small enough to perch on the head. A greyed (stale or stopped) face greys its hat too.
  - The palette finds agents by type ("reviewer").
- **Typed teams (owner: "do all"):** Library › Templates › "Start a typed team" opens the template editor with a lead
  and members named after their types (builder, reviewer, designer…). Each member has instructions written for its type.
  Reviewers, researchers and planners get only Read, Grep and Glob, so they cannot edit even if told to. The lead's
  prompt runs the loop: plan, build, review, send the findings back until the reviewer approves (at most three rounds),
  then report. The agents talk inside Claude Code; the Huddle launches and watches.
- **Team talk** (a session tab once it has more than one agent): every brief the lead gave and every answer that came
  back, as a conversation, each speaker in its type's hat. Briefs and answers are told apart by a muted or a
  working-coloured rule. Long text folds at about six lines.
- **Forward** on an answer opens another agent's message box with "From builder #1 (builder): …" filled in. The user
  edits it and presses Send. The Huddle never sends it by itself, and it never synthesizes a message the user did not
  write. It uses only the Huddle's existing message paths, not the undocumented messaging pipe (S21b).
- **Not done:** default approval rules per type. Teammates' direct messages to each other (agent teams' SendMessage)
  are not shown yet: whether the hooks carry them needs a spike with real `claude` sessions first.
