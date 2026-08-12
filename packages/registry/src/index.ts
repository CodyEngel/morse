/**
 * `@morse-ai/registry` — the directory half of morse.
 *
 * What lives here answers "who exists for this project, what can they do, and
 * are they here right now". It has no dependencies and, deliberately, no
 * database: every agent record has exactly one writer, so files are enough.
 * See docs/plans/multi-package-split.md, Decision 1.
 *
 * Role and plugin discovery is a separate entry point, `@morse-ai/registry/discovery`.
 */
export { resolveRoom, sanitizeRoom } from "./room.js";
export {
  FileRegistry,
  ONLINE_WINDOW_MS,
  isRunning,
  isValidAgentName,
  registryRoot,
  type Agent,
  type AgentStatus,
  type PublishInput,
} from "./registry.js";
export { REGISTRY_TOOLS, registryHandler, renderAgent, renderAgentBrief } from "./mcp.js";
