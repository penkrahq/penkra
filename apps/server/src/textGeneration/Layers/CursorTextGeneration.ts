import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CursorModelSelection, ProviderStartOptions } from "@penkra/contracts";
import { sanitizeGeneratedThreadTitle } from "@penkra/shared/chatThreads";

import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
  type CursorAcpRuntimeCursorSettings,
} from "../../provider/acp/CursorAcpSupport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CursorTextGeneration,
  type TextGenerationOperation,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildThreadTitlePrompt,
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
} from "../textGenerationShared.ts";

const CURSOR_TEXT_GENERATION_LABEL = "Cursor Agent";

const CURSOR_TIMEOUT_MS = 180_000;

function mapCursorAcpError(
  operation: TextGenerationOperation,
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

function resolveCursorModelSelection(input: {
  readonly model?: string;
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  };
}): CursorModelSelection | null {
  if (input.modelSelection?.provider === "cursor") {
    return input.modelSelection as CursorModelSelection;
  }

  return null;
}

function resolveCursorSettings(
  providerOptions: ProviderStartOptions | undefined,
): CursorAcpRuntimeCursorSettings | undefined {
  const cursorOptions = providerOptions?.cursor;
  if (!cursorOptions) return undefined;
  return {
    ...(cursorOptions.binaryPath ? { binaryPath: cursorOptions.binaryPath } : {}),
    ...(cursorOptions.apiEndpoint ? { apiEndpoint: cursorOptions.apiEndpoint } : {}),
  };
}

const makeCursorTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    rawTextFallback,
    modelSelection,
    providerOptions,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    rawTextFallback?: RawTextFallback;
    modelSelection: CursorModelSelection;
    providerOptions?: ProviderStartOptions;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings: resolveCursorSettings(providerOptions),
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "penkra-git-text", version: "0.0.0" },
      });

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          options: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            mapCursorAcpError(
              operation,
              step === "set-config-option"
                ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                : "Failed to set Cursor ACP base model for text generation.",
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapCursorAcpError(operation, "Cursor ACP request failed.", cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Cursor ACP request was cancelled."
              : "Cursor Agent returned empty output.",
        });
      }

      return yield* decodeStructuredTextGenerationOutput({
        schema: outputSchemaJson,
        raw: rawResult,
        operation,
        providerLabel: CURSOR_TEXT_GENERATION_LABEL,
        ...(rawTextFallback ? { rawTextFallback } : {}),
      });
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorAcpError(operation, "Cursor ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      rawTextFallback,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      title: sanitizeGeneratedThreadTitle(generated.title),
    };
  });

  return {
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationServiceLive = Layer.effect(
  CursorTextGeneration,
  makeCursorTextGeneration,
);

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
