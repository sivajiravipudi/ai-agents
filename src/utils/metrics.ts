/**
 * Metrics — in-process observability counters.
 *
 * Tracks:
 *  - Total requests (ask + stream)
 *  - Total LLM token usage (prompt + completion + total)
 *  - Per-tool call counts
 *  - Cache hit/miss counts
 *  - Error counts by type
 *  - Request latency histogram (p50, p95, p99)
 *  - Active sessions count (read from SessionStore)
 *
 * Exposed via GET /api/metrics as JSON.
 * No external dependencies — pure in-process counters.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface LatencyRecord {
  durationMs: number;
  timestamp: number;
}

class MetricsStore {
  private _requestCount = 0;
  private _streamRequestCount = 0;
  private _askRequestCount = 0;
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _errorCount = 0;
  private _errorsByType: Record<string, number> = {};
  private _toolCallCounts: Record<string, number> = {};
  private _tokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _latencies: LatencyRecord[] = [];

  /** Keep only the last 1000 latency samples to bound memory */
  private readonly MAX_LATENCY_SAMPLES = 1000;

  incrementRequest(type: "ask" | "stream"): void {
    this._requestCount++;
    if (type === "ask") this._askRequestCount++;
    else this._streamRequestCount++;
  }

  incrementCacheHit(): void { this._cacheHits++; }
  incrementCacheMiss(): void { this._cacheMisses++; }

  incrementError(type: "timeout" | "quota" | "mcp" | "general" | "empty"): void {
    this._errorCount++;
    this._errorsByType[type] = (this._errorsByType[type] ?? 0) + 1;
  }

  incrementToolCall(toolName: string): void {
    this._toolCallCounts[toolName] = (this._toolCallCounts[toolName] ?? 0) + 1;
  }

  addTokenUsage(usage: Partial<TokenUsage>): void {
    this._tokens.promptTokens     += usage.promptTokens     ?? 0;
    this._tokens.completionTokens += usage.completionTokens ?? 0;
    this._tokens.totalTokens      += usage.totalTokens      ?? 0;
  }

  recordLatency(durationMs: number): void {
    if (this._latencies.length >= this.MAX_LATENCY_SAMPLES) {
      this._latencies.shift();
    }
    this._latencies.push({ durationMs, timestamp: Date.now() });
  }

  /** Compute percentile from sorted latency values */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return Math.round(sorted[Math.max(0, idx)]);
  }

  snapshot(activeSessions: number): object {
    const sorted = [...this._latencies.map((l) => l.durationMs)].sort((a, b) => a - b);
    const avgLatency = sorted.length > 0
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0;

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      requests: {
        total:  this._requestCount,
        ask:    this._askRequestCount,
        stream: this._streamRequestCount,
      },
      cache: {
        hits:      this._cacheHits,
        misses:    this._cacheMisses,
        hitRatePct: this._cacheHits + this._cacheMisses > 0
          ? Math.round((this._cacheHits / (this._cacheHits + this._cacheMisses)) * 100)
          : 0,
      },
      tokens: { ...this._tokens },
      toolCalls: { ...this._toolCallCounts },
      errors: {
        total:  this._errorCount,
        byType: { ...this._errorsByType },
      },
      latencyMs: {
        samples: this._latencies.length,
        avg:  avgLatency,
        p50:  this.percentile(sorted, 50),
        p95:  this.percentile(sorted, 95),
        p99:  this.percentile(sorted, 99),
      },
      sessions: {
        active: activeSessions,
      },
      memory: {
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

export const metrics = new MetricsStore();
