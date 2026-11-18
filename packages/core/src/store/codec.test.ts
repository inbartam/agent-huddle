import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { serializeEvent } from './codec.js';

describe('serializeEvent', () => {
  it('keeps an attention itemId byte for byte, even when it contains key=value text (A1-03)', () => {
    const itemId = 'conflict:c:/r:c:/r/api_key=prod.json';
    const event = { id: 'e1', type: 'attention.resolved', itemId } as unknown as HuddleEvent;
    const stored = JSON.parse(serializeEvent(event, () => undefined)) as { itemId: string };
    expect(stored.itemId).toBe(itemId);
  });
});
