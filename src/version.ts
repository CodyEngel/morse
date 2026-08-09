import { createRequire } from "node:module";

/**
 * Read from package.json rather than duplicated as a literal, so a release bump
 * cannot leave `morse --version` and the MCP handshake reporting a version that
 * was never published.
 *
 * `dist/version.js` sits one level under the package root in both the repo and
 * the published tarball, so the relative path holds in both.
 */
export const VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
