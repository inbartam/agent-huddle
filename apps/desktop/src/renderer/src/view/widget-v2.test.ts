/**
 * Widget v2 (owner's choice 2026-11-14), pure parts: the face's mood per status and its stable colour per session,
 * hiding a card until its session does something new, the card's progress words, and which card a request lands on.
 */
import { describe, expect, it } from 'vitest';
import {
  agentKey,
  selectTree,
  type AgentStatus,
  type ProgressView,
  type SessionView,
  type TaskItem,
} from '@huddle/shared';
import { fixtureState, KEYS, T0 } from '../testing/fixture.js';
import { approvalItem, IK, interactState, questionItem, STUCK } from '../testing/interact-fixture.js';
import { orderCards, widgetCards } from './cards.js';
import { FACE_HUES, faceHue, faceMood } from './face.js';
import { hide, isHidden, pruneMarks } from './hidden.js';
import { cardProgress } from './meters.js';

describe('face mood', () => {
  it('follows the status', () => {
    const expected: Record<AgentStatus, string> = {
      starting: 'focused',
      working: 'focused',
      waiting_approval: 'alert',
      waiting_answer: 'alert',
      idle: 'sleepy',
      done: 'happy',
      failed: 'failed',
      paused: 'flat',
      stopped: 'off',
    };
    for (const [status, mood] of Object.entries(expected)) expect(faceMood(status)).toBe(mood);
  });

  it('is alert when the session needs the user, greyed when stale, calm for an unknown status', () => {
    expect(faceMood('working', { needsYou: true })).toBe('alert');
    expect(faceMood('working', { stale: true })).toBe('off');
    expect(faceMood('waiting_approval', { stale: true, needsYou: true })).toBe('alert');
    expect(faceMood('some_new_status')).toBe('flat');
  });
});

describe('face colour', () => {
  it('is stable per session id and within the palette', () => {
    const ids = ['canned-session-0001', 'canned-session-0002', '0b6f…', '', 'fixture-session'];
    for (const id of ids) {
      expect(faceHue(id)).toBe(faceHue(id));
      expect(faceHue(id)).toBeGreaterThanOrEqual(0);
      expect(faceHue(id)).toBeLessThan(FACE_HUES);
    }
  });

  it('spreads ids over several colours', () => {
    const hues = new Set(Array.from({ length: 40 }, (_, i) => faceHue(`session-${String(i)}`)));
    expect(hues.size).toBeGreaterThanOrEqual(6);
  });
});

function session(): SessionView {
  const [s] = selectTree(fixtureState());
  if (!s) throw new Error('fixture');
  return s;
}

describe('hide until it does something new', () => {
  it('hides a session until its activity moves past the mark', () => {
    const s = session();
    const marks = hide(new Map(), s);
    expect(isHidden(s, marks, false)).toBe(true);
    expect(isHidden({ ...s, lastActivityAt: s.lastActivityAt + 1 }, marks, false)).toBe(false);
    expect(isHidden(s, new Map(), false)).toBe(false);
  });

  it('never hides a card that needs the user', () => {
    const s = session();
    expect(isHidden(s, hide(new Map(), s), true)).toBe(false);
  });

  it('drops marks that no longer hide anything, and keeps the same map when nothing changed', () => {
    const s = session();
    const marks = hide(new Map(), s);
    expect(pruneMarks(marks, [s], () => false)).toBe(marks);
    expect(pruneMarks(marks, [{ ...s, lastActivityAt: s.lastActivityAt + 5 }], () => false).size).toBe(0);
    expect(pruneMarks(marks, [], () => false).size).toBe(0);
  });
});

const VIEW: ProgressView = {
  fraction: 0.6,
  completedTasks: 3,
  totalTasks: 5,
  etaMs: 240_000,
  etaLowMs: 120_000,
  etaHighMs: 540_000,
  basis: 'tasks',
  confidence: 'medium',
  finishedSubagents: 0,
  startedSubagents: 0,
};
const TASKS = [
  { id: '1', subject: 'Outline', status: 'completed' as const, createdAt: T0 },
  { id: '2', subject: 'Facts', status: 'completed' as const, createdAt: T0 },
  { id: '3', subject: 'Shots', status: 'completed' as const, createdAt: T0 },
  { id: '4', subject: 'Drafting', status: 'pending' as const, createdAt: T0 },
  { id: '5', subject: 'Proofread', status: 'pending' as const, createdAt: T0 },
];

describe('card progress words', () => {
  it('tasks: "3/5" then the next task, the bar is done/total', () => {
    const p = cardProgress(VIEW, { status: 'working', tasks: TASKS });
    expect(p).toMatchObject({ lead: '3/5', text: 'Drafting', fraction: 0.6 });
    expect(p?.title).toContain('3 of 5 tasks done');
  });

  it('tasks: the task in progress wins over the next pending one', () => {
    const proofread: TaskItem = {
      id: '5',
      subject: 'Proofread',
      status: 'pending',
      createdAt: T0,
      startedAt: T0 + 5_000,
    };
    const p = cardProgress(VIEW, { status: 'working', tasks: TASKS }, proofread);
    expect(p).toMatchObject({ lead: '3/5', text: 'Proofread' });
    expect(p?.title).toContain('in progress: Proofread');
    // No task known to have started: the next pending one, as before.
    const next = cardProgress(VIEW, { status: 'working', tasks: TASKS }, null);
    expect(next).toMatchObject({ text: 'Drafting' });
    expect(next?.title).toContain('next: Drafting');
  });

  it('subagents: counts plus a time range marked as an estimate', () => {
    const p = cardProgress(
      { ...VIEW, basis: 'subagents', fraction: 0.5, finishedSubagents: 2, startedSubagents: 3 },
      { status: 'working', tasks: [] },
    );
    expect(p).toMatchObject({ lead: '2/3', text: 'subagents done · ~2–9 min left, est.', fraction: 0.5 });
  });

  it('self report: a percent marked as an estimate', () => {
    const p = cardProgress({ ...VIEW, basis: 'self_report', etaLowMs: null }, { status: 'working', tasks: [] });
    expect(p).toMatchObject({ lead: null, text: '~60% est.' });
  });

  it('no basis: nothing, never 0', () => {
    expect(cardProgress({ ...VIEW, basis: 'none', fraction: null }, { status: 'working', tasks: [] })).toBeNull();
    expect(cardProgress(null, { status: 'working', tasks: [] })).toBeNull();
  });
});

describe('which card a request lands on', () => {
  it("puts a subagent's request on its session's card, the oldest first, and counts the rest", () => {
    const state = interactState();
    const { cards, orphans } = widgetCards(state, selectTree(state));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.need).toMatchObject({ agentKey: IK.tester, words: 'needs approval' });
    expect(cards[0]?.need?.item?.id).toBe('approval:req-1');
    // Two questions wait too; the stuck warning is not a request.
    expect(cards[0]?.moreNeeds).toBe(2);
    expect(orphans).toEqual([]);
  });

  it('pins a request whose agent has no card', () => {
    const lost = approvalItem({ id: 'approval:lost', agentKey: agentKey('gone-session') });
    const state = interactState({ inbox: [lost, STUCK] });
    const { cards, orphans } = widgetCards(state, selectTree(state));
    expect(orphans.map((i) => i.id)).toEqual(['approval:lost']);
    // The session's agents still wait, so the card says so (no inline request to show).
    expect(cards[0]?.need).toMatchObject({ item: null, words: 'needs an answer' });
  });

  it('a session with nothing waiting has no need', () => {
    const state = fixtureState({ explore: { status: 'working' } });
    const { cards } = widgetCards(state, selectTree(state));
    expect(cards[0]?.need).toBeNull();
    expect(cards[0]?.root?.key).toBe(KEYS.main);
  });

  it('keeps a question as the inline request when it is the oldest', () => {
    const state = interactState({ inbox: [questionItem()] });
    const { cards } = widgetCards(state, selectTree(state));
    expect(cards[0]?.need).toMatchObject({ words: 'asked a question', agentKey: IK.asker });
  });
});

describe('card order', () => {
  const need = { item: null, words: 'needs approval', agentKey: KEYS.main };
  const c = (id: string, status: AgentStatus, waits = false, stale = false) => ({
    id,
    status,
    stale,
    need: waits ? need : null,
  });
  it('puts sessions that need the user first, then live work, then the rest, keeping order inside each group', () => {
    const order = orderCards([
      c('done', 'done'),
      c('work-a', 'working'),
      c('old', 'working', false, true),
      c('ask-a', 'waiting_answer', true),
      c('idle', 'idle'),
      c('paused', 'paused'),
      c('work-b', 'starting'),
      c('ask-b', 'waiting_approval', true),
    ]).map((x) => x.id);
    expect(order).toEqual(['ask-a', 'ask-b', 'work-a', 'work-b', 'paused', 'done', 'idle', 'old']);
  });
});
