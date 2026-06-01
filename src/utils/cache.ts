/**
 * In-memory response cache using NodeCache.
 *
 * Responsibilities:
 *  - Store agent answers keyed by question text.
 *  - Expire entries automatically after CACHE_TTL seconds.
 *  - No database — all state lives in process memory.
 */

import NodeCache from "node-cache";

const TTL = parseInt(process.env.CACHE_TTL ?? "300", 10);

export const responseCache = new NodeCache({ stdTTL: TTL, checkperiod: 60 });

export function getCachedResponse(question: string): string | undefined {
  return responseCache.get<string>(question);
}

export function setCachedResponse(question: string, answer: string): void {
  responseCache.set(question, answer);
}
