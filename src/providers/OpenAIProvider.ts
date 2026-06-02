/**
 * OpenAI model provider factory.
 *
 * Single responsibility: construct and export a configured OpenAIModel
 * instance that the AgentService can consume.
 *
 * Environment variables used:
 *  - OPENAI_API_KEY  (required)
 *  - OPENAI_MODEL    (optional, defaults to gpt-4o)
 */

import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { logger } from "../utils/logger.js";

export function createOpenAIProvider(): OpenAIModel {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is not set.");
  }

  const modelId = process.env.OPENAI_MODEL ?? "gpt-4o";
  logger.info(`OpenAI provider initialised — model: ${modelId}`);

  return new OpenAIModel({
    api: "chat",
    modelId,
    apiKey: process.env.OPENAI_API_KEY,
  });
}
