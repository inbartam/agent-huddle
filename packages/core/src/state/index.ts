/** Pure reducer and selectors: HuddleEvent[] -> HuddleState. */
export {
  reduce,
  replay,
  initialState,
  toHuddleState,
  ATTACHED_CAPABILITIES,
  MANAGED_CAPABILITIES,
  MAX_PENDING,
  MAX_SPAWNS_PER_SESSION,
  type ReducerState,
  type Bookkeeping,
  type SessionBook,
  type AgentBook,
  type SpawnRecord,
  type SessionRoleInfo,
  type PendingLink,
  type PendingModel,
} from './reduce.js';
export {
  selectTree,
  selectAgent,
  selectNeedsYouCount,
  selectTimeline,
  TIMELINE_LIMIT,
  type SessionView,
  type TreeNodeView,
  type TimelineEntry,
  type TimelineKind,
} from '@huddle/shared';
export { isTerminal } from '@huddle/shared';
