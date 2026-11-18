/**
 * Every control's enabled state and tooltip come from selectControls (M3): not connected, capability off, ended,
 * from before a restart, already answered. Pause and resume show the hold countdown and the pending words. Also: agent
 * text with markup stays text in every new surface.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS, type HuddleState } from '@huddle/shared';
import { MessageSection, PauseControl } from './components/AgentControls.js';
import { AgentDetail } from './components/AgentDetail.js';
import { InboxCard } from './components/Inbox.js';
import { Palette } from './components/Palette.js';
import {
  APPROVAL,
  approvalItem,
  ATTACHED,
  CONFLICT,
  IK,
  interactState,
  NOW,
  questionItem,
  SINGLE,
  STARTED_AT,
} from './testing/interact-fixture.js';
import { T0, XSS } from './testing/fixture.js';
import { ALL_REASONS, allControl, HOLD_ENDED_WORDS, lastHoldEnding } from './view/inbox.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;

function mainOf(state: HuddleState) {
  const a = state.agents[IK.main];
  if (!a) throw new Error('no main agent');
  return a;
}

/** HTML escapes an apostrophe in attributes and text. */
const esc = (s: string) => s.replace(/'/g, '&#x27;');

function card(state: HuddleState, item = approvalItem()) {
  return renderToStaticMarkup(<InboxCard state={state} item={item} renames={new Map()} onCommand={ok} now={NOW} />);
}

function button(html: string, label: string): string {
  const m = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html);
  if (!m) throw new Error(`no button ${label}`);
  return m[0];
}

function expectOff(html: string, label: string, reason: string) {
  const b = button(html, label);
  expect(b).toContain('aria-disabled="true"');
  expect(b).toContain(`title="${esc(reason)}"`);
}

function pause(state: HuddleState, key: string) {
  const agent = state.agents[key];
  if (!agent) throw new Error('no agent');
  return renderToStaticMarkup(<PauseControl state={state} agent={agent} onCommand={ok} now={NOW} />);
}

describe('approval controls follow selectControls', () => {
  it('are off with "not connected" when there is no connection', () => {
    const html = card(interactState({ connection: undefined }));
    for (const label of ['Allow', 'Deny…', 'Pass to terminal']) expectOff(html, label, CONTROL_REASONS.notConnected);
    expect(html).toContain(`<p class="card-reason">${esc(CONTROL_REASONS.notConnected)}</p>`);
  });

  it('say the port is in use when it is', () => {
    const html = card(interactState({ connection: { status: 'port_in_use', message: 'x', startedAt: STARTED_AT } }));
    expectOff(html, 'Allow', CONTROL_REASONS.portInUse);
  });

  it('are off when the capability is off', () => {
    const html = card(interactState({ agents: { tester: { capabilities: { ...ATTACHED, approve: false } } } }));
    expectOff(html, 'Allow', CONTROL_REASONS.noApprove);
  });

  it('are off for an agent that ended, and for a request from before a restart', () => {
    expectOff(
      card(interactState({ agents: { tester: { status: 'done', endedAt: T0 + 1 } } })),
      'Allow',
      CONTROL_REASONS.ended,
    );
    const restarted = interactState({ connection: { status: 'attached', message: null, startedAt: T0 + 1 } });
    expectOff(card(restarted), 'Allow', CONTROL_REASONS.beforeRestart);
  });

  it('are off for an agent the state no longer has', () => {
    const html = card(interactState(), approvalItem({ agentKey: 'gone-session' }));
    expectOff(html, 'Allow', CONTROL_REASONS.ended);
  });

  it('turns question options off when the agent cannot be answered from Huddle', () => {
    const state = interactState({ agents: { asker: { capabilities: { ...ATTACHED, answerQuestions: false } } } });
    const html = card(state, questionItem(SINGLE));
    expectOff(html, 'Plain', CONTROL_REASONS.noAnswer);
    expectOff(html, 'Answer in terminal', CONTROL_REASONS.noAnswer);
  });
});

describe('pause and resume follow selectControls', () => {
  it('shows Resume and the countdown while held', () => {
    const html = pause(interactState(), IK.paused);
    expect(button(html, 'Resume')).not.toContain('aria-disabled');
    expect(html).toContain('resumes by itself in 9:42');
  });

  it('shows the paused glyph and label next to the countdown in the agent detail', () => {
    const state = interactState();
    const agent = state.agents[IK.paused];
    if (!agent) throw new Error('fixture');
    const html = renderToStaticMarkup(
      <AgentDetail
        state={state}
        agent={agent}
        renames={new Map()}
        onRename={ok}
        onSelect={noop}
        section="now"
        onSection={noop}
        timeline={{ rows: [], loading: false }}
        filter="all"
        onFilter={noop}
        now={NOW}
        onCommand={ok}
      />,
    );
    expect(html).toContain('data-status="paused" aria-hidden="true">‖</span><span class="status-label">paused</span>');
    expect(html).toContain('resumes by itself in 9:42');
    expect(html).toContain('<footer class="detail-foot">');
  });

  it('shows Cancel pause and "pausing at the next tool call" while a pause is pending', () => {
    const html = pause(interactState(), IK.pending);
    expect(button(html, 'Cancel pause')).not.toContain('aria-disabled');
    expect(html).toContain('pausing at the next tool call');
  });

  it('shows Pause, off with the reason, when the capability is off', () => {
    const html = pause(interactState(), IK.tester);
    expect(button(html, 'Pause')).not.toContain('aria-disabled');
    const off = interactState({ agents: { tester: { capabilities: { ...ATTACHED, pause: false } } } });
    expectOff(pause(off, IK.tester), 'Pause', CONTROL_REASONS.noPause);
  });

  it('says how the last pause ended', () => {
    const ending = lastHoldEnding(
      [
        {
          id: 'h1',
          ts: T0 + 5_000,
          sessionId: 's',
          agentKey: IK.tester,
          source: 'huddle',
          type: 'hold.ended',
          toolUseId: null,
          why: 'hold_limit',
        },
      ],
      IK.tester,
    );
    expect(ending?.words).toBe('released before the time limit');
    expect(HOLD_ENDED_WORDS.shutdown).toBe('released when Huddle quit');
    const state = interactState();
    const agent = state.agents[IK.tester];
    if (!agent) throw new Error('fixture');
    const html = renderToStaticMarkup(
      <PauseControl state={state} agent={agent} onCommand={ok} lastEnding={ending} now={NOW} />,
    );
    expect(html).toContain('last pause released before the time limit at');
  });

  it('pause all and resume all: on when any agent allows it, else a reason', () => {
    expect(allControl(interactState(), 'pause').enabled).toBe(true);
    expect(allControl(interactState(), 'resume').enabled).toBe(true);
    expect(allControl(interactState({ connection: undefined }), 'pause').reason).toBe(CONTROL_REASONS.notConnected);
    const calm = interactState({
      agents: { paused: { hold: null, status: 'working' }, pending: { pausePending: false } },
    });
    expect(allControl(calm, 'resume')).toEqual({ enabled: false, reason: ALL_REASONS.nothingToResume });
  });
});

describe('agent text stays text', () => {
  const hostile = interactState({
    agents: {
      main: { name: XSS, outbox: [{ messageId: 'm-x', text: XSS, delivery: 'auto', queuedAt: T0 }] },
      tester: { name: XSS },
    },
    inbox: [
      approvalItem({
        detail: XSS,
        approval: { ...APPROVAL, toolName: XSS, summary: XSS },
      }),
      questionItem({
        ...SINGLE,
        questions: [{ question: XSS, header: XSS, multiSelect: false, options: [{ label: XSS, description: XSS }] }],
      }),
      { ...CONFLICT, detail: XSS },
    ],
  });

  it('in every card, the composer outbox and the palette', () => {
    const htmls = [
      ...hostile.inbox.map((item) => card(hostile, item)),
      renderToStaticMarkup(<MessageSection state={hostile} agent={mainOf(hostile)} onCommand={ok} />),
      renderToStaticMarkup(<Palette state={hostile} renames={new Map()} onRun={noop} onClose={noop} />),
    ];
    for (const html of htmls) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });
});
