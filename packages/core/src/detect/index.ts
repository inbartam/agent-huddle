/**
 * Detectors (F21): stuck agents, loops and file conflicts, as one pure fold over HuddleEvents.
 *
 *     { state, emit } = step(state, event, thresholds)   // for every event, in log order
 *     { state, emit } = tick(state, now, thresholds)     // on a timer (time-based raises and resolves)
 *
 * `emit` holds fully formed attention.raised / attention.resolved events (source 'huddle') with ids derived from the
 * item id and the triggering event's id, so the same input always gives the same output. The caller appends them to
 * the log like any other event; feeding them back into `step` is harmless (they are ignored). No clock, randomness or
 * I/O: `now` enters only as tick's argument, and event times come from the events.
 *
 * Item ids: `stuck:<agentKey>`, `loop:<agentKey>:<digest>`, `loop:<agentKey>:failures`, `conflict:<cwd>:<path>`.
 * Raise and resolve rules are in stuck.ts, loop.ts and conflict.ts. Every item is resolved when its agent ends.
 * The state is plain JSON (records and arrays only).
 */
import { ROLE_PROFILES, type DetectorSettings, type HuddleEvent, type RoleKindOverrides } from '@huddle/shared';
import type { DetectorEmit } from './common.js';
import { emptyConflict, stepConflict, tickConflict, type ConflictState } from './conflict.js';
import { emptyLife, stepLife, type LifeState } from './lifecycle.js';
import { emptyLoop, stepLoop, type LoopState } from './loop.js';
import { emptyRoles, stepRoles, trackedRoleKind, type RoleState } from './role-drift.js';
import { emptyStuck, stepStuck, tickStuck, type StuckState } from './stuck.js';

export interface DetectorState {
  life: LifeState;
  stuck: StuckState;
  loop: LoopState;
  conflict: ConflictState;
  /** Roles and role-drift items (2026-11-18). Absent in a state saved before: read as empty. */
  roles?: RoleState;
}

export interface DetectorStep {
  state: DetectorState;
  emit: DetectorEmit[];
}

export function emptyDetectorState(): DetectorState {
  return { life: emptyLife(), stuck: emptyStuck(), loop: emptyLoop(), conflict: emptyConflict(), roles: emptyRoles() };
}

/**
 * Fold one event. Attention events (including the detectors' own) change nothing. `roleKinds` are the user's agent
 * types by role (settings), for role drift.
 */
export function step(
  state: DetectorState,
  event: HuddleEvent,
  thresholds: DetectorSettings,
  roleKinds: RoleKindOverrides | null = null,
): DetectorStep {
  if (event.type === 'attention.raised' || event.type === 'attention.resolved') return { state, emit: [] };
  const life = stepLife(state.life, event);
  const stuck = stepStuck(state.stuck, life.state, event);
  const loop = stepLoop(state.loop, life.state, event, thresholds, life.ended);
  const conflict = stepConflict(state.conflict, life.state, event, thresholds, life.ended);
  const roles = stepRoles(state.roles ?? emptyRoles(), event, life.ended, roleKinds);
  return {
    state: { life: life.state, stuck: stuck.state, loop: loop.state, conflict: conflict.state, roles: roles.state },
    emit: [...stuck.emit, ...loop.emit, ...conflict.emit, ...roles.emit],
  };
}

/**
 * Time passes: raise stuck items, resolve conflicts whose window passed. An agent's quiet limit is scaled by its
 * type (a reviewer reading is quiet longer than a builder; `ROLE_PROFILES[k].quietFactor`).
 */
export function tick(
  state: DetectorState,
  now: number,
  thresholds: DetectorSettings,
  roleKinds: RoleKindOverrides | null = null,
): DetectorStep {
  const roles = state.roles ?? emptyRoles();
  const quietFactor = (key: string): number => {
    const kind = trackedRoleKind(roles, key, roleKinds);
    return kind === null ? 1 : ROLE_PROFILES[kind].quietFactor;
  };
  const stuck = tickStuck(state.stuck, state.life, now, thresholds, quietFactor);
  const conflict = tickConflict(state.conflict, now, thresholds);
  return { state: { ...state, stuck: stuck.state, conflict: conflict.state }, emit: [...stuck.emit, ...conflict.emit] };
}

export type { DetectorEmit } from './common.js';
// Budgets (F19) read the reducer's state rather than folding events alone, so they are a fold of their own: budget.ts.
export {
  budgetKeyOf,
  budgetOverItemId,
  budgetWarningItemId,
  emptyBudgetState,
  finishBudgetAction,
  seedBudgetState,
  stepBudget,
  tickBudget,
  type BudgetAction,
  type BudgetOutcome,
  type BudgetState,
  type BudgetStep,
} from './budget.js';
export { raisedEventId, resolvedEventId } from './common.js';
export { conflictItemId, EDIT_TOOLS, normalizePath, type ConflictState } from './conflict.js';
export { MAX_ENDED_AGENTS, SPAWN_TOOLS, type LifeState, type Phase, type TrackedAgent } from './lifecycle.js';
export { failureItemId, repeatItemId, type LoopState } from './loop.js';
export { stuckItemId, type StuckState } from './stuck.js';
