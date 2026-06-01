/**
 * AgentService — the heart of the ReAct agent loop.
 *
 * Single responsibility: initialise the Strands Agent with an OpenAI model
 * and MCP tools, then serve questions through the agent's reasoning loop.
 *
 * ─────────────────────────────────────────────────────────────
 *  HOW THE AGENT LOOP WORKS (ReAct pattern)
 * ─────────────────────────────────────────────────────────────
 *
 *  User question
 *       │
 *       ▼
 *  ┌─────────────────────────────────┐
 *  │  1. THINK                       │
 *  │  LLM reasons about what to do.  │
 *  │  It may decide to call a tool.  │
 *  └──────────────┬──────────────────┘
 *                 │ tool_call
 *                 ▼
 *  ┌─────────────────────────────────┐
 *  │  2. ACT                         │
 *  │  Strands invokes the MCP tool   │
 *  │  and captures the result.       │
 *  └──────────────┬──────────────────┘
 *                 │ tool_result
 *                 ▼
 *  ┌─────────────────────────────────┐
 *  │  3. OBSERVE                     │
 *  │  Tool result is fed back to the │
 *  │  LLM as context.                │
 *  └──────────────┬──────────────────┘
 *                 │ loop until no more tool calls
 *                 ▼
 *  ┌─────────────────────────────────┐
 *  │  4. RESPOND                     │
 *  │  LLM produces the final answer  │
 *  │  in natural language.           │
 *  └─────────────────────────────────┘
 *
 *  Strands manages steps 1-4 automatically via agent.invoke().
 * ─────────────────────────────────────────────────────────────
 */

import {
  Agent,
  type BeforeToolCallEvent,
  type AfterToolCallEvent,
  type ContentBlockEvent,
  type ModelStreamUpdateEvent,
  type ModelMessageEvent,
  type AgentResultEvent,
  type BeforeToolsEvent,
} from "@strands-agents/sdk";
import { createOpenAIProvider } from "../providers/OpenAIProvider.js";
import { createGoogleProvider } from "../providers/GoogleProvider.js";
import { getCachedResponse, setCachedResponse } from "../utils/cache.js";
import { sessionStore } from "../utils/SessionStore.js";
import { metrics } from "../utils/metrics.js";
import { logger } from "../utils/logger.js";

export type LLMProvider = "openai" | "gemini";

function createModelForProvider(provider: LLMProvider) {
  switch (provider) {
    case "gemini": return createGoogleProvider();
    case "openai":
    default:        return createOpenAIProvider();
  }
}

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to the stock_market_analyst tool.

ALWAYS use stock_market_analyst when the user asks about:
- Stock prices (e.g. "What is AAPL stock price?")
- Market fundamentals (PE ratio, EPS, price-to-book, 52-week range, moving averages)
- Trading volume or market cap
- Dividends or financial news for a company or ticker
Pass the user's question directly as the input to stock_market_analyst.

Always respond in clear, friendly natural language.`;

export class AgentService {
  private agent: Agent | null = null;
  private stockTool: import("@strands-agents/sdk").Tool | null = null;
  private currentProvider: LLMProvider = "openai";

  /** Initialise the model provider and Strands Agent. */
  async initialize(provider: LLMProvider = "openai"): Promise<void> {
    logger.info(`Initialising AgentService with provider: ${provider}`);
    this.currentProvider = provider;

    const model = createModelForProvider(provider);

    this.agent = new Agent({
      model,
      systemPrompt: SYSTEM_PROMPT,
      // stock_market_analyst tool registered after StockAgentService is ready via registerStockTool()
    });

    if (this.stockTool) {
      this.agent.toolRegistry.add(this.stockTool);
    }

    logger.info("AgentService ready.");
  }

  /** Rebuild the agent with a different provider without losing registered tools. */
  private async rebuildWithProvider(provider: LLMProvider): Promise<void> {
    logger.info(`Switching provider: ${this.currentProvider} → ${provider}`);
    await this.initialize(provider);
  }

  /**
   * Register the StockAgentService as a delegatable tool on this agent.
   * Must be called after BOTH AgentService and StockAgentService are initialized.
   */
  registerStockTool(stockTool: import("@strands-agents/sdk").Tool): void {
    if (!this.agent) {
      throw new Error("AgentService has not been initialised. Call initialize() first.");
    }
    this.stockTool = stockTool;
    this.agent.toolRegistry.add(stockTool);
    logger.info("Registered stock_market_analyst as a delegatable tool on AgentService.");
  }

  /**
   * Ask the agent a question.
   *
   * 1. Check the in-memory cache for a previously computed answer.
   * 2. If not cached, run the full ReAct agent loop via agent.invoke().
   * 3. Store the answer in cache before returning.
   */
  async ask(question: string): Promise<string> {
    if (!this.agent) {
      throw new Error("AgentService has not been initialised. Call initialize() first.");
    }

    metrics.incrementRequest("ask");
    const startTime = Date.now();

    const cached = getCachedResponse(question);
    if (cached) {
      metrics.incrementCacheHit();
      metrics.recordLatency(Date.now() - startTime);
      logger.info(`Cache HIT for: "${question.slice(0, 60)}..."`);
      return cached;
    }
    metrics.incrementCacheMiss();

    logger.info(`Cache MISS — invoking agent for: "${question.slice(0, 60)}..."`);

    const result = await this.agent.invoke(question);

    // AgentResult.toString() concatenates all text/reasoning blocks from the last message.
    const answer = result.toString();

    setCachedResponse(question, answer);
    return answer;
  }

  /**
   * Stream the agent's reasoning process (ReAct steps) via SSE.
   *
   * This method uses agent.stream() to capture intermediate events:
   * - reasoning: The LLM's thought process
   * - tool_call: When a tool is being invoked
   * - tool_result: The result from the tool execution
   * - text: Text content generated by the LLM
   * - final: The complete final answer
   */
  async streamWithReasoning(
    question: string,
    onEvent: (event: string, data: unknown) => void,
    sessionId?: string,
    requestId?: string,
    provider: LLMProvider = "openai"
  ): Promise<void> {
    if (!this.agent) {
      throw new Error("AgentService has not been initialised. Call initialize() first.");
    }

    // Rebuild the shared agent if the client switched providers
    if (provider !== this.currentProvider) {
      await this.rebuildWithProvider(provider);
    }

    metrics.incrementRequest("stream");
    const startTime = Date.now();
    const rid = requestId ?? "no-rid";

    // Resolve the agent to use: session-scoped (with history) or the shared agent
    let sessionAgent = this.agent;
    if (sessionId) {
      let session = sessionStore.get(sessionId);
      if (!session) {
        // New session: clone a fresh Agent seeded with the same model, prompt, and stock tool
        const model = createOpenAIProvider();
        const freshAgent = new Agent({
          model,
          systemPrompt: SYSTEM_PROMPT,
        });
        // Copy registered tools (including stock_market_analyst) to the session agent
        for (const tool of this.agent.tools) {
          freshAgent.toolRegistry.add(tool);
        }
        session = sessionStore.set(sessionId, freshAgent);
        logger.info(`[${rid}] New session created: ${sessionId}`);
      } else {
        logger.info(`[${rid}] Resuming session: ${sessionId} (${session.turns.length} prior turns)`);
      }
      sessionAgent = session.agent;
    }

    const cached = getCachedResponse(question);
    if (cached) {
      metrics.incrementCacheHit();
      onEvent("cache_hit", { answer: cached });
      onEvent("final", { answer: cached });
      metrics.recordLatency(Date.now() - startTime);
      return;
    }
    metrics.incrementCacheMiss();

    logger.info(`[${rid}] Stream request — invoking agent for: "${question.slice(0, 60)}..."`);

    // Get list of available tools from the session agent's tool registry
    const toolNames = sessionAgent.tools.map(t => t.name);
    onEvent("tools_list", { tools: toolNames });
    logger.info(`[${rid}] Available tools: ${toolNames.join(", ")}`);

    const accumulator: string[] = [];
    const toolsUsed: string[] = [];
    let hasError = false;
    let errorType: "timeout" | "quota" | "mcp" | "general" | "empty" = "general";

    const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS ?? "5", 10);
    let iterationCount = 0;

    try {
      for await (const event of sessionAgent.stream(question)) {
        logger.debug(`[${rid}] Agent event: ${event.type}`);

        switch (event.type) {
          case "modelStreamUpdateEvent": {
            const streamEvent = (event as ModelStreamUpdateEvent).event;
            if (streamEvent.type === "modelContentBlockDeltaEvent") {
              const delta = streamEvent.delta;
              if (delta.type === "textDelta" && delta.text) {
                accumulator.push(delta.text);
                onEvent("text_delta", { text: delta.text });
              }
            }
            break;
          }
          case "contentBlockEvent": {
            const block = (event as ContentBlockEvent).contentBlock;
            if (block.type === "textBlock" && block.text) {
              if (!accumulator.join("").includes(block.text)) {
                accumulator.push(block.text);
              }
              onEvent("text", { text: block.text });
            }
            break;
          }
          case "beforeToolCallEvent": {
            const { name: toolName, input: toolInput } = (event as BeforeToolCallEvent).toolUse;
            iterationCount++;
            if (iterationCount > MAX_ITERATIONS) {
              throw new Error(
                `Agent exceeded the maximum of ${MAX_ITERATIONS} tool calls. ` +
                `The query may be too complex or the agent is stuck in a loop.`
              );
            }
            if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
            metrics.incrementToolCall(toolName);
            logger.info(`[${rid}] → Tool call [${iterationCount}/${MAX_ITERATIONS}]: ${toolName}`);
            onEvent("active_tool", { name: toolName, status: "executing", message: `🔧 Executing tool: ${toolName}...` });
            onEvent("tool_call", { name: toolName, input: toolInput });
            break;
          }
          case "afterToolCallEvent": {
            const e = event as AfterToolCallEvent;
            const toolName = e.toolUse.name;
            const resultContent = e.result.content
              .map((c) => (c.type === "textBlock" ? c.text : ""))
              .filter(Boolean)
              .join("\n");

            // Detect MCP-level failures (isError flag on tool result)
            const isMcpError = (e.result as { isError?: boolean }).isError === true;
            if (isMcpError) {
              logger.warn(`[${rid}] ← MCP tool ${toolName} returned an error: ${resultContent.slice(0, 200)}`);
              metrics.incrementError("mcp");
              onEvent("tool_error", {
                name: toolName,
                error: resultContent,
                message: `⚠️ Tool "${toolName}" reported an error — the agent will attempt to continue or report N/A.`,
              });
            } else {
              logger.info(`[${rid}] ← Tool ${toolName} returned ${resultContent.length} chars`);
            }
            onEvent("tool_result", { name: toolName, result: resultContent, isError: isMcpError });
            break;
          }
          case "beforeToolsEvent": {
            const toolUseBlocks = (event as BeforeToolsEvent).message.content
              .filter((c) => c.type === "toolUseBlock")
              .map((c) => (c.type === "toolUseBlock" ? c.name : ""))
              .filter(Boolean);
            const names = toolUseBlocks.length > 0 ? toolUseBlocks.join(", ") : "tools";
            onEvent("thinking", { message: `🧠 LLM decided to call: ${names}` });
            break;
          }
          case "afterToolsEvent": {
            onEvent("thinking", { message: "✓ Tool execution completed — feeding results to LLM" });
            break;
          }
          case "modelMessageEvent": {
            const e = event as ModelMessageEvent;
            logger.debug(`[${rid}] Model stop reason: ${e.stopReason}`);

            // Capture token usage if the SDK exposes it on the message
            const msg = e.message as unknown as { usage?: { input_tokens?: number; output_tokens?: number } };
            if (msg.usage) {
              const promptTokens     = msg.usage.input_tokens  ?? 0;
              const completionTokens = msg.usage.output_tokens ?? 0;
              metrics.addTokenUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
              logger.info(`[${rid}] Token usage — prompt: ${promptTokens}, completion: ${completionTokens}, total: ${promptTokens + completionTokens}`);
              onEvent("token_usage", { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
            }

            if (e.stopReason === "endTurn") {
              for (const block of e.message.content) {
                if (block.type === "textBlock" && block.text) {
                  if (!accumulator.join("").includes(block.text)) {
                    accumulator.push(block.text);
                  }
                }
              }
            }
            break;
          }
          case "agentResultEvent": {
            const agentResult = (event as AgentResultEvent).result;
            const finalText = agentResult.toString();
            if (finalText && !accumulator.join("").trim()) {
              accumulator.push(finalText);
            }
            break;
          }
          default:
            logger.debug(`[${rid}] Unhandled event type: ${event.type}`);
        }
      }

    } catch (err) {
      hasError = true;
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[${rid}] Agent streaming error:`, errorMessage);

      const isTimeout   = errorMessage.toLowerCase().includes("exceeded the maximum");
      const isQuota     = errorMessage.toLowerCase().includes("quota") ||
                          errorMessage.toLowerCase().includes("rate limit") ||
                          errorMessage.toLowerCase().includes("insufficient") ||
                          errorMessage.toLowerCase().includes("billing");
      const isMcpFault  = errorMessage.toLowerCase().includes("mcp") ||
                          errorMessage.toLowerCase().includes("transport") ||
                          errorMessage.toLowerCase().includes("session");

      if (isTimeout) {
        errorType = "timeout";
        metrics.incrementError("timeout");
        onEvent("error", { type: "timeout", message: `⏱️ ${errorMessage}`, details: errorMessage });
      } else if (isQuota) {
        errorType = "quota";
        metrics.incrementError("quota");
        onEvent("error", {
          type: "quota",
          message: "❌ OpenAI quota exceeded or rate limited. Check your billing settings.",
          details: errorMessage,
        });
      } else if (isMcpFault) {
        errorType = "mcp";
        metrics.incrementError("mcp");
        onEvent("error", {
          type: "mcp",
          message: "❌ The NASDAQ data service is temporarily unreachable. Please ensure the MCP server is running (`npm run mcp`) and try again.",
          details: errorMessage,
        });
      } else {
        errorType = "general";
        metrics.incrementError("general");
        onEvent("error", { type: "general", message: `❌ Error: ${errorMessage}`, details: errorMessage });
      }
    }

    const durationMs = Date.now() - startTime;
    metrics.recordLatency(durationMs);
    logger.info(`[${rid}] Stream completed in ${durationMs}ms — error: ${hasError}, errorType: ${hasError ? errorType : "none"}`);

    if (!hasError) {
      const finalAnswer = accumulator.join("");
      if (finalAnswer.trim()) {
        setCachedResponse(question, finalAnswer);
        if (sessionId) {
          sessionStore.addTurn(sessionId, {
            question,
            answer: finalAnswer,
            timestamp: Date.now(),
            toolsUsed,
          });
        }
        onEvent("final", { answer: finalAnswer, success: true });
      } else {
        metrics.incrementError("empty");
        onEvent("error", {
          type: "empty",
          message: "❌ No response generated. The agent returned an empty answer.",
        });
      }
    }
  }

  async dispose(): Promise<void> {
    logger.info("AgentService disposed.");
  }
}

export const agentService = new AgentService();
