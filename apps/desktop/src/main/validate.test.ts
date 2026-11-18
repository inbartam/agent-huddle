import { describe, expect, it } from 'vitest';
import { parseCommand, parseGetEventsArgs } from './validate.js';

describe('parseCommand', () => {
  it.each([
    ['null', null],
    ['a string', 'agent.stop'],
    ['an array', [{ type: 'all.stop' }]],
    ['no type', { agentKey: 's1' }],
    ['an unknown type', { type: 'shell.exec', command: 'rm -rf /' }],
    ['a missing field', { type: 'agent.stop' }],
    ['a wrong field type', { type: 'agent.stop', agentKey: 42 }],
    ['an empty agent key', { type: 'agent.pause', agentKey: '' }],
    ['a bad enum', { type: 'approval.decide', requestId: 'r1', decision: 'maybe' }],
    ['an over-long message', { type: 'agent.message', agentKey: 's1', text: 'x'.repeat(5000), delivery: 'auto' }],
    ['a bad answers record', { type: 'question.answer', requestId: 'r1', answers: { q: 3 } }],
    [
      'a template without cwd',
      {
        type: 'run.launch',
        template: {
          id: 't',
          name: 'n',
          description: '',
          prompt: 'p',
          useWorktree: false,
          budgets: [],
          policyRuleIds: [],
        },
      },
    ],
    ['a prototype-polluting object', JSON.parse('{"__proto__": {"type": "all.stop"}}') as unknown],
  ])('rejects %s', (_label, input) => {
    expect(parseCommand(input)).toBeNull();
  });

  it('accepts valid commands', () => {
    expect(parseCommand({ type: 'all.stop' })).toEqual({ type: 'all.stop' });
    expect(parseCommand({ type: 'setup.attach' })).toEqual({ type: 'setup.attach' });
    expect(parseCommand({ type: 'agent.rename', agentKey: 's1::a1', name: 'Tokenizer' })).toEqual({
      type: 'agent.rename',
      agentKey: 's1::a1',
      name: 'Tokenizer',
    });
    expect(
      parseCommand({
        type: 'budget.set',
        agentKey: null,
        budget: { scope: 'all', warnAtFraction: 0.8, onExceed: 'notify' },
      }),
    ).not.toBeNull();
    expect(
      parseCommand({ type: 'question.answer', requestId: 'r', answers: { a: 'x', b: ['y', 'z'] } }),
    ).not.toBeNull();
  });

  it('keeps unknown extra fields instead of failing', () => {
    expect(parseCommand({ type: 'agent.stop', agentKey: 's1', futureField: 1 })).toEqual({
      type: 'agent.stop',
      agentKey: 's1',
      futureField: 1,
    });
  });
});

describe('M3 commands (schemas from @huddle/core)', () => {
  it('accepts message.cancel and settings.update', () => {
    expect(parseCommand({ type: 'message.cancel', agentKey: 's1', messageId: 'm1' })).toEqual({
      type: 'message.cancel',
      agentKey: 's1',
      messageId: 'm1',
    });
    expect(parseCommand({ type: 'settings.update', patch: {} })).toEqual({ type: 'settings.update', patch: {} });
    expect(
      parseCommand({
        type: 'settings.update',
        patch: { toasts: { loop: false }, detectors: { stuckMinutes: 10 }, globalShortcut: 'Control+Alt+J' },
      }),
    ).not.toBeNull();
    expect(parseCommand({ type: 'settings.update', patch: { widgetCollapsed: true } })).toEqual({
      type: 'settings.update',
      patch: { widgetCollapsed: true },
    });
  });

  it.each([
    ['message.cancel without messageId', { type: 'message.cancel', agentKey: 's1' }],
    ['message.cancel with an empty agent key', { type: 'message.cancel', agentKey: '', messageId: 'm1' }],
    ['message.cancel with an over-long id', { type: 'message.cancel', agentKey: 's1', messageId: 'm'.repeat(300) }],
    ['settings.update without patch', { type: 'settings.update' }],
    ['a toast switch that is not a boolean', { type: 'settings.update', patch: { toasts: { loop: 'no' } } }],
    ['a detector out of range', { type: 'settings.update', patch: { detectors: { stuckMinutes: 0 } } }],
    ['a question window past the hook timeout', { type: 'settings.update', patch: { questionHoldSeconds: 900 } }],
    ['a shortcut with spaces', { type: 'settings.update', patch: { globalShortcut: 'Control Alt H' } }],
    ['a shortcut that is too long', { type: 'settings.update', patch: { globalShortcut: 'A'.repeat(101) } }],
    ['a collapsed widget that is not a boolean', { type: 'settings.update', patch: { widgetCollapsed: 'yes' } }],
  ])('rejects %s', (_label, input) => {
    expect(parseCommand(input)).toBeNull();
  });

  it('keeps the message length cap on agent.message', () => {
    expect(
      parseCommand({ type: 'agent.message', agentKey: 's1', text: 'x'.repeat(2000), delivery: 'turn_end' }),
    ).not.toBeNull();
    expect(
      parseCommand({ type: 'agent.message', agentKey: 's1', text: 'x'.repeat(2001), delivery: 'turn_end' }),
    ).toBeNull();
  });

  it('attention.dismiss takes detector ids that carry paths, within a bound', () => {
    const id = `conflict:C:\\projects\\example:C:\\projects\\example\\${'d\\'.repeat(200)}file.ts`;
    expect(parseCommand({ type: 'attention.dismiss', itemId: id })).not.toBeNull();
    expect(parseCommand({ type: 'attention.dismiss', itemId: 'x'.repeat(3000) })).toBeNull();
  });
});

describe('parseGetEventsArgs', () => {
  it('accepts an agent key and a limit of 1..500', () => {
    expect(parseGetEventsArgs({ agentKey: 's1', limit: 1 })).toEqual({ agentKey: 's1', limit: 1 });
    expect(parseGetEventsArgs({ agentKey: 's1', limit: 500 })).toEqual({ agentKey: 's1', limit: 500 });
  });

  it.each([
    [undefined],
    [{}],
    [{ agentKey: 's1' }],
    [{ agentKey: 's1', limit: 0 }],
    [{ agentKey: 's1', limit: 501 }],
    [{ agentKey: 's1', limit: 2.5 }],
    [{ agentKey: 's1', limit: '10' }],
    [{ agentKey: 's1', limit: Number.NaN }],
    [{ agentKey: '', limit: 10 }],
    [{ agentKey: 7, limit: 10 }],
  ])('rejects %j', (input) => {
    expect(parseGetEventsArgs(input)).toBeNull();
  });
});
