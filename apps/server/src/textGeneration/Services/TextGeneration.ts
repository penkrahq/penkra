/**
 * TextGeneration - Effect service contract for first-message Thread titles.
 *
 * @module TextGeneration
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ChatAttachment, ModelSelection, ProviderStartOptions } from "@penkra/contracts";

import type { ProviderManagedLaunchContext } from "../../provider/Services/ProviderAdapter.ts";
import type { TextGenerationError } from "../Errors.ts";

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Exact provider model to use. When omitted, the provider selects its own default. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
  /** Exact server-resolved installation, Connection, profile, and credentials for this Thread. */
  managedLaunch?: ProviderManagedLaunchContext;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export type TextGenerationOperation = "generateThreadTitle";

/** TextGenerationShape - Service API for first-message Thread titles. */
export interface TextGenerationShape {
  /**
   * Generate a concise chat-thread title from the first user message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
}

/**
 * CodexTextGeneration - Provider-specific Codex implementation for Thread titles.
 */
export class CodexTextGeneration extends ServiceMap.Service<
  CodexTextGeneration,
  TextGenerationShape
>()("penkra/textGeneration/Services/TextGeneration/CodexTextGeneration") {}

/**
 * OpenCodeTextGeneration - Provider-specific OpenCode implementation for Thread titles.
 */
export class OpenCodeTextGeneration extends ServiceMap.Service<
  OpenCodeTextGeneration,
  TextGenerationShape
>()("penkra/textGeneration/Services/TextGeneration/OpenCodeTextGeneration") {}

/**
 * TextGeneration - Service tag for first-message thread titles.
 */
export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "penkra/textGeneration/Services/TextGeneration",
) {}
