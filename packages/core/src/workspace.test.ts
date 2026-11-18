import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, IPC } from '@huddle/shared';

// Proves that npm workspaces link @huddle/shared into core and that Vitest resolves its TypeScript source.
describe('workspace resolution', () => {
  it('imports runtime values from @huddle/shared', () => {
    expect(IPC.command).toBe('huddle:command');
    expect(CLIP_LIMITS.prompt).toBeGreaterThan(0);
  });
});
