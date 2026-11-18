/**
 * "Start a typed team" (Library > Templates): a new template draft with a team built by type. The lead is the main
 * agent; each member is an `--agents` entry named after its type ("builder", "reviewer"), so `roleKindOf` types it
 * without an override, with a short system prompt written for that type. Reviewers, researchers and planners get
 * read-only tools. The user picks the folder, writes the task into the lead's prompt and saves through the editor.
 * Pure: no clock, no I/O.
 */
import { ROLE_PROFILES, type RoleKind, type TemplateAgent } from '@huddle/shared';
import { EMPTY_DRAFT, type LaunchDraft } from './launch.js';

/** The types a member can have: the lead is the main agent, and "general" says nothing. */
export type MemberKind = Exclude<RoleKind, 'lead' | 'general'>;

/** In the order the work flows; the picker lists them in this order and drafts keep it. */
export const MEMBER_KINDS: readonly MemberKind[] = [
  'planner',
  'researcher',
  'designer',
  'builder',
  'tester',
  'reviewer',
  'writer',
];

/** Read and search only: these members report, they do not change files. */
export const READ_ONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

const READ_ONLY_KINDS: ReadonlySet<MemberKind> = new Set<MemberKind>(['reviewer', 'researcher', 'planner']);

export interface TeamPreset {
  id: string;
  /** Sentence case, the button's words. */
  label: string;
  kinds: readonly MemberKind[];
}

export const TEAM_PRESETS: readonly TeamPreset[] = [
  { id: 'build-review', label: 'Build and review', kinds: ['builder', 'reviewer'] },
  { id: 'design-build-review', label: 'Design, build, review', kinds: ['designer', 'builder', 'reviewer'] },
  { id: 'research-write', label: 'Research and write', kinds: ['researcher', 'writer'] },
];

const MEMBERS: Readonly<Record<MemberKind, { description: string; prompt: string }>> = {
  planner: {
    description: 'Plans the approach before any change: steps, files to touch, risks.',
    prompt:
      'You are the planner. Read the code that the task touches and write a short numbered plan: the steps, the ' +
      'files each step changes, and the risks. Do not edit files. Keep the plan small enough for one builder to ' +
      'follow.',
  },
  researcher: {
    description: 'Finds the facts a task needs by reading code and docs, and reports them with sources.',
    prompt:
      'You are the researcher. Answer the question you are given by reading code, docs and other files. Do not ' +
      'edit files. Report what you found with the file and line for each fact, and say plainly what you could not ' +
      'find.',
  },
  designer: {
    description: 'Shapes the interface: layout, words and states, before or alongside the build.',
    prompt:
      "You are the designer. Settle how the change looks and reads: layout, labels, empty and error states. Follow the project's existing styles and design notes. Make the interface changes yourself or hand the builder a short, exact description.",
  },
  builder: {
    description: 'Writes and changes code to carry out a plan.',
    prompt:
      'You are the builder. Make the change you are given with the smallest diff that does it, matching the code ' +
      'around it. Run the build and the tests that cover it. When you get review findings, fix each one and say ' +
      'what you changed.',
  },
  tester: {
    description: 'Writes and runs tests for a change and reports what fails.',
    prompt:
      'You are the tester. Write tests for the change you are given, next to the existing tests and in their ' +
      'style. Run them and report what passes and what fails, with the failing output. Do not change the code ' +
      'under test.',
  },
  reviewer: {
    description: 'Reviews a change for bugs and risks and approves it or lists findings.',
    prompt:
      'You are the reviewer. Read the change and the code around it. Do not edit files. List each finding with ' +
      'its file and line, why it matters and what to change, most serious first. If nothing needs to change, ' +
      'answer "Approved".',
  },
  writer: {
    description: 'Writes documentation and other text from what the team found or built.',
    prompt:
      'You are the writer. Write the text you are asked for, from the facts you are given and the files you read. ' +
      'Keep it short and plain, in the voice of the existing docs. Do not invent facts.',
  },
};

/** Known member kinds, once each, in work order. */
export function memberKinds(kinds: readonly string[]): MemberKind[] {
  return MEMBER_KINDS.filter((k) => kinds.includes(k));
}

/** The role name a member of this kind gets; `roleKindOf(name)` gives the kind back. */
export function memberName(kind: MemberKind): string {
  return kind;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The lead's first prompt: who is on the team and the loop (plan, build, review until approved, report). */
export function leadPrompt(kinds: readonly MemberKind[]): string {
  const has = (k: MemberKind) => kinds.includes(k);
  const maker = has('builder') ? 'builder' : has('writer') ? 'writer' : has('designer') ? 'designer' : null;
  const lines: string[] = [];
  lines.push(
    `You lead a team. Your members are ${listWords(kinds.map((k) => `the ${memberName(k)}`))}. ` +
      'Hand each step to a member by name and pass on what the earlier steps produced.',
  );
  lines.push('');
  const steps: string[] = [];
  if (has('researcher')) steps.push('Ask the researcher for the facts the task needs.');
  steps.push(
    has('planner') ? 'Ask the planner for a short plan, and check it against the task.' : 'Make a short plan yourself.',
  );
  if (has('designer') && maker !== 'designer')
    steps.push('Ask the designer to settle the interface before the build starts.');
  steps.push(maker === null ? 'Carry out the plan yourself.' : `Hand the plan to the ${maker} to carry out.`);
  if (has('tester'))
    steps.push(`Ask the tester to test the result, and send failures back to the ${maker ?? 'member who made it'}.`);
  steps.push(
    has('reviewer')
      ? `Ask the reviewer to review the result. Send the reviewer's findings back to the ${maker ?? 'member who made it'} and review again, until the reviewer approves (at most three rounds; after that, report what is still open).`
      : 'Check the result yourself against the task.',
  );
  if (has('writer') && maker !== 'writer') steps.push('Ask the writer to update the docs for what changed.');
  steps.push('At the end, report what was done, what the review found, and anything left open.');
  steps.forEach((s, i) => lines.push(`${String(i + 1)}. ${s}`));
  lines.push('');
  lines.push('The task: describe it here.');
  return lines.join('\n');
}

/** The template fields for a team of these member kinds (unknown kinds and repeats dropped). */
export function typedTeam(kinds: readonly string[]): {
  name: string;
  description: string;
  prompt: string;
  agents: Record<string, TemplateAgent>;
} {
  const members = memberKinds(kinds);
  const labels = members.map((k) => ROLE_PROFILES[k].label.toLowerCase());
  const agents: Record<string, TemplateAgent> = {};
  for (const k of members) {
    agents[memberName(k)] = {
      description: MEMBERS[k].description,
      prompt: MEMBERS[k].prompt,
      ...(READ_ONLY_KINDS.has(k) ? { tools: [...READ_ONLY_TOOLS] } : {}),
    };
  }
  const words = listWords(labels);
  return {
    name: `${words.charAt(0).toUpperCase()}${words.slice(1)} team`,
    description: `A lead with ${listWords(labels.map((l) => `a ${l}`))}.`,
    prompt: leadPrompt(members),
    agents,
  };
}

/** A new template draft holding that team; the folder stays empty for the user to pick. */
export function typedTeamDraft(kinds: readonly string[]): LaunchDraft {
  const team = typedTeam(kinds);
  return {
    ...EMPTY_DRAFT,
    name: team.name,
    description: team.description,
    prompt: team.prompt,
    agents: Object.entries(team.agents).map(([name, a]) => ({
      name,
      description: a.description,
      prompt: a.prompt,
      tools: (a.tools ?? []).join(', '),
      model: '',
    })),
  };
}
