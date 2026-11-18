// Prompts for the scripted recording batch (not published). Every prompt only READS files (the runner also denies write tools)
// and makes the session start `subagents` subagents, so the recordings show varied team shapes.
// group: 'tune' = used to tune progress/usage heuristics, 'judge' = held out to judge them.
const READ_ONLY = 'Only read files; never write, edit or run commands.';
const DOC = 'docs/SPEC.md';

const p = (id, group, shape, subagents, text) => ({ id, group, shape, subagents, text: `${text} ${READ_ONLY}` });

export const PROMPTS = [
  p('seq-list-3', 'tune', 'sequential', 3, 'Start three subagents one after another, waiting for each before the next: first list the files in scripts/, then list the files in fixtures/, then list the files in docs/. Finish with one sentence per folder.'),
  p('par-list-4', 'tune', 'parallel', 4, 'In a single message start four subagents in parallel with run_in_background: each lists the files directly under one of packages/core/src, packages/shared/src, apps/desktop/src and scripts. Wait for all four, then give one line per folder.'),
  p('nested-explore-4', 'tune', 'nested', 4, 'Start one general-purpose subagent. It must start its own Explore subagent to find where HuddleEvent is defined, and a second Explore subagent to find the reducer. Also start one more general-purpose subagent that lists docs/. Report what each found.'),
  p('mixed-sizes-5', 'tune', 'mixed', 5, `Start five subagents in parallel: four tiny ones that each list one folder (scripts, fixtures, docs, packages) and one that reads ${DOC} fully and summarizes it in ten bullets. Report the folder lists and the summary.`),
  p('seq-summarize-3', 'tune', 'sequential', 3, 'Start three subagents one after another, each reading one doc (docs/ROADMAP.md, then docs/ARCHITECTURE.md, then docs/SECURITY.md) and replying with a three-line summary. Combine them into one paragraph.'),
  p('par-summarize-3', 'judge', 'parallel', 3, 'In parallel (run_in_background) start three subagents: one summarizes docs/INTEGRATION.md, one docs/SECURITY.md, one docs/DECISIONS.md, each in five bullets. Wait for all three and list the main theme of each.'),
  p('par-mixed-6', 'judge', 'parallel', 6, `Start six subagents in parallel with run_in_background: five list one folder each (scripts, scripts/lib, fixtures, docs, packages/core) and one reads ${DOC} and summarizes the acceptance criteria of F1 to F5. Wait for all and report.`),
  p('nested-deep-5', 'judge', 'nested', 5, 'Start a general-purpose subagent that starts two Explore subagents of its own: one finds every file mentioning "reduce", the other every file mentioning "normalize". The top-level session also starts two general-purpose subagents that list scripts/ and fixtures/. Report counts only.'),
  p('seq-explore-4', 'judge', 'sequential', 4, 'Using Explore subagents one at a time (wait for each): find the normalizer for SubagentStart, then for SubagentStop, then for PreToolUse, then for Notification. After each, say the file name only.'),
  p('mixed-long-4', 'judge', 'mixed', 4, 'Start four subagents: one reads docs/ARCHITECTURE.md in full and summarizes it in eight bullets, one reads docs/DESIGN.md in full and does the same, and two tiny ones each list the files in one of fixtures/ and scripts/lib/. Report all four results.'),
  p('par-explore-5', 'judge', 'parallel', 5, 'Start five Explore subagents in parallel with run_in_background, each answering one question: where are zod schemas defined, where are selectors defined, where is the broker, where are fixtures replayed, where is the policy engine. Give one line each.'),
  p('nested-chain-3', 'judge', 'nested', 3, 'Start a general-purpose subagent whose job is to start an Explore subagent that lists the files in packages/core/src, then summarize that list by folder. Also start one tiny subagent that lists docs/ and one that lists fixtures/.'),
  p('seq-mixed-5', 'judge', 'sequential', 5, 'One after another, wait for each: a subagent that lists scripts/, one that reads docs/ROADMAP.md and summarizes M1 and M2, one that lists fixtures/, one that reads docs/SECURITY.md and gives five rules, one that lists docs/. Report all five.'),
  p('par-tiny-6', 'judge', 'parallel', 6, 'Start six tiny subagents in parallel with run_in_background, each listing the files in a different folder of this repo (scripts, fixtures, docs, packages, apps, scripts/lib). Reply with the number of files each reported.'),
  p('nested-par-6', 'judge', 'nested', 6, 'Start two general-purpose subagents in parallel (run_in_background). Each must start two Explore subagents of its own: the first searches for "capabilities", the second for "CLIP_LIMITS". Also start two tiny subagents listing scripts/ and docs/. Wait for everything and report one line per search.'),
];
