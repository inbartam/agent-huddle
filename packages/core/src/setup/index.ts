/** Product version of scripts/install-hooks.mjs (ADR-014) and role descriptions from agent definition files. */
export {
  HookInstaller,
  planInstall,
  planUninstall,
  diffSettings,
  settingsForDisplay,
  describeJsonError,
  formatDiff,
  checkTimeoutOverrides,
  isHuddleHook,
  isHuddleStatusLine,
  stripBom,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
  HOLD_TIMEOUT_S,
  PERMISSION_TIMEOUT_S,
  defaultTimeoutFor,
  FORWARDER_FILENAME,
  STATUSLINE_WRAPPER_FILENAME,
  STATUSLINE_ORIGINAL_FILENAME,
  type SavedStatusLine,
  type InstallerDeps,
  type PrepareInstallOptions,
  type PreparedChange,
  type ApplyResult,
  type Consent,
  type SettingsPlan,
  type PlanError,
  type InstallOptions,
  type UninstallOptions,
  type DiffLine,
  type EventSet,
} from './install-hooks.js';
/**
 * The opt-in self-report MCP registration for attached sessions (ADR-025). Exported for the packaged `--remove-hooks`
 * command (M6 P6), which removes the Huddle's own `huddle` server with `removeIfOurs` (never a foreign one) in a
 * process that hosts no HuddleCore. The core itself uses it internally.
 */
export { McpRegistrar, type McpRegistrarDeps, type McpApplyResult } from './mcp-register.js';
export {
  readAgentRoles,
  parseAgentDefinition,
  parseFrontmatter,
  roleDescribedEvents,
  type RoleInfo,
  type AgentRoleSources,
  type RoleEventContext,
} from './agent-roles.js';
