/**
 * GET /api/metrics — exposes in-process observability snapshot.
 *
 * Returns request counts, token usage, tool call frequencies,
 * cache hit rate, latency percentiles, error counts, and memory usage.
 */

import { Router, type Request, type Response } from "express";
import { metrics } from "../utils/metrics.js";
import { sessionStore } from "../utils/SessionStore.js";

export const metricsRouter = Router();

metricsRouter.get("/", (_req: Request, res: Response) => {
  res.json(metrics.snapshot(sessionStore.activeCount()));
});
