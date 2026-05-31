/**
 * Model Configuration Types for Workflow System
 * 
 * Provides type definitions and utilities for model selection in workflows.
 * These types extend the existing ModelOverride interface to add UI metadata.
 */

import type { ModelOverride } from "./types";

// ─── Model Provider Types ────────────────────────────────────────────────────

/**
 * Supported AI model providers.
 * - bedrock: AWS Bedrock (Claude models)
 * - openai: OpenAI API (GPT models)
 * - gemini: Google Gemini (future support)
 */
export type ModelProvider = "bedrock" | "openai";

// ─── Model Option Types ──────────────────────────────────────────────────────

/**
 * Base interface for all model options.
 * Contains common fields for UI display and model identification.
 */
export interface ModelOptionBase {
  /** Unique identifier for UI selection (e.g., "claude-sonnet-45") */
  id: string;
  /** Human-readable display name (e.g., "Claude Sonnet 4.5 (Recommended)") */
  label: string;
  /** The AI provider for this model */
  provider: ModelProvider;
  /** Actual model identifier used in API calls */
  modelId: string;
  /** Optional tooltip/help text describing the model */
  description?: string;
  /** Indicates if this is the default/recommended model */
  isDefault?: boolean;
}

/**
 * Bedrock-specific model option (Claude models via AWS Bedrock).
 */
export interface BedrockModelOption extends ModelOptionBase {
  provider: "bedrock";
}

/**
 * OpenAI-specific model option.
 * Note: apiKeyArn is set server-side from environment variables.
 */
export interface OpenAIModelOption extends ModelOptionBase {
  provider: "openai";
}

/**
 * Union type for all supported model options.
 */
export type ModelOption = BedrockModelOption | OpenAIModelOption;

// ─── API Response Types ──────────────────────────────────────────────────────

/**
 * Response type for GET /api/models endpoint.
 */
export interface ModelsApiResponse {
  models: ModelOption[];
}

// ─── Conversion Utilities ────────────────────────────────────────────────────

/**
 * Converts a ModelOption to the ModelOverride format expected by the engine.
 * 
 * @param option - The selected model option from the UI, or null/undefined for default
 * @returns ModelOverride for non-default models, undefined for default model
 * 
 * @example
 * ```typescript
 * const override = modelOptionToOverride(selectedModel);
 * // Pass to WorkflowInput.modelOverride
 * ```
 */
export function modelOptionToOverride(
  option: ModelOption | null | undefined
): ModelOverride | undefined {
  // Return undefined for default model (engine uses its own default)
  if (!option || option.isDefault) {
    return undefined;
  }

  switch (option.provider) {
    case "bedrock":
      return {
        bedrockModelConfig: {
          modelId: option.modelId,
        },
      };

    case "openai": {
      // apiKeyArn is resolved server-side at invocation time
      const apiKeyArn = process.env.OPENAI_API_KEY_ARN;
      if (!apiKeyArn) {
        console.warn(
          `[model-config] OpenAI model "${option.modelId}" selected but OPENAI_API_KEY_ARN not set`
        );
        return undefined;
      }
      return {
        openAiModelConfig: {
          modelId: option.modelId,
          apiKeyArn,
        },
      };
    }

    default:
      return undefined;
  }
}

