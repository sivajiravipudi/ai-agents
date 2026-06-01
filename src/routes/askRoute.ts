/**
 * /api/ask route handler.
 *
 * Single responsibility: validate the HTTP request, delegate to AgentService,
 * and return a JSON response.  All agent logic lives in AgentService.
 */

import { Router, type Request, type Response } from "express";
import { agentService } from "../services/AgentService.js";
import { logger } from "../utils/logger.js";

export const askRouter = Router();

askRouter.post("/", async (req: Request, res: Response) => {
  const { question } = req.body as { question?: string };

  if (!question || typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "Field 'question' is required and must be a non-empty string." });
    return;
  }

  logger.info(`POST /api/ask — "${question.slice(0, 80)}"`);

  try {
    const answer = await agentService.ask(question.trim());
    res.json({ answer });
  } catch (err) {
    logger.error("Agent invocation failed:", err);
    res.status(500).json({ error: "Agent failed to process the question. Please try again." });
  }
});
