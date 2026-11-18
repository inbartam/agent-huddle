/**
 * What the Electron main process needs from the core. `HuddleCore` (packages/core) implements it; the
 * canned dev core (`HUDDLE_DEV_CANNED=1`, unpackaged runs only) does too. The IPC layer only ever talks
 * to this interface. An empty event batch means "state changed without events" (ADR-017 connection).
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

export type EventsListener = (batch: readonly HuddleEvent[]) => void;

export interface CoreHost {
  /** Current derived state. Must be plain JSON (it crosses IPC). */
  getState(): HuddleState;
  /** Last `limit` events of one agent, oldest first. */
  getEvents(agentKey: AgentKey, limit: number): HuddleEvent[];
  /** Run an already-validated command. Never rejects; failures come back as `{ ok: false }`. */
  command(cmd: HuddleCommand): Promise<CommandResult>;
  /**
   * A read-only, already-validated question (`huddle:query`, ADR-020), one of the families in `huddleQuerySchema`
   * (validate.ts): policy.preview, pick.folder, the M5 history, replay, report, scorecard and Ask questions,
   * phone.addresses, skills.list and skill.read. Never rejects; changes nothing. `pick.folder` is answered by main itself (it needs a system dialog), so a host may answer it `unsupported`.
   */
  query(q: HuddleQuery): Promise<QueryResult>;
  /** Subscribe to new events as the core appends them. Returns an unsubscribe function. */
  onEvents(listener: EventsListener): () => void;
  /** Release resources (held hook responses, listeners, timers) before the app quits. */
  dispose(): Promise<void>;
}
