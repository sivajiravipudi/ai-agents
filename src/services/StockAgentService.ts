/**
 * StockAgentService — specialized agent for market data analysis.
 *
 * Single responsibility: analyse stock tickers using MCP tools that fetch
 * real-time price, volume, PE ratio, fundamentals, and news context, then
 * synthesise an investment perspective via OpenAI.
 *
 * ReAct loop (managed by Strands):
 *   1. THINK  → Agent plans which tools to call (quote, fundamentals, news).
 *   2. ACT    → MCP server executes the Yahoo Finance API calls.
 *   3. OBSERVE→ Tool results fed back as context to the LLM.
 *   4. RESPOND→ LLM synthesises price + volume + PE + opportunities narrative.
 */

import { Agent } from "@strands-agents/sdk";
import type { Tool } from "@strands-agents/sdk";
import { createOpenAIProvider } from "../providers/OpenAIProvider.js";
import { NasdaqMcpSession } from "../mcp/NasdaqMcpClientFactory.js";
import { logger } from "../utils/logger.js";

const TOOL_NAME = "stock_market_analyst";
const TOOL_DESC =
  "Use this tool for ANY question about stock prices, market data, fundamentals, " +
  "PE ratios, EPS, 52-week range, trading volume, market cap, dividends, insider trading, or SEC filings. " +
  "Input: a natural language question or instruction mentioning a stock ticker or company name. " +
  "Examples: 'What is the current price of AAPL?', 'Get fundamentals for NVDA', " +
  "'Show me insider transactions for TSLA', 'Who has been buying or selling NVDA stock?'.";

const SYSTEM_PROMPT = `You are a market analyst assistant with access to real-time stock data tools.

Tool selection rules — call ONLY the minimum tools needed to answer the question:
- Question about price, volume, market cap, daily change, PE ratio, EPS, fundamentals, insider trading, SEC filings, or any stock details → call get_nasdaq_stock_data.
- Question about finding a ticker symbol or company name → call search_nasdaq_ticker.
- NEVER call multiple tools for the same symbol.

Response guidelines:
- Cite specific numbers from the tool response (e.g., "PE of 28.4x").
- If a field is null or missing, display "N/A" — do NOT claim a technical issue.
- If the tool returns an error message, quote the exact error text — do NOT say "temporary technical issue".
- NEVER say "I can't access" — always show the raw tool data or the specific error.
- Keep the response focused on what was asked; do not pad with unrequested sections.`;

export class StockAgentService {
  /**
   * One persistent MCP session per application lifecycle.
   * The session holds the transport + MCP session ID.
   * All requests reuse the same session — no new handshake per request.
   * On transport error, session.reconnect() issues a fresh MCP initialize
   * and gets a new session ID transparently.
   */
  private readonly session = new NasdaqMcpSession();
  private agent: Agent | null = null;

  async initialize(): Promise<void> {
    logger.info("Initialising StockAgentService...");
    await this.buildAgent();
    logger.info("StockAgentService ready — session established, tools: get_nasdaq_stock_data, search_nasdaq_ticker.");
  }

  /**
   * Connect the session and build the Agent with the live McpClient.
   * Called at startup and after a session error (reconnect path).
   */
  private async buildAgent(): Promise<void> {
    const client = await this.session.connect();
    this.agent = new Agent({
      model: createOpenAIProvider(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [client],
    });
  }

  /**
   * Expose this agent as a delegatable tool for AgentService.
   *
   * The returned Tool uses the current live session.
   * If a transport/session error occurs mid-call, session.reconnect()
   * issues a new MCP initialize transparently and the next call succeeds.
   */
  asTool(): Tool {
    if (!this.agent) {
      throw new Error("StockAgentService has not been initialised. Call initialize() first.");
    }
    return this.agent.asTool({ name: TOOL_NAME, description: TOOL_DESC });
  }

  /**
   * Reconnect the MCP session and rebuild the agent.
   * Called externally (e.g., AgentService) when a transport error is detected.
   * After this, re-register the new asTool() result on AgentService.
   */
  async reconnect(): Promise<void> {
    await this.session.reconnect();
    await this.buildAgent();
    logger.info("StockAgentService reconnected — new session established.");
  }

  async dispose(): Promise<void> {
    await this.session.disconnect();
  }
}

export const stockAgentService = new StockAgentService();
