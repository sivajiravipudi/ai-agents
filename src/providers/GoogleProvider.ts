/**
 * Google Gemini model provider factory.
 *
 * Single responsibility: construct and export a configured GoogleModel
 * instance that the AgentService can consume.
 *
 * Environment variables used:
 *  - GOOGLE_API_KEY   (required)
 *  - GOOGLE_MODEL     (optional, defaults to gemini-2.5-flash)
 */

import { GoogleModel } from "@strands-agents/sdk/models/google";
import { logger } from "../utils/logger.js";

export function createGoogleProvider(): GoogleModel {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY environment variable is not set.");
  }

  const modelId = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  logger.info(`Google Gemini provider initialised — model: ${modelId}`);

  return new GoogleModel({
    apiKey: process.env.GOOGLE_API_KEY,
    modelId,
  });
}
