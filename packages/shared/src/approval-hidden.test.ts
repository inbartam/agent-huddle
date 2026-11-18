import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from './model.js';
import { approvalTextHidden } from './selectors.js';

function request(summary: string, hidden?: boolean): ApprovalRequest {
  return {
    requestId: 'r1',
    agentKey: 's::main',
    toolName: 'Bash',
    toolInput: { command: summary },
    summary,
    receivedAt: 0,
    expiresAt: null,
    channel: 'hook',
    ...(hidden === undefined ? {} : { hidden }),
  };
}

describe('approvalTextHidden (AX-01)', () => {
  it('is true when the request says part of it is hidden', () => {
    expect(approvalTextHidden(request('git status', true))).toBe(true);
  });

  it('is false for a plain request', () => {
    expect(approvalTextHidden(request('git status'))).toBe(false);
    expect(approvalTextHidden(request('git status', false))).toBe(false);
  });

  it('treats an older summary with a mask or a clip mark as hidden', () => {
    expect(approvalTextHidden(request('GITHUB_TOKEN="<redacted>" git status'))).toBe(true);
    expect(approvalTextHidden(request(`echo ${'a'.repeat(295)}…`))).toBe(true);
  });
});
