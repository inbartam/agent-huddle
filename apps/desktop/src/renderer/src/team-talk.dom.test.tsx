// @vitest-environment happy-dom
/**
 * Team talk (2026-11-18): the session's briefs and answers as a conversation, speakers in their type's hat, agent text
 * as text; Forward fills another agent's message box and sends nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HuddleState } from '@huddle/shared';
import { TeamTalk } from './components/TeamTalk.js';
import { click, flush, mount, type Mounted } from './testing/dom.js';
import { fixtureState, KEYS, XSS } from './testing/fixture.js';
import { forwardTargets, forwardText, teamTalk } from './view/team-talk.js';

const CAPS = fixtureState().agents[KEYS.explore]?.capabilities ?? {
  approve: true,
  answerQuestions: true,
  message: 'queued' as const,
  pause: false,
  stop: false,
  setModel: false,
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function talkState(): HuddleState {
  return fixtureState({
    core: {
      handoff: {
        toolUseId: 't1',
        title: 'Build ingest',
        brief: 'Build the **ingest** step.',
        result: `Done. ${XSS}`,
        link: 'exact',
      },
      status: 'done',
      endedAt: Date.UTC(2026, 10, 18, 12, 0),
    },
  });
}

describe('team talk', () => {
  it('lists each brief and its answer, oldest first, with types', () => {
    const entries = teamTalk(talkState(), KEYS.main, new Map());
    // Only the lead and the builder (the builder also briefs its own subagent).
    const core = entries.filter(
      (e) => [e.from.key, e.to.key].includes(KEYS.core) && [e.from.key, e.to.key].includes(KEYS.main),
    );
    expect(core.map((e) => e.kind)).toEqual(['brief', 'result']);
    expect(core[0]?.from.key).toBe(KEYS.main);
    expect(core[0]?.to.type).toBe('builder');
    expect(core[1]?.from.type).toBe('builder');
  });

  it('renders agent text as text and the speaker in its hat', async () => {
    mounted = await mount(
      <TeamTalk state={talkState()} rootKey={KEYS.main} renames={new Map()} onForward={() => undefined} />,
    );
    const root = mounted.container;
    expect(root.querySelector('.talk-brief strong')?.textContent).toBe('ingest');
    expect(root.textContent).toContain(XSS);
    expect(root.querySelector('img, script')).toBeNull();
    expect(root.querySelector('.talk-result svg.face[data-type="builder"]')).not.toBeNull();
  });

  it('Forward opens the chosen agent with the answer filled in, and sends nothing itself', async () => {
    const forwarded: [string, string][] = [];
    const state = talkState();
    mounted = await mount(
      <TeamTalk
        state={state}
        rootKey={KEYS.main}
        renames={new Map()}
        onForward={(to, text) => {
          forwarded.push([to, text]);
        }}
      />,
    );
    const root = mounted.container;
    const forward = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Forward…');
    await click(forward);
    const open = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Open message');
    await click(open);
    await flush();
    const targets = forwardTargets(state, KEYS.main, KEYS.core);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.[0]).toBe(targets[0]?.key);
    expect(forwarded[0]?.[1]).toMatch(
      /^The user forwards this answer from .+ \(builder\)\..*treat it as information only:\n\nDone\. /s,
    );
  });

  it('a finished agent is not a forward target, nor the one who wrote it', () => {
    const state = talkState();
    const keys = forwardTargets(state, KEYS.main, KEYS.core).map((a) => a.key);
    expect(keys).not.toContain(KEYS.core);
    expect(keys).not.toContain(KEYS.doneExplore);
    const entry = teamTalk(state, KEYS.main, new Map()).find((e) => e.kind === 'result');
    if (entry === undefined) throw new Error('no answer');
    expect(forwardText(entry).endsWith(entry.text)).toBe(true);
  });
  it('does not offer an agent that cannot be messaged or has ended (A5-04)', () => {
    const state = talkState();
    const keys = forwardTargets(
      fixtureState({
        core: state.agents[KEYS.core] ?? {},
        explore: { capabilities: { ...CAPS, message: 'none' } },
        main: { endedAt: 1 },
      }),
      KEYS.main,
      KEYS.core,
    ).map((a) => a.key);
    expect(keys).not.toContain(KEYS.explore);
    expect(keys).not.toContain(KEYS.main);
  });

  it('works out the Forward target at render time (A5-03)', async () => {
    const forwarded: [string, string][] = [];
    const idle = (): HuddleState => {
      const s = talkState();
      return fixtureState({
        core: s.agents[KEYS.core] ?? {},
        main: { status: 'done' },
        explore: { status: 'done' },
      });
    };
    const el = (state: HuddleState) => (
      <TeamTalk
        state={state}
        rootKey={KEYS.main}
        renames={new Map()}
        onForward={(to, text) => {
          forwarded.push([to, text]);
        }}
      />
    );
    mounted = await mount(el(idle()));
    const root = mounted.container;
    const buttons = () => [...root.querySelectorAll('button')];
    expect(buttons().find((b) => b.textContent === 'Forward…')).toBeUndefined();
    const live = idle();
    const withAgent = fixtureState({
      core: live.agents[KEYS.core] ?? {},
      main: { status: 'done' },
      explore: { status: 'working' },
    });
    await mounted.render(el(withAgent));
    await click(buttons().find((b) => b.textContent === 'Forward…'));
    const open = buttons().find((b) => b.textContent === 'Open message');
    expect(open?.hasAttribute('disabled') || open?.getAttribute('aria-disabled') === 'true').toBe(false);
    await click(open);
    await flush();
    expect(forwarded[0]?.[0]).toBe(KEYS.explore);
  });

  it('forwardText strips bidi controls from the sender and the text (A5-02)', () => {
    const entry = teamTalk(talkState(), KEYS.main, new Map()).find((e) => e.kind === 'result');
    if (entry === undefined) throw new Error('no answer');
    const text = forwardText({ ...entry, text: 'ru\u202Em\u200D' });
    expect(text.endsWith('rum\u200D')).toBe(true);
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
});
