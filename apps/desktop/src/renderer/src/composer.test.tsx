/**
 * The message composer and outbox (M3, F12): modes from selectControls (end of turn off for subagents), where the
 * message lands from whereMessageLands, the queued list with Cancel, and the exact command shapes.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS, selectControls } from '@huddle/shared';
import { MessageSection } from './components/AgentControls.js';
import { CONNECTED, IK, interactState } from './testing/interact-fixture.js';
import {
  cancelMessageCommand,
  deliveryWords,
  effectiveMode,
  landingLine,
  messageCommand,
  modeOptions,
  MESSAGE_MAX,
} from './view/composer.js';

const ok = () => Promise.resolve({ ok: true as const });

function composer(key: string, state = interactState()) {
  const agent = state.agents[key];
  if (!agent) throw new Error('no agent');
  return renderToStaticMarkup(<MessageSection state={state} agent={agent} onCommand={ok} />);
}

function segment(html: string, label: string): string {
  const m = new RegExp(`<button[^>]*role="radio"[^>]*>${label}</button>`).exec(html);
  if (!m) throw new Error(`no segment ${label}`);
  return m[0];
}

describe('modes', () => {
  it('offers end of turn to a main agent', () => {
    const html = composer(IK.main);
    expect(segment(html, 'End of turn')).not.toContain('aria-disabled');
    expect(segment(html, 'First chance')).toContain('aria-checked="true"');
    expect(html).toContain('Lands after the next tool call or when this turn ends.');
  });

  it('disables end of turn for a subagent, with the reason as its tooltip', () => {
    const html = composer(IK.pending);
    const end = segment(html, 'End of turn');
    expect(end).toContain('aria-disabled="true"');
    expect(end).toContain(`title="${CONTROL_REASONS.noFollowUp}"`);
    expect(html).toContain('Lands after the next tool call.');
  });

  it('falls back to auto when end of turn is off', () => {
    const state = interactState();
    const sub = state.agents[IK.pending];
    if (!sub) throw new Error('fixture');
    const controls = selectControls(sub, CONNECTED, CONNECTED.startedAt);
    expect(effectiveMode('turn_end', controls)).toBe('auto');
    expect(modeOptions(controls).map((o) => o.control.enabled)).toEqual([true, true, false]);
  });

  it('says an idle agent gets the message when it next works', () => {
    const state = interactState({ agents: { main: { status: 'idle' } } });
    const main = state.agents[IK.main];
    if (!main) throw new Error('fixture');
    expect(landingLine(main, 'auto')).toBe('The agent is idle: it gets this when it next works.');
  });

  it('shows the not-connected reason instead of a landing line', () => {
    const html = composer(IK.main, interactState({ connection: undefined }));
    expect(html).toContain(`<p class="composer-lands">${CONTROL_REASONS.notConnected.replace("'", '&#x27;')}</p>`);
    expect(html).toContain('readOnly=""');
  });
});

describe('commands', () => {
  it('sends agent.message with the trimmed, clipped text and the mode', () => {
    expect(messageCommand(IK.main, '  use pnpm  ', 'next_tool')).toEqual({
      type: 'agent.message',
      agentKey: IK.main,
      text: 'use pnpm',
      delivery: 'next_tool',
    });
    expect(messageCommand(IK.main, '   ', 'auto')).toBeNull();
    const long = messageCommand(IK.main, 'x'.repeat(MESSAGE_MAX + 50), 'auto');
    expect(long?.type === 'agent.message' ? long.text.length : 0).toBe(MESSAGE_MAX);
  });

  it('sends message.cancel for one queued message', () => {
    expect(cancelMessageCommand(IK.main, 'm-1')).toEqual({
      type: 'message.cancel',
      agentKey: IK.main,
      messageId: 'm-1',
    });
  });
});

describe('outbox', () => {
  it('lists queued messages oldest first with where each lands and a Cancel button', () => {
    const html = composer(IK.main);
    expect(html).toContain('Waiting to be delivered');
    expect(html.indexOf('Keep it under one page.')).toBeLessThan(html.indexOf('List the open issues too.'));
    expect(html).toContain(deliveryWords('next_tool'));
    expect(html).toContain(deliveryWords('turn_end'));
    const cancels = [...html.matchAll(/<button[^>]*>Cancel<\/button>/g)].map((m) => m[0]);
    expect(cancels).toHaveLength(2);
    for (const c of cancels) expect(c).not.toContain('aria-disabled');
  });

  it('shows no outbox when nothing is queued', () => {
    expect(composer(IK.pending)).not.toContain('Waiting to be delivered');
  });
});
