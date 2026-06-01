/**
 * /api/stream route handler — SSE streaming of ReAct reasoning steps.
 *
 * Streams agent events: reasoning, tool calls, tool results, and final answer.
 */

import { Router, type Request, type Response } from "express";
import { agentService, type LLMProvider } from "../services/AgentService.js";
import { logger } from "../utils/logger.js";

export const streamRouter = Router();

streamRouter.post("/", async (req: Request, res: Response) => {
  const { question, sessionId, provider } = req.body as { question?: string; sessionId?: string; provider?: string };
  const llmProvider: LLMProvider = provider === "gemini" ? "gemini" : "openai";

  if (!question || typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "Field 'question' is required." });
    return;
  }

  const cleanQuestion = question.trim();
  logger.info(`POST /api/stream — "${cleanQuestion.slice(0, 60)}"`);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering if applicable
  res.flushHeaders(); // Send headers immediately so browser opens the stream

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Flush each event immediately to the client
    if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  try {
    await agentService.streamWithReasoning(
      cleanQuestion,
      (event, data) => sendEvent(event, data),
      sessionId?.trim() || undefined,
      req.requestId,
      llmProvider
    );
    sendEvent("done", {});
  } catch (err) {
    logger.error("Streaming error:", err);
    sendEvent("error", { message: err instanceof Error ? err.message : "Unknown error" });
  } finally {
    res.end();
  }
});
