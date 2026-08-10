export { openDb, dbPath, resetDb } from "./db.js";
// Re-exported rather than dropped: splitting morse into packages is not a
// reason for anyone importing `morse-ai` to have to learn where things went.
export {
  resolveRoom,
  sanitizeRoom,
  FileRegistry,
  ONLINE_WINDOW_MS,
  isRunning,
  isValidAgentName,
  registryRoot,
  type Agent,
  type AgentStatus,
  type PublishInput,
} from "@morse-ai/registry";
export {
  isValidRoleName,
  isInside,
  loadRole,
  listRoles,
  parseRole,
  parseTomlRole,
  collectRoles,
  findRole,
  type RoleRejection,
  type RoleSearch,
  roleSearchPaths,
  roleSearchDirs,
  roleSearchReport,
  roleTemplate,
  type FieldMap,
  type ParseOptions,
  type RoleDefinition,
  type SearchDir,
  BUILTIN_PLUGINS,
  loadPlugins,
  pluginDirs,
  pluginsEnabled,
  expandDepth,
  type PluginDir,
  type PluginManifest,
  parseToml,
  tomlString,
  type TomlValue,
} from "@morse-ai/registry/discovery";
export { buildPrompt, type PromptOptions } from "./prompt.js";
export {
  Store,
  BROADCAST,
  normalizeRecipients,
  newThreadId,
  type Message,
  type MessageKind,
} from "./store.js";
export { waitForInbox, waitForReply, type AskResult, type WaitOptions } from "./wait.js";
export { VERSION } from "./version.js";
export { buildHarnessArgs } from "./cli/main.js";
