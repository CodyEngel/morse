import { createInterface } from "node:readline";

/**
 * Just enough of MCP's stdio transport to expose tools: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout. `tools/list` and `tools/call` have been stable
 * across every protocol revision below, so a tools-only server does not need
 * the full SDK (and does not need to drag express, hono and jose along with it).
 *
 * stdout carries the protocol and nothing else. Diagnostics go to stderr.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  /** Aborts if the client cancels the request, or the transport shuts down. */
  signal: AbortSignal;
}

export type ToolHandler = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ServerOptions {
  name: string;
  version: string;
  tools: ToolDefinition[];
  call: ToolHandler;
  /** The client identifies itself in the handshake; more reliable than env sniffing. */
  onInitialize?: (clientInfo: { name?: string; version?: string }) => void;
  /** Invoked once the transport closes, so the server can mark itself offline. */
  onShutdown?: () => void;
  /**
   * Turns a tool's structured result into the text the model reads. Defaults
   * to compact JSON; the composition layer supplies TOON. String results pass
   * through untouched either way, so error text is never re-encoded.
   */
  serialize?: (result: unknown) => string;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function serve(options: ServerOptions): void {
  const inFlight = new Map<string | number, AbortController>();
  const shutdown = new AbortController();
  const serialize = options.serialize ?? ((value: unknown) => JSON.stringify(value));
  let closed = false;

  const write = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const respond = (id: string | number, result: unknown): void => {
    write({ jsonrpc: "2.0", id, result });
  };

  const fail = (id: string | number, code: number, message: string): void => {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    options.onShutdown?.();
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;

    let msg: RpcMessage;
    try {
      msg = JSON.parse(text) as RpcMessage;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Notifications carry no id and must never be answered.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const requestId = msg.params?.requestId as string | number | undefined;
        if (requestId !== undefined) inFlight.get(requestId)?.abort();
      }
      return;
    }

    const id = msg.id;
    void handle(msg, id);
  });

  rl.on("close", finish);
  process.stdin.on("end", finish);
  process.on("SIGINT", () => { finish(); process.exit(0); });
  process.on("SIGTERM", () => { finish(); process.exit(0); });

  async function handle(msg: RpcMessage, id: string | number): Promise<void> {
    try {
      switch (msg.method) {
        case "initialize": {
          const clientInfo = msg.params?.clientInfo as { name?: string; version?: string } | undefined;
          if (clientInfo) options.onInitialize?.(clientInfo);
          const requested = msg.params?.protocolVersion;
          const protocolVersion =
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : FALLBACK_PROTOCOL_VERSION;
          respond(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
          });
          return;
        }

        case "ping":
          respond(id, {});
          return;

        case "tools/list":
          respond(id, { tools: options.tools });
          return;

        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
          const controller = new AbortController();
          const onShutdown = () => controller.abort();
          shutdown.signal.addEventListener("abort", onShutdown, { once: true });
          inFlight.set(id, controller);
          try {
            const result = await options.call(name, args, { signal: controller.signal });
            respond(id, toToolResult(result, serialize));
          } catch (error) {
            // Tool failures are results, not transport errors: the model needs
            // to see what went wrong so it can correct the call.
            respond(id, {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          } finally {
            inFlight.delete(id);
            shutdown.signal.removeEventListener("abort", onShutdown);
          }
          return;
        }

        // Declared unsupported, but answered rather than erroring so clients
        // that probe them during startup do not log noise.
        case "resources/list":
          respond(id, { resources: [] });
          return;
        case "prompts/list":
          respond(id, { prompts: [] });
          return;

        default:
          fail(id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (error) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
}

function toToolResult(result: unknown, serialize: (value: unknown) => string): Record<string, unknown> {
  const text = typeof result === "string" ? result : serialize(result);
  // Text only, deliberately. `structuredContent` is for tools that declare an
  // outputSchema; sending it alongside the text without one just puts every
  // message body into the model's context twice.
  return { content: [{ type: "text", text }] };
}
