/** Append-only event log on disk. */
export {
  JsonlEventStore,
  InvalidSessionIdError,
  isIngestSessionId,
  isValidSessionId,
  defaultEventsDir,
  MAX_AGENT_EVENTS,
  type HuddleEventStore,
  type JsonlEventStoreOptions,
  type JsonlEventStoreStats,
  type SessionSummary,
} from './jsonl-store.js';
export {
  SqliteEventStore,
  defaultDatabasePath,
  toFtsQuery,
  searchTerms,
  type SqliteEventStoreOptions,
  type SqliteEventStoreStats,
  type StoredSession,
} from './sqlite-store.js';
export { SCHEMA_VERSION, UnsupportedSchemaError } from './sqlite-schema.js';
export {
  HistoryTables,
  type Derivation,
  type DerivationInput,
  type PendingDerivation,
  type SessionCursor,
  type SessionPageOptions,
  type SessionWithDerivation,
  type StoredRow,
} from './history-tables.js';
export {
  migrateJsonlToSqlite,
  isJsonlMigrationDone,
  migratedFolderName,
  META_MIGRATED_AT,
  META_MIGRATED_FROM,
  META_MIGRATED_TO,
  META_MIGRATION,
  type JsonlMigrationReport,
  type MigrateJsonlOptions,
  type MigrationTarget,
} from './migrate-jsonl.js';
