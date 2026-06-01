/**
 * /api/history/:sessionId — returns the conversation turns for a session.
 */

import { Router, type Request, type Response } from "express";
import { sessionStore } from "../utils/SessionStore.js";

export const historyRouter = Router();

historyRouter.get("/:sessionId", (req: Request, res: Response) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required." });
    return;
  }
  const turns = sessionStore.getHistory(sessionId);
  res.json({ sessionId, turns });
});
