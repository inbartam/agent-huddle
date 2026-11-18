/**
 * Building blocks shared by the contract schemas (M3, M4): the event envelope and the common field checks. Same rules
 * everywhere: `z.looseObject` keeps unknown fields, free text is clipped to CLIP_LIMITS rather than rejected.
 */
import { z } from 'zod';
import { AGENT_KEY_MAX_LENGTH, CLIP_LIMITS } from '@huddle/shared';
import { clip } from '../text.js';

export const idText = z.string().min(1).max(CLIP_LIMITS.id);
export const agentKeyText = z.string().min(1).max(AGENT_KEY_MAX_LENGTH);
export const epochMs = z.number().int().nonnegative();
export const clipped = (limit: number) => z.string().transform((s) => clip(s, limit));

export const envelope = {
  id: idText,
  ts: epochMs,
  sessionId: idText,
  agentKey: agentKeyText,
  source: z.enum(['hook', 'telemetry', 'stream', 'statusline', 'cli', 'huddle', 'user']),
};

export const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ ...envelope, type: z.literal(type), ...shape });

export const command = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), ...shape });
