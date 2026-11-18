/**
 * `AgentNode.lastPrompt` (F2 Identity): the latest typed prompt's first line on the main agent, so a session card can
 * say what the session is about. Task notifications, agent messages and tag-wrapped prompts leave it as it was.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { replay } from './reduce.js';

const S = 'session-a';
const MAIN = agentKey(S);

function prompt(
  n: number,
  text: string,
  kind?: 'user' | 'task_notification' | 'agent_message',
  key = MAIN,
): HuddleEvent {
  return {
    id: `e${String(n).padStart(3, '0')}`,
    type: 'prompt.submitted',
    ts: 1000 + n * 10,
    sessionId: S,
    agentKey: key,
    source: 'hook',
    text,
    promptId: null,
    ...(kind !== undefined ? { kind } : {}),
  };
}

describe('lastPrompt', () => {
  it('keeps the first line of the latest typed prompt, collapsed', () => {
    const state = replay([prompt(1, 'first ask'), prompt(2, '\n  fix   the login\tbug \nthen run the tests')]);
    expect(state.agents[MAIN]?.lastPrompt).toBe('fix the login bug');
  });

  it('task notifications, agent messages and tagged prompts do not replace it', () => {
    const state = replay([
      prompt(1, 'add paging to the list'),
      prompt(2, '<task-notification><task-id>a1</task-id>done', 'task_notification'),
      prompt(3, '<agent-message from="agent-2">hi', 'agent_message'),
      prompt(4, 'plain text but sent by an agent', 'agent_message'),
      prompt(5, '<browser_instruction>open the page', 'user'),
    ]);
    expect(state.agents[MAIN]?.lastPrompt).toBe('add paging to the list');
  });

  it('an agent string is kept as text, not interpreted', () => {
    const state = replay([prompt(1, '<b>no</b>'), prompt(2, 'say <img src=x onerror=alert(1)> please')]);
    expect(state.agents[MAIN]?.lastPrompt).toBe('say <img src=x onerror=alert(1)> please');
  });

  it('is clipped to 120 characters', () => {
    const state = replay([prompt(1, 'x'.repeat(500))]);
    expect(state.agents[MAIN]?.lastPrompt?.length).toBe(120);
  });
});

describe('lastPrompt over recorded fixtures', () => {
  it('parallel-subagents: the typed prompt survives the task notifications after it', () => {
    const events = fixtureEvents('parallel-subagents.jsonl');
    const state = replay(events);
    const main = events[0] ? agentKey(events[0].sessionId) : '';
    expect(state.agents[main]?.lastPrompt).toBe('(scrubbed text)');
  });

  it('agent-messages: only tagged prompts, so no topic', () => {
    const events = fixtureEvents('agent-messages.jsonl');
    const state = replay(events);
    const main = events[0] ? agentKey(events[0].sessionId) : '';
    expect(state.agents[main]?.lastPrompt ?? null).toBeNull();
  });

  it.each(listFixtureFiles())('%s: lastPrompt and firstPrompt only on main agents, one line, no tags', (name) => {
    const state = replay(fixtureEvents(name));
    for (const node of Object.values(state.agents)) {
      if (node.kind !== 'main') expect(node).not.toHaveProperty('lastPrompt');
      if (node.kind !== 'main') expect(node).not.toHaveProperty('firstPrompt');
      const first = node.firstPrompt;
      if (first !== undefined && first !== null) {
        expect(first).not.toMatch(
          /^<\/?(?:task-notification|agent-message|browser_instruction|system-reminder|command-)/,
        );
        expect(first).not.toMatch(/\n/);
      }
      const text = node.lastPrompt;
      if (text !== undefined && text !== null) {
        expect(text.startsWith('<')).toBe(false);
        expect(text).not.toMatch(/\n/);
      }
    }
  });
});

describe('firstPrompt', () => {
  it('is the first typed prompt that gives a title, and never moves', () => {
    const state = replay([
      prompt(1, '<command-name>/clear</command-name><command-message>clear</command-message>'),
      prompt(2, '<task-notification>done', 'task_notification'),
      prompt(3, 'fix it from here', 'agent_message'),
      prompt(4, '<pasted_content id="1">a\nb</pasted_content>\n  fix   the login bug\nand the tests'),
      prompt(5, 'now add paging'),
    ]);
    expect(state.agents[MAIN]?.firstPrompt).toBe('fix the login bug');
    expect(state.agents[MAIN]?.lastPrompt).toBe('now add paging');
  });

  it('absent until such a prompt arrives', () => {
    const state = replay([prompt(1, '<system-reminder>x</system-reminder>')]);
    expect(state.agents[MAIN]).not.toHaveProperty('firstPrompt');
  });

  it('parallel-subagents fixture: the typed prompt is the first prompt', () => {
    const events = fixtureEvents('parallel-subagents.jsonl');
    const state = replay(events);
    const main = events[0] ? agentKey(events[0].sessionId) : '';
    expect(state.agents[main]?.firstPrompt).toBe('(scrubbed text)');
  });
});
