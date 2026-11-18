/**
 * Session ids the Huddle files its own events under (they belong to no Claude Code session). All are file-name-safe
 * ids that are never a Claude Code session id (those are UUIDs), and none ever becomes a node in the tree.
 *
 *   BUDGET_SESSION_ID   the overall budget's `budget.set` events (M4, F19). Replayed at every start, never deleted.
 *   HISTORY_SESSION_ID  `history.pruned` (M5, F22). Not replayed at start (what it names is gone from the database
 *                       already), never listed as a run, trimmed by the retention like any old event.
 *   PHONE_SESSION_ID    `phone.access_changed` and `phone.device_changed` (M6, F26). Not replayed at start (phone access
 *                       always starts off; paired phones are read from phone-devices.json), never listed as a run,
 *                       trimmed by the retention and deleted by "delete all history" like any other session.
 *   TASKS_SESSION_ID    `huddle_task.*` (F29, the Huddle's own task list). Replayed at every start, never listed as a
 *                       run, kept by the retention and by "delete all history" (like the overall budgets): it is the
 *                       user's to-do list, not run history. Defined in shared (orch.ts) so the renderer knows it too.
 */
export {
  BUDGET_SESSION_ID,
  HISTORY_SESSION_ID,
  HUDDLE_SESSION_IDS,
  PHONE_SESSION_ID,
  TASKS_SESSION_ID,
} from '@huddle/shared';
