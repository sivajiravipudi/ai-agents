/**
 * requestLogger middleware — structured per-request tracing.
 *
 * Attaches a unique `X-Request-ID` to every request and logs:
 *  - Incoming: method, path, IP, request ID
 *  - Outgoing: status code, duration in ms
 *
 * The request ID is propagated to the response header so it can be
 * correlated in client logs and external tracing systems.
 */

import { type Request, type Response, type NextFunction } from "express";
import { logger } from "../utils/logger.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers["x-request-id"] as string) ?? crypto.randomUUID();
  const startTime = Date.now();

  req.requestId = requestId;
  req.startTime = startTime;

  res.setHeader("X-Request-ID", requestId);

  const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown";

  logger.info(`[${requestId}] → ${req.method} ${req.path} — IP: ${ip}`);

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level](
      `[${requestId}] ← ${res.statusCode} ${req.method} ${req.path} — ${durationMs}ms`
    );
  });

  next();
}
