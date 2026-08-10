import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../packages/morse-ai/dist/cli.js", import.meta.url));

/** Minimal MCP stdio client — enough to drive the server the way a harness does. */
export class McpClient {
  #child;
  #pending = new Map();
  #nextId = 1;

  constructor(env = {}) {
    // Tests run on machines that are themselves running morse, so MORSE_AGENT
    // and friends are already in the environment. Inheriting them would let the
    // developer's own room decide what the server under test believes it is —
    // the suite must see only what the test declares.
    const base = { ...process.env };
    for (const key of Object.keys(base)) {
      if (key.startsWith("MORSE_")) delete base[key];
    }

    this.#child = spawn(process.execPath, [CLI, "mcp"], {
      env: { ...base, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    });

    this.stderr = "";
    this.#child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });

    // Without this, a server that dies mid-request leaves the caller waiting
    // forever and the failure looks like a timeout instead of a crash.
    this.#child.on("exit", (code) => {
      for (const [, pending] of this.#pending) {
        pending.reject(new Error(`morse mcp exited (code ${code}):\n${this.stderr.trim()}`));
      }
      this.#pending.clear();
    });
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "morse-test", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  /** Returns the tool's structured payload, as the model would see it. */
  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.structuredContent) return result.structuredContent;
    return JSON.parse(result.content[0].text);
  }

  /** Fire a tool call without awaiting it, so the caller can cancel or race it. */
  callRaw(name, args = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
    });
    return { id, promise };
  }

  async close() {
    this.#child.stdin.end();
    await new Promise((resolve) => {
      if (this.#child.exitCode !== null) return resolve();
      this.#child.on("exit", resolve);
      setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 2000);
    });
  }
}
