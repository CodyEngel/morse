/**
 * Role and plugin discovery: how morse finds out what an agent could be, from
 * files on disk.
 *
 * Split out from the package root because it answers a different question. The
 * root is "who is in this room right now"; this is "what definitions exist on
 * this machine, and where did each come from". A tool that only wants to read
 * `.claude/agents` can import this and nothing else.
 */
export {
  isValidRoleName,
  isInside,
  loadRole,
  listRoles,
  parseRole,
  parseTomlRole,
  collectRoles,
  findRole,
  roleSearchPaths,
  roleSearchDirs,
  roleSearchOverrides,
  roleSearchReport,
  roleTemplate,
  type FieldMap,
  type ParseOptions,
  type RoleDefinition,
  type RoleRejection,
  type RoleSearch,
  type SearchDir,
} from "./roles.js";

export {
  BUILTIN_PLUGINS,
  loadPlugins,
  pluginDirs,
  pluginsEnabled,
  expandDepth,
  type PluginDir,
  type PluginManifest,
  type PluginOverride,
} from "./plugins.js";

export { parseToml, tomlString, type TomlValue } from "./toml.js";
