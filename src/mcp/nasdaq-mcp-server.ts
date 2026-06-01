#!/usr/bin/env node
/**
 * NASDAQ MCP Server
 *
 * Fetches stock data from NASDAQ's internal JSON API endpoints — the same
 * endpoints the nasdaq.com website calls, returning clean structured JSON
 * (no HTML parsing needed).
 *
 * Source page:  https://www.nasdaq.com/market-activity/stocks/{symbol}
 * APIs used:
 *   - https://api.nasdaq.com/api/quote/{symbol}/summary?assetclass=stocks
 *   - https://api.nasdaq.com/api/quote/{symbol}/info?assetclass=stocks
 *   - https://api.nasdaq.com/api/company/{symbol}/sec-filings (insider transactions)
 *   - https://api.nasdaq.com/api/quote/{symbol}/chart (technical analysis)
 *
 * Exposed tools:
 *   - get_nasdaq_stock_data     → price, volume, 52-week range, dividends, insider transactions
 *   - search_nasdaq_ticker      → ticker symbol lookup by company name
 *   - get_technical_analysis    → SMA-20/50/200, EMA-20, RSI-14, support/resistance, trend
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";

console.log("[NASDAQ-MCP] Server initialising — registering tools: get_nasdaq_stock_data, search_nasdaq_ticker, get_technical_analysis");

/** Cache: 5-minute TTL to avoid hammering NASDAQ on repeated queries */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: unknown; expiresAt: number }>();

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function buildReferer(symbol: string): string {
  return `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}`;
}

/** Extract a value from the NASDAQ summaryData object, stripping currency symbols */
function val(summaryData: Record<string, { value?: string }>, key: string): string {
  return summaryData?.[key]?.value ?? "N/A";
}

// ---------------------------------------------------------------------------
// Technical Analysis helpers — computed in-process from NASDAQ OHLCV candles
// ---------------------------------------------------------------------------

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

function smaTech(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function emaTech(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) emaVal = closes[i] * k + emaVal * (1 - k);
  return emaVal;
}

function rsiTech(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avg = gains / period;
  const avl = losses / period;
  if (avl === 0) return 100;
  return 100 - 100 / (1 + avg / avl);
}

function pivotLevels(candles: Candle[], lookback = 60): { support: number; resistance: number } {
  const slice = candles.slice(-lookback);
  return { resistance: Math.max(...slice.map((c) => c.high)), support: Math.min(...slice.map((c) => c.low)) };
}

function volTrendLabel(candles: Candle[]): string {
  if (candles.length < 20) return "insufficient data";
  const r5 = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
  const p15 = candles.slice(-20, -5).reduce((a, c) => a + c.volume, 0) / 15;
  const ratio = r5 / p15;
  if (ratio > 1.3) return "significantly above average (bullish signal)";
  if (ratio > 1.1) return "slightly above average";
  if (ratio < 0.7) return "significantly below average (low conviction)";
  if (ratio < 0.9) return "slightly below average";
  return "average";
}

function trendLabel(closes: number[], s20: number | null, s50: number | null, s200: number | null): string {
  const last = closes[closes.length - 1];
  const sigs: string[] = [];
  if (s20  !== null) sigs.push(last > s20  ? "above SMA-20"  : "below SMA-20");
  if (s50  !== null) sigs.push(last > s50  ? "above SMA-50"  : "below SMA-50");
  if (s200 !== null) sigs.push(last > s200 ? "above SMA-200" : "below SMA-200");
  if (s50 !== null && s200 !== null)
    sigs.push(s50 > s200 ? "golden cross (SMA-50 > SMA-200, bullish)" : "death cross (SMA-50 < SMA-200, bearish)");
  const above = sigs.filter((s) => s.startsWith("above")).length;
  const below = sigs.filter((s) => s.startsWith("below")).length;
  const overall = above >= 2 ? "bullish" : below >= 2 ? "bearish" : "neutral";
  return `${overall} — ${sigs.join(", ")}`;
}

/** Create a fresh McpServer instance with all tools registered — one per session */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "nasdaq-market-server",
    version: "1.0.0",
  });

  server.tool(
  "get_nasdaq_stock_data",
  {
    stock: z.string().describe(
      "The exact stock ticker code only — uppercase letters, no spaces, no company name, no sentence. " +
        "Examples: 'AAPL', 'GRAB', 'NVDA', 'TSLA'. Extract this from the user's question."
    ),
    description: z.string().describe(
      "A short description of what information is being requested about the stock, e.g. 'current price', 'PE ratio and fundamentals', 'full analysis'."
    ),
  },
  async ({ stock, description }) => {
    const sym = stock.toUpperCase().trim();
    console.log(`[NASDAQ-MCP][get_nasdaq_stock_data] Executing — symbol: ${sym}, request: "${description}"`);

    // Serve from cache if fresh
    const cached = cache.get(sym);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[NASDAQ-MCP][cache] HIT for ${sym} — serving cached data`);
      return { content: [{ type: "text", text: JSON.stringify(cached.data, null, 2) }] };
    }

    const referer = buildReferer(sym);
    const headers = { ...HEADERS, Referer: referer };

    try {
      console.log(`[NASDAQ-MCP] Fetching summary + info + insider transactions for ${sym} from api.nasdaq.com`);

      const [summaryRes, infoRes, insiderRes] = await Promise.all([
        fetch(`https://api.nasdaq.com/api/quote/${sym}/summary?assetclass=stocks`, { headers }),
        fetch(`https://api.nasdaq.com/api/quote/${sym}/info?assetclass=stocks`, { headers }),
        fetch(`https://api.nasdaq.com/api/company/${sym}/sec-filings?limit=14&sortColumn=filed&sortOrder=desc&FormGroup=Insider%20Transactions&IsQuoteMedia=true`, { headers }),
      ]);

      if (!summaryRes.ok) {
        throw new Error(`NASDAQ summary API returned ${summaryRes.status} ${summaryRes.statusText} for ${sym}`);
      }

      const summaryJson = (await summaryRes.json()) as {
        data?: { summaryData?: Record<string, { label?: string; value?: string }> };
      };

      // info endpoint — live price, net change, % change
      const infoJson = infoRes.ok
        ? ((await infoRes.json()) as {
            data?: {
              primaryData?: {
                lastSalePrice?: string;
                netChange?: string;
                percentageChange?: string;
                deltaIndicator?: string;
                lastTradeTimestamp?: string;
                volume?: string;
              };
              companyName?: string;
              marketStatus?: string;
            };
          })
        : null;

      // SEC insider transactions — fall back gracefully for tickers with no filings
      const insiderJson = insiderRes.ok
        ? ((await insiderRes.json()) as {
            data?: {
              totalRecords?: number;
              rows?: Array<{
                companyName?: string;
                reportingOwner?: string;
                formType?: string;
                filed?: string;
                period?: string;
                view?: { htmlLink?: string };
              }>;
            };
          })
        : null;

      const sd = summaryJson?.data?.summaryData ?? {};
      const pd = infoJson?.data?.primaryData ?? {};

      const result = {
        symbol: sym,
        companyName: infoJson?.data?.companyName ?? "N/A",
        marketStatus: infoJson?.data?.marketStatus ?? "N/A",
        source: referer,
        price: {
          lastSale: pd.lastSalePrice ?? "N/A",
          netChange: pd.netChange ?? "N/A",
          percentageChange: pd.percentageChange ?? "N/A",
          direction: pd.deltaIndicator ?? "N/A",
          lastTradeTimestamp: pd.lastTradeTimestamp ?? "N/A",
          previousClose: val(sd, "PreviousClose"),
          todayHighLow: val(sd, "TodayHighLow"),
          oneYearTarget: val(sd, "OneYrTarget"),
        },
        volume: {
          current: pd.volume ?? val(sd, "ShareVolume"),
          average: val(sd, "AverageVolume"),
        },
        range: {
          fiftyTwoWeekHighLow: val(sd, "FiftTwoWeekHighLow"),
        },
        marketCap: val(sd, "MarketCap"),
        dividendYield: val(sd, "Yield"),
        annualizedDividend: val(sd, "AnnualizedDividend"),
        exDividendDate: val(sd, "ExDividendDate"),
        insiderTransactions: {
          totalRecords: insiderJson?.data?.totalRecords ?? 0,
          recent: (insiderJson?.data?.rows ?? []).slice(0, 10).map((r) => ({
            reportingOwner: r.reportingOwner ?? "N/A",
            formType: r.formType ?? "N/A",
            filed: r.filed ?? "N/A",
            period: r.period ?? "N/A",
            filingUrl: r.view?.htmlLink ?? "N/A",
          })),
        },
        fetchedAt: new Date().toISOString(),
      };

      console.log(`[NASDAQ-MCP] Structured result for ${sym}:`, JSON.stringify(result, null, 2));

      // Store in cache
      cache.set(sym, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
      console.log(`[NASDAQ-MCP][cache] SET for ${sym} (TTL ${CACHE_TTL_MS / 1000}s)`);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error(`[NASDAQ-MCP][get_nasdaq_stock_data] Error for ${sym}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch NASDAQ data for ${sym}: ${message}` }],
      };
    }
  }
);

  server.tool(
  "search_nasdaq_ticker",
  {
    query: z.string().describe(
      "Company name or partial ticker to search on NASDAQ (e.g., 'Grab', 'Apple', 'AAP'). Returns matching ticker symbols and company names."
    ),
  },
  async ({ query }) => {
    console.log(`[NASDAQ-MCP][search_nasdaq_ticker] Executing — query: "${query}"`);
    try {
      const url = `https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          ...HEADERS,
          Referer: "https://www.nasdaq.com/",
        },
      });

      const json = (await res.json()) as {
        data?: Array<{ symbol?: string; name?: string; category?: string }>;
      };

      console.log(`[NASDAQ-MCP][search_nasdaq_ticker] Raw response for "${query}":`, JSON.stringify(json, null, 2));

      const rows = json?.data ?? [];
      const results = rows.slice(0, 5).map((r) => ({
        symbol: r.symbol ?? "N/A",
        name: r.name ?? "N/A",
        category: r.category ?? "N/A",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ query, results }, null, 2) }],
      };
    } catch (err) {
      console.error(`[NASDAQ-MCP][search_nasdaq_ticker] Error for "${query}":`, err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Search failed for "${query}": ${message}` }],
      };
    }
  }
);

  server.tool(
  "get_technical_analysis",
  {
    symbol: z.string().describe(
      "Stock ticker symbol listed on NASDAQ (e.g., NVDA, AAPL, MSFT). " +
      "Returns SMA-20/50/200, EMA-20, RSI-14, 60-day support/resistance, trend direction, and volume trend " +
      "computed from 1 year of daily OHLCV data."
    ),
  },
  async ({ symbol }) => {
    const sym = symbol.toUpperCase().trim();
    console.log(`[NASDAQ-MCP][get_technical_analysis] Executing — symbol: ${sym}`);
    try {
      const toDate   = new Date().toISOString().split("T")[0];
      const fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const url = `https://api.nasdaq.com/api/quote/${sym}/chart?assetclass=stocks&fromdate=${fromDate}&todate=${toDate}`;

      const res = await fetch(url, { headers: { ...HEADERS, Referer: buildReferer(sym) } });
      if (!res.ok) throw new Error(`NASDAQ chart API returned ${res.status} ${res.statusText} for ${sym}`);

      const json = (await res.json()) as {
        data?: { chart?: Array<{ x: number; y: number; z: { high: string; low: string; open: string; close: string; volume: string; dateTime: string } }> };
      };

      const raw = json?.data?.chart ?? [];
      if (raw.length < 20) throw new Error(`Insufficient chart data for ${sym} — only ${raw.length} candles`);

      const candles: Candle[] = raw.map((c) => ({
        date:   c.z.dateTime,
        open:   parseFloat(c.z.open),
        high:   parseFloat(c.z.high),
        low:    parseFloat(c.z.low),
        close:  parseFloat(c.z.close ?? String(c.y)),
        volume: parseInt(c.z.volume.replace(/,/g, ""), 10),
      }));

      const closes   = candles.map((c) => c.close);
      const last     = candles[candles.length - 1];
      const s20  = smaTech(closes, 20);
      const s50  = smaTech(closes, 50);
      const s200 = smaTech(closes, 200);
      const e20  = emaTech(closes, 20);
      const r14  = rsiTech(closes, 14);
      const { support, resistance } = pivotLevels(candles, 60);
      const r2 = (v: number | null) => v !== null ? Math.round(v * 100) / 100 : null;
      const pct = (price: number, ref: number | null) => ref !== null ? `${((price / ref - 1) * 100).toFixed(2)}%` : "N/A";

      const result = {
        symbol: sym,
        analysisDate: toDate,
        dataPoints: candles.length,
        currentPrice: last.close,
        lastCandleDate: last.date,
        movingAverages: {
          sma20:  r2(s20),  sma50: r2(s50),  sma200: r2(s200),  ema20: r2(e20),
          priceVsSma20:  pct(last.close, s20),
          priceVsSma50:  pct(last.close, s50),
          priceVsSma200: pct(last.close, s200),
        },
        momentum: {
          rsi14: r2(r14),
          rsiSignal: r14 === null ? "N/A" : r14 >= 70 ? "overbought" : r14 <= 30 ? "oversold" : "neutral",
        },
        supportResistance: {
          support60d: r2(support), resistance60d: r2(resistance),
          distanceFromSupport:    pct(last.close, support),
          distanceFromResistance: pct(last.close, resistance),
        },
        trend:       trendLabel(closes, s20, s50, s200),
        volumeTrend: volTrendLabel(candles),
        source: url,
      };

      console.log(`[NASDAQ-MCP][get_technical_analysis] Result for ${sym}:`, JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error(`[NASDAQ-MCP][get_technical_analysis] Error for ${sym}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Technical analysis failed for ${sym}: ${message}` }] };
    }
  }
);

  return server;
}

console.log("[NASDAQ-MCP] McpServer factory ready.");

const HTTP_PORT = parseInt(process.env.NASDAQ_MCP_PORT ?? "3002", 10);

// ─── CORS helper ────────────────────────────────────────────────────────────
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

// ─── Production HTTP MCP server ──────────────────────────────────────────────
async function startHttpServer(): Promise<void> {
  /**
   * Per-session transport map.
   * Key: Mcp-Session-Id header value (UUID).
   * Value: the StreamableHTTPServerTransport for that session.
   *
   * Industry standard: one McpServer instance shared, one transport per client session.
   */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    setCorsHeaders(res);

    // Handle CORS pre-flight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — used by index.ts startNasdaqMcpServer() to detect readiness
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp" }));
      return;
    }

    // ── POST /mcp ── initialize or invoke ────────────────────────────────────
    if (req.method === "POST") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        // Reuse existing session transport
        transport = sessions.get(sessionId)!;
        console.log(`[NASDAQ-MCP][HTTP] Reusing session ${sessionId}`);
      } else {
        // New session — create transport with UUID session ID generator
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            console.log(`[NASDAQ-MCP][HTTP] Session created: ${id} (total: ${sessions.size})`);
          },
        });

        // Clean up session map when transport closes
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            sessions.delete(id);
            console.log(`[NASDAQ-MCP][HTTP] Session closed: ${id} (remaining: ${sessions.size})`);
          }
        };

        // Each session gets its own McpServer instance — avoids 'Already connected' error
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res);
      return;
    }

    // ── GET /mcp ── SSE channel for server-initiated messages ─────────────────
    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id" }));
        return;
      }
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // ── DELETE /mcp ── explicit session termination ───────────────────────────
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.close();
        sessions.delete(sessionId);
        console.log(`[NASDAQ-MCP][HTTP] Session terminated by client: ${sessionId}`);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`[NASDAQ-MCP] HTTP server listening on http://localhost:${HTTP_PORT}/mcp`);
  });
}

async function main() {
  const useHttp = process.argv.includes("--http");

  if (useHttp) {
    await startHttpServer();
  } else {
    // Stdio mode (default) — spawned as child process by NasdaqMcpClientFactory
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
    console.log("[NASDAQ-MCP] Server connected via stdio — ready to handle tool calls.");
  }
}

main().catch((err) => {
  console.error("[NASDAQ-MCP] Fatal error:", err);
  process.exit(1);
});
