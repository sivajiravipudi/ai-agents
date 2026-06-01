# ai-agents
This uses multiple LLM providers and different AI framework
# AI Agents — NASDAQ Stock Market Assistant

A production-grade AI agent built with the **AWS Strands TypeScript SDK**, **OpenAI**, and a custom **NASDAQ MCP server** — with a React chat frontend. The system answers natural language questions about stock prices, fundamentals, insider transactions, and technical analysis in real time.

---

## Project Structure

```
ai-agents/
├── src/
│   ├── index.ts                          # Express server entry point (port 3001)
│   ├── middleware/
│   │   └── requestLogger.ts              # Per-request tracing — X-Request-ID + structured logs
│   ├── routes/
│   │   ├── askRoute.ts                   # POST /api/ask — single-turn Q&A
│   │   ├── streamRoute.ts                # POST /api/stream — SSE streaming with ReAct steps
│   │   ├── historyRoute.ts               # GET /api/history — per-session conversation history
│   │   └── metricsRoute.ts               # GET /api/metrics — observability snapshot
│   ├── services/
│   │   ├── AgentService.ts               # Outer ReAct agent — routes questions to sub-agents
│   │   └── StockAgentService.ts          # Inner stock analyst agent — delegates to MCP tools
│   ├── providers/
│   │   └── OpenAIProvider.ts             # OpenAI model factory (gpt-4o by default)
│   ├── mcp/
│   │   ├── nasdaq-mcp-server.ts          # Standalone HTTP MCP server (port 3002)
│   │   └── NasdaqMcpClientFactory.ts     # MCP session manager (NasdaqMcpSession)
│   └── utils/
│       ├── logger.ts                     # Timestamped console logger
│       ├── cache.ts                      # In-memory response cache (NodeCache, 5 min TTL)
│       ├── metrics.ts                    # In-process observability counters (tokens, latency, errors)
│       └── SessionStore.ts               # Per-session agent + conversation history store (TTL eviction)
└── client/
    └── src/
        ├── App.tsx                       # React chat UI with SSE streaming
        ├── main.tsx                      # React entry point
        └── styles.css                    # Dark-theme styles
```

---

## Component Descriptions

### `src/index.ts` — Application Entry Point
Bootstraps the Express server on port 3001. On startup it:
1. Polls the NASDAQ MCP health endpoint (`http://localhost:3002/health`) to confirm the MCP server is ready.
2. Initialises `AgentService` (outer agent) and `StockAgentService` (inner stock agent).
3. Wires the stock agent as a delegatable `stock_market_analyst` tool on the outer agent.
4. Registers routes and starts listening.

---

### `src/mcp/nasdaq-mcp-server.ts` — NASDAQ MCP Server
A standalone HTTP MCP server running on port 3002. It exposes three tools:

| Tool | What it fetches | NASDAQ API used |
|------|----------------|-----------------|
| `get_nasdaq_stock_data` | Live price, volume, 52-week range, dividends, insider transactions (SEC Form 3/4) | `quote/{sym}/summary`, `quote/{sym}/info`, `company/{sym}/sec-filings` |
| `search_nasdaq_ticker` | Ticker symbol lookup by company name | `autocomplete/slookup` |
| `get_technical_analysis` | SMA-20/50/200, EMA-20, RSI-14, 60-day support/resistance, trend direction, volume trend | `quote/{sym}/chart` (1 year of daily OHLCV) |

All data is fetched from `api.nasdaq.com` — the same endpoints the NASDAQ website uses internally. A 5-minute in-memory cache prevents redundant API calls per symbol.

The server uses `StreamableHTTPServerTransport` (one MCP server instance per HTTP session) to avoid the "Already connected to a transport" error.

---

### `src/mcp/NasdaqMcpClientFactory.ts` — MCP Session Manager
Exports `NasdaqMcpSession` — a production-grade session manager that:
- Holds **one persistent MCP client** per application lifecycle (no new handshake per request).
- **Reuses the same session ID** across all requests.
- **Reconnects transparently** on transport/session errors — callers never see the interruption.

---

### `src/services/StockAgentService.ts` — Stock Analyst Agent
An inner Strands `Agent` whose only tools are the three NASDAQ MCP tools. It:
- Connects to the NASDAQ MCP server via `NasdaqMcpSession`.
- Exposes itself as a single `stock_market_analyst` tool (via `agent.asTool()`) for the outer `AgentService` to call.
- Handles session reconnect and agent rebuild transparently.

---

### `src/services/AgentService.ts` — Outer Orchestration Agent
The top-level Strands `Agent` that receives all user questions. It:
- Has `stock_market_analyst` registered as its only tool.
- Runs the **ReAct loop** (Reason → Act → Observe → Respond) via `agent.stream()`.
- Supports **per-session conversation history** using `SessionStore`.
- Emits SSE events (`thinking`, `tool_call`, `tool_result`, `tool_error`, `text_delta`, `token_usage`, `final`, `error`) for the frontend.
- Detects and classifies MCP failures (`tool_error` event) separately from LLM errors so the frontend shows actionable messages.
- Records per-request token usage, tool call counts, latency, and error types into `metrics`.

---

### `src/middleware/requestLogger.ts` — Request Tracing
Attaches a `X-Request-ID` UUID to every request (or reuses a client-provided one). Logs structured ingress and egress lines with method, path, IP, status code, and duration. The request ID is threaded through all `AgentService` log lines so any request can be fully traced end to end.

---

### `src/routes/` — HTTP Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/ask` | POST | Single-turn Q&A, returns `{ answer }` |
| `/api/stream` | POST | SSE stream — emits ReAct steps in real time |
| `/api/history` | GET | Returns conversation turns for a session ID |
| `/api/metrics` | GET | Observability snapshot — tokens, latency, errors, cache stats |
| `/health` | GET | Backend health check |

---

### `src/utils/` — Utilities

| Utility | Description |
|---------|-------------|
| `cache.ts` | In-memory `NodeCache` — caches LLM answers for 5 min by question text |
| `metrics.ts` | In-process counters for tokens, tool calls, latency (p50/p95/p99), errors, cache hit rate, memory |
| `SessionStore.ts` | Per-session `Agent` instances + conversation history with TTL eviction (default 30 min idle) |
| `logger.ts` | Timestamped `[INFO]` / `[WARN]` / `[ERROR]` console logger |

---

### `client/` — React Frontend
A Vite + React chat UI (port 3000) that:
- Sends questions to `/api/stream` and renders SSE events progressively.
- Shows **reasoning steps** (tool calls, tool results, LLM thinking) as they arrive.
- Maintains conversation history per browser session.

---

## How the Agent Loop Works (ReAct)

```
User: "What is the technical analysis for NVDA?"
        │
        ▼
AgentService (port 3001)
  LLM decides → call stock_market_analyst
        │
        ▼
StockAgentService (inner agent)
  LLM decides → call get_technical_analysis("NVDA")
        │  JSON-RPC POST → http://localhost:3002/mcp
        ▼
nasdaq-mcp-server (port 3002)
  Fetches 1 year OHLCV from api.nasdaq.com/api/quote/NVDA/chart
  Computes SMA-20/50/200, EMA-20, RSI-14, support/resistance
        │  Returns structured JSON
        ▼
StockAgentService LLM synthesises analysis
        │  Returns natural language answer
        ▼
AgentService returns final answer to user
```

---

## Prerequisites

- **Node.js 20+**
- **npm 9+**
- An **OpenAI API key**

---

## Step-by-Step Build & Run

### Step 1 — Clone and install dependencies

```bash
git clone <repo-url>
cd ai-agents

# Install backend dependencies
npm install

# Install frontend dependencies
npm install --prefix client
```

### Step 2 — Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
OPENAI_API_KEY=sk-...                      # Required — your OpenAI API key
PORT=3001                                  # Optional — backend port (default: 3001)
NASDAQ_MCP_URL=http://localhost:3002/mcp   # Optional — MCP server URL
CACHE_TTL=300                              # Optional — response cache TTL in seconds (default: 300)
AGENT_MAX_ITERATIONS=5                     # Optional — max tool calls per request (default: 5)
RATE_LIMIT_PER_MINUTE=60                   # Optional — max API requests per IP per minute (default: 60)
SESSION_TTL_MS=1800000                     # Optional — session inactivity expiry in ms (default: 30 min)
```

### Step 3 — Start the NASDAQ MCP server (Terminal 1)

The MCP server **must be running before the backend starts**.

```bash
npm run mcp
# → [NASDAQ-MCP] HTTP server listening on http://localhost:3002/mcp
```

This starts `nasdaq-mcp-server.ts` in watch mode (auto-restarts on file changes). The server exposes three tools over HTTP on port 3002.

### Step 4 — Start the backend (Terminal 2)

```bash
npm run dev
# → Server listening on http://localhost:3001
```

On startup the backend polls `http://localhost:3002/health` to confirm the MCP server is ready, then initialises both agents.

### Step 5 — Start the frontend (Terminal 3)

```bash
npm run client
# → React app at http://localhost:3000
```

Open **http://localhost:3000** in your browser.

---

## Example Questions

```
"What is the current price of NVDA?"
"Show me the technical analysis for AAPL"
"Who has been selling TSLA stock recently? (insider transactions)"
"What is the 52-week range and market cap of MSFT?"
"Find the ticker symbol for Grab Holdings"
"Is NVDA overbought based on RSI?"
```

---

## API Reference

### `POST /api/ask`
Single-turn question, waits for full answer.
```json
// Request
{ "question": "What is the PE ratio of AAPL?" }

// Response
{ "answer": "Apple's trailing PE ratio is 32.4x..." }
```

### `POST /api/stream`
SSE stream — emits ReAct reasoning steps in real time.
```json
// Request
{ "question": "Technical analysis for NVDA", "sessionId": "abc123" }

// SSE events emitted:
// event: thinking     { "message": "🧠 LLM decided to call: stock_market_analyst" }
// event: tool_call    { "name": "get_technical_analysis", "input": { "symbol": "NVDA" } }
// event: tool_result  { "name": "get_technical_analysis", "result": "{ ... }", "isError": false }
// event: tool_error   { "name": "get_nasdaq_stock_data", "error": "...", "message": "⚠️ Tool reported an error..." }
// event: token_usage  { "promptTokens": 1240, "completionTokens": 380, "totalTokens": 1620 }
// event: text_delta   { "text": "Based on the technical analysis..." }
// event: final        { "answer": "...", "success": true }
// event: error        { "type": "mcp|quota|timeout|general|empty", "message": "...", "details": "..." }
```

### `GET /api/history?sessionId=abc123`
Returns conversation turns for the given session.

### `GET /health`
```json
{ "status": "ok", "agents": ["general"] }
```

### `GET http://localhost:3002/health` (MCP server)
```json
{ "status": "ok" }
```

---

## Caching

Two levels of caching:

| Layer | Where | TTL | Key |
|-------|-------|-----|-----|
| **LLM response cache** | `AgentService` (NodeCache) | 5 min | Full question text |
| **NASDAQ data cache** | `nasdaq-mcp-server` (Map) | 5 min | Ticker symbol |

Repeated identical questions skip the LLM entirely. Repeated MCP calls for the same ticker within 5 minutes return cached NASDAQ data.

---

## Rate Limiting

All `/api/*` routes are protected by `express-rate-limit` — **60 requests per minute per IP** by default (configurable via `RATE_LIMIT_PER_MINUTE`). Exceeding the limit returns:

```json
HTTP 429 Too Many Requests
{ "error": "Too many requests — please wait a moment and try again." }
```

The `/health` endpoint is excluded from rate limiting.

---

## Observability — `GET /api/metrics`

Returns a live in-process snapshot. No external dependencies required.

```json
{
  "uptimeSeconds": 3600,
  "requests": { "total": 142, "ask": 12, "stream": 130 },
  "cache": { "hits": 87, "misses": 55, "hitRatePct": 61 },
  "tokens": { "promptTokens": 48200, "completionTokens": 9100, "totalTokens": 57300 },
  "toolCalls": { "stock_market_analyst": 98, "get_nasdaq_stock_data": 76, "get_technical_analysis": 22 },
  "errors": { "total": 3, "byType": { "mcp": 2, "quota": 1 } },
  "latencyMs": { "avg": 2340, "p50": 1980, "p95": 5120, "p99": 8400 },
  "sessions": { "active": 7 },
  "memory": { "heapUsedMB": 124, "heapTotalMB": 180, "rssMB": 210 }
}
```

---

## Request Tracing

Every request is assigned a `X-Request-ID` (UUID). It is:
- Returned as a response header for client-side correlation.
- Prefixed on every log line emitted during that request's lifecycle.

Example correlated log output for a single stream request:
```
[abc-123] → POST /api/stream — IP: 127.0.0.1
[abc-123] Stream request — invoking agent for: "Technical analysis for NVDA..."
[abc-123] → Tool call [1/5]: stock_market_analyst
[abc-123] → Tool call [1/5]: get_technical_analysis
[abc-123] ← Tool get_technical_analysis returned 1842 chars
[abc-123] Token usage — prompt: 1240, completion: 380, total: 1620
[abc-123] Stream completed in 3241ms — error: false, errorType: none
[abc-123] ← 200 POST /api/stream — 3245ms
```

---

## Component Responsibility Summary

| Component | Single Responsibility |
|-----------|----------------------|
| `nasdaq-mcp-server.ts` | Serve NASDAQ stock data as MCP tools over HTTP |
| `NasdaqMcpClientFactory.ts` | Manage one persistent MCP session with auto-reconnect |
| `StockAgentService` | Inner stock analyst agent — wraps MCP tools, exposes as `stock_market_analyst` |
| `AgentService` | Outer orchestrator — routes user questions, manages sessions, streams SSE events, collects metrics |
| `OpenAIProvider` | Create the OpenAI model instance |
| `requestLogger` | Attach `X-Request-ID` and emit structured ingress/egress log lines |
| `askRoute` | Validate HTTP input for single-turn requests |
| `streamRoute` | Manage SSE connection and forward agent events to client |
| `historyRoute` | Serve per-session conversation history |
| `metricsRoute` | Expose live observability snapshot |
| `metrics.ts` | Accumulate token usage, tool call counts, latency percentiles, error counts, memory stats |
| `SessionStore` | Store per-session agent instances and conversation turns with TTL eviction |
| `cache` | In-memory LLM response cache (no database) |
| `logger` | Formatted, timestamped console logging |
| `App.tsx` | React chat UI — renders SSE events as progressive reasoning steps |

