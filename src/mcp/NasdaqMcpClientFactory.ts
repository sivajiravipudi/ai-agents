/**
 * NASDAQ MCP client — session manager.
 *
 * Connects to the standalone nasdaq-mcp-server HTTP instance via StreamableHTTP.
 * One session per application lifecycle; session ID reused across all requests.
 *
 * Start the server first:  npm run mcp
 * Exposes tools: get_nasdaq_stock_data, search_nasdaq_ticker, get_technical_analysis
 */

import { McpClient } from "@strands-agents/sdk";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger.js";

/*
 * ---------------------------------------------------------------------------
 * LEGACY FACTORY FUNCTIONS — kept for reference, not used in production
 *
 * These were the original stateless factory approaches before NasdaqMcpSession
 * was introduced. They are preserved here in case you need to:
 *   - Quickly spin up a one-off MCP client in a script or test
 *   - Fall back to stdio mode (spawns nasdaq-mcp-server as a child process)
 *   - Understand the evolution of the transport strategy
 * ---------------------------------------------------------------------------
 *
 * [LEGACY — STDIO MODE]
 * Purpose: Spawns nasdaq-mcp-server.ts as a child process via tsx (stdio transport).
 * Use case: Local development without running a separate HTTP server.
 * Superseded by: NasdaqMcpSession (HTTP transport, persistent session).
 *
 * To re-enable, also restore these imports:
 *   import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
 *   import { fileURLToPath } from "url";
 *   import { dirname, join } from "path";
 *
 * export function createNasdaqMcpClient(): McpClient {
 *   logger.info("Creating NASDAQ MCP client (stdio) → local nasdaq-mcp-server.ts");
 *   const __filename = fileURLToPath(import.meta.url);
 *   const serverPath = join(dirname(__filename), "nasdaq-mcp-server.ts");
 *   const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverPath] });
 *   return new McpClient({ transport });
 * }
 *
 * ---------------------------------------------------------------------------
 *
 * [LEGACY — STATELESS HTTP FACTORY]
 * Purpose: Creates a new McpClient with a fresh StreamableHTTP transport on every call.
 * Use case: Simple one-off connections; no session reuse.
 * Superseded by: NasdaqMcpSession — which reuses one transport/session ID per
 *   application lifecycle and reconnects transparently on transport errors.
 *   This avoids the "Already connected to a transport" error caused by reusing
 *   the same McpClient instance across multiple requests.
 *
 * export function createNasdaqMcpClientHttp(url: string = DEFAULT_HTTP_URL): McpClient {
 *   logger.info(`Creating NASDAQ MCP client (streamable-http) → ${url}`);
 *   const transport = new StreamableHTTPClientTransport(new URL(url));
 *   return new McpClient({ transport });
 * }
 */

/** NASDAQ MCP service URL — override via NASDAQ_MCP_URL env var for production */
const DEFAULT_HTTP_URL = process.env.NASDAQ_MCP_URL ?? "http://localhost:3002/mcp";

/**
 * Production-grade MCP session manager.
 *
 * - One MCP session per application lifecycle (session ID reused across all requests).
 * - Transparent reconnect on transport/session errors — callers never see the error.
 * - Exposes `client` for use in Agent tools array.
 */
export class NasdaqMcpSession {
  private _client: McpClient | null = null;
  private _reconnecting = false;
  private readonly url: string;

  constructor(url: string = DEFAULT_HTTP_URL) {
    this.url = url;
  }

  /** Connect (or reconnect) and return the live McpClient */
  async connect(): Promise<McpClient> {
    if (this._client) {
      try { await this._client.disconnect(); } catch { /* ignore stale session */ }
    }
    logger.info(`[NasdaqMcpSession] Connecting to ${this.url}`);
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    this._client = new McpClient({ transport });
    logger.info(`[NasdaqMcpSession] Session established.`);
    return this._client;
  }

  /** The current live McpClient — call connect() before accessing */
  get client(): McpClient {
    if (!this._client) throw new Error("NasdaqMcpSession not connected. Call connect() first.");
    return this._client;
  }

  /** Reconnect once — idempotent if already reconnecting */
  async reconnect(): Promise<McpClient> {
    if (this._reconnecting) {
      await new Promise((r) => setTimeout(r, 500));
      return this._client!;
    }
    this._reconnecting = true;
    try {
      logger.warn("[NasdaqMcpSession] Transport error detected — reconnecting...");
      return await this.connect();
    } finally {
      this._reconnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this._client) {
      try { await this._client.disconnect(); } catch { /* ignore */ }
      this._client = null;
      logger.info("[NasdaqMcpSession] Disconnected.");
    }
  }
}
