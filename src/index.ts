/**
 * Application entry point.
 *
 * Responsibilities:
 *  1. Load environment variables from .env
 *  2. Verify the NASDAQ MCP service is reachable before starting
 *  3. Initialise the AgentService (model provider + MCP client)
 *  4. Start the Express HTTP server
 *
 * The NASDAQ MCP server runs as a SEPARATE process/service on NASDAQ_MCP_URL.
 * Start it independently:  npm run mcp
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { agentService } from "./services/AgentService.js";
import { stockAgentService } from "./services/StockAgentService.js";
import { askRouter } from "./routes/askRoute.js";
import { streamRouter } from "./routes/streamRoute.js";
import { historyRouter } from "./routes/historyRoute.js";
import { metricsRouter } from "./routes/metricsRoute.js";
import { crewaiRouter } from "./routes/crewaiRoute.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const NASDAQ_MCP_URL = process.env.NASDAQ_MCP_URL ?? "http://localhost:3002/mcp";
const NASDAQ_MCP_HEALTH = NASDAQ_MCP_URL.replace("/mcp", "/health");

/** Verify the NASDAQ MCP service is reachable before the backend starts */
async function checkNasdaqMcpHealth(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(NASDAQ_MCP_HEALTH);
      if (res.ok) {
        logger.info(`NASDAQ MCP service reachable at ${NASDAQ_MCP_URL}`);
        return;
      }
    } catch {
      // Not reachable yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  logger.warn(
    `NASDAQ MCP service not reachable at ${NASDAQ_MCP_URL}. ` +
      "Start it with: npm run mcp  — continuing without it."
  );
}

/** Rate limiter — 60 requests per minute per IP on all /api routes */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again." },
  skip: (req) => req.path === "/health",
});

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestLogger);
app.use("/api", apiLimiter);

app.use("/api/ask", askRouter);
app.use("/api/stream", streamRouter);
app.use("/api/history", historyRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/stream-crewai", crewaiRouter);

app.get("/health", (_req: express.Request, res: express.Response) => {
  res.json({ status: "ok", agents: ["general"] });
});

async function main() {
  // Check NASDAQ MCP service is up before connecting agents
  await checkNasdaqMcpHealth();

  await agentService.initialize();
  await stockAgentService.initialize();

  // Wire the stock agent as a delegatable tool on the general agent.
  agentService.registerStockTool(stockAgentService.asTool());

  const server = app.listen(PORT, () => {
    logger.info(`Server listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    await Promise.all([agentService.dispose(), stockAgentService.dispose()]);
    server.close(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("Fatal startup error:", err);
  process.exit(1);
});
