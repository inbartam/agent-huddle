/**
 * The bridge the preload exposes on `window.huddle`. Exactly five functions: the four of ADR-015 and the read-only
 * `query` of ADR-020; nothing else from Electron or Node reaches the renderer. The renderer's env.d.ts uses this type
 * only.
 */
import type {
  AgentKey,
  CommandResult,
  HuddleCommand,
  HuddleEvent,
  HuddleQuery,
  HuddleState,
  QueryResult,
} from '@huddle/shared';

export interface HuddleBridge {
  command(cmd: HuddleCommand): Promise<CommandResult>;
  getState(): Promise<HuddleState>;
  getEvents(agentKey: AgentKey, limit: number): Promise<HuddleEvent[]>;
  /** Subscribe to event batches (at most one every 100 ms). Returns an unsubscribe function. */
  onEvents(listener: (batch: HuddleEvent[]) => void): () => void;
  /**
   * A read-only question (ADR-020), one of the families in `huddleQuerySchema` (main/validate.ts): policy.preview,
   * pick.folder, the M5 history, replay, report, scorecard and Ask questions, phone.addresses, skills.list and
   * skill.read. Changes nothing and writes no event.
   */
  query(q: HuddleQuery): Promise<QueryResult>;
}

export const BRIDGE_KEY = 'huddle';
