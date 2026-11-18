import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent, type PolicyRule } from '@huddle/shared';
import { initialState, reduce } from '../state/reduce.js';
import { PREVIEW_SAMPLES_MAX, previewRule } from './preview.js';

const S = 'session-1';
const MAIN = agentKey(S);

function requested(i: number, toolName: string, toolInput: Record<string, unknown>, summary: string): HuddleEvent {
  return {
    id: `e${String(i).padStart(3, '0')}`,
    type: 'approval.requested',
    ts: 1000 + i,
    sessionId: S,
    agentKey: MAIN,
    source: 'hook',
    request: {
      requestId: `req-${String(i)}`,
      agentKey: MAIN,
      toolName,
      toolInput,
      summary,
      receivedAt: 1000 + i,
      expiresAt: null,
      channel: 'hook',
    },
  };
}

function agentsWithCwd() {
  const start: HuddleEvent = {
    id: 'e000',
    type: 'session.started',
    ts: 900,
    sessionId: S,
    agentKey: MAIN,
    source: 'hook',
    origin: 'attached',
    startKind: 'startup',
    cwd: 'C:/Users/user/project',
    model: null,
    title: null,
  } as unknown as HuddleEvent;
  return reduce(initialState(), start).agents;
}

const allowStatus: PolicyRule = {
  id: 'a',
  name: 'status',
  enabled: false, // previewed as if enabled
  action: 'allow',
  match: { commandPrefix: 'git status' },
};

describe('previewRule', () => {
  const events = [
    requested(1, 'Bash', { command: 'git status' }, 'git status'),
    requested(2, 'Bash', { command: 'git status && rm -rf x' }, 'git status && rm -rf x'),
    requested(3, 'Bash', { command: 'git status aaaa…' }, 'git status aaaa…'),
    requested(4, 'Bash', { command: 'git status TOKEN=<redacted>' }, 'git status TOKEN=<redacted>'),
    requested(5, 'Bash', { command: 'git status -s' }, 'git status -s'),
    requested(6, 'Read', { file_path: 'C:/Users/user/project/src/a.ts' }, 'C:/Users/user/project/src/a.ts'),
    requested(7, 'AskUserQuestion', {}, 'Which?'),
  ];

  it('counts what an allow would match, newest first, never a clipped, masked or compound sample; says approximate', () => {
    const preview = previewRule(allowStatus, events, agentsWithCwd());
    expect(preview).toEqual({
      examined: 6,
      matched: 2,
      approximate: true,
      samples: [
        { agentKey: MAIN, toolName: 'Bash', summary: 'git status -s', receivedAt: 1005 },
        { agentKey: MAIN, toolName: 'Bash', summary: 'git status', receivedAt: 1001 },
      ],
    });
  });

  it('a deny matches the clipped, masked and compound samples too', () => {
    const preview = previewRule({ ...allowStatus, action: 'deny' }, events, agentsWithCwd());
    expect(preview.matched).toBe(5);
  });

  it('a path rule uses the agent cwd', () => {
    const rule: PolicyRule = { ...allowStatus, match: { tool: 'Read', pathGlob: 'src/**' } };
    expect(previewRule(rule, events, agentsWithCwd()).matched).toBe(1);
    expect(previewRule(rule, events, {}).matched).toBe(0); // unknown agent: no cwd, no allow
  });

  it('an allow never matches a write to a protected path here either; a deny does', () => {
    const writes = [
      requested(11, 'Write', { file_path: 'C:/Users/user/project/.git/config' }, '.git/config'),
      requested(12, 'Edit', { file_path: 'C:/Users/user/project/.claude/settings.json' }, '.claude/settings.json'),
      requested(13, 'Write', { file_path: 'C:/Users/user/project/.claude/worktrees/x.txt' }, 'worktrees/x.txt'),
      requested(
        14,
        'PowerShell',
        { command: 'Set-Content .vscode\\tasks.json x' },
        'Set-Content .vscode\\tasks.json x',
      ),
    ];
    const agents = agentsWithCwd();
    const allowWrites: PolicyRule = { ...allowStatus, match: { pathGlob: '**' } };
    const allowSet: PolicyRule = { ...allowStatus, match: { commandPrefix: 'Set-Content' } };
    expect(previewRule(allowWrites, writes, agents)).toMatchObject({
      matched: 1,
      samples: [{ summary: 'worktrees/x.txt' }],
    });
    expect(previewRule(allowSet, writes, agents).matched).toBe(0);
    expect(previewRule({ ...allowWrites, action: 'deny' }, writes, agents).matched).toBe(3);
  });

  it('bounds the samples and the requests examined; duplicates count once', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      requested(i + 1, 'Bash', { command: 'git status' }, 'git status'),
    );
    const preview = previewRule(allowStatus, [...many, ...many], agentsWithCwd(), { examine: 20 });
    expect(preview.examined).toBe(20);
    expect(preview.matched).toBe(20);
    expect(preview.samples).toHaveLength(PREVIEW_SAMPLES_MAX);
    expect(preview.samples[0]?.receivedAt).toBe(1030);
  });
});
