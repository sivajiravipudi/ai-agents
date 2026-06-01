/**
 * /api/stream-crewai — SSE proxy to the CrewAI Python microservice.
 *
 * Forwards the question to http://localhost:3003/stream and pipes
 * the SSE response back to the frontend unchanged.
 * The Python service runs the two-agent CrewAI crew independently.
 */

import { Router, type Request, type Response } from "express";
import { logger } from "../utils/logger.js";
import { metrics } from "../utils/metrics.js";

export const crewaiRouter = Router();

const CREWAI_URL = process.env.CREWAI_URL ?? "http://localhost:3003";

crewaiRouter.post("/", async (req: Request, res: Response) => {
  const { question, provider } = req.body as { question?: string; provider?: string };

  if (!question || typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "Field 'question' is required." });
    return;
  }

  const cleanQuestion = question.trim();
  const llmProvider = provider === "gemini" ? "gemini" : "openai";
  const rid = req.requestId ?? "no-rid";
  logger.info(`[${rid}] POST /api/stream-crewai — proxying to CrewAI service`);
  metrics.incrementRequest("stream");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const startTime = Date.now();

  try {
    const upstream = await fetch(`${CREWAI_URL}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: cleanQuestion, provider: llmProvider }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "Unknown error");
      logger.error(`[${rid}] CrewAI service error ${upstream.status}: ${errText}`);
      res.write(`event: error\ndata: ${JSON.stringify({ type: "mcp", message: "❌ CrewAI service returned an error. Is it running? (npm run crewai)", details: errText })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`[${rid}] CrewAI proxy error:`, msg);

    const isUnreachable = msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
    res.write(
      `event: error\ndata: ${JSON.stringify({
        type: "mcp",
        message: isUnreachable
          ? "❌ CrewAI service is not running. Start it with: npm run crewai"
          : `❌ CrewAI error: ${msg}`,
        details: msg,
      })}\n\n`
    );
  } finally {
    metrics.recordLatency(Date.now() - startTime);
    res.end();
  }
});
