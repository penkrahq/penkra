// FILE: OpenCodeTextGeneration.ts
// Purpose: Runs OpenCode-compatible one-shot generation for first-message Thread titles.
// Layer: Server text-generation adapter
// Depends on: OpenCode SDK runtime, prompt builders, attachment projection, and server config.

import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ChatAttachment,
  KiloModelSelection,
  OpenCodeModelSelection,
  OpenCodeModelOptions,
  ProviderStartOptions,
} from "@penkra/contracts";
import { sanitizeGeneratedThreadTitle } from "@penkra/shared/chatThreads";
import { getModelSelectionStringOptionValue } from "@penkra/shared/model";

import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../../provider/attachmentProjection.ts";
import {
  OpenCodeRuntime,
  KILO_CLI_SPEC,
  OPENCODE_CLI_SPEC,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type ThreadTitleGenerationInput,
  type TextGenerationOperation,
  type TextGenerationShape,
  KiloTextGeneration,
  OpenCodeTextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildThreadTitlePrompt,
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
} from "../textGenerationShared.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  cwd: string | null;
  isolationKey: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface AcquiredOpenCodeTextGenerationServer {
  server: OpenCodeServerProcess;
  shared: boolean;
  serverScope: Scope.Closeable | null;
}

type OpenCodeCompatibleTextGenerationProvider = "opencode" | "kilo";
type OpenCodeCompatibleModelSelection = OpenCodeModelSelection | KiloModelSelection;

interface OpenCodeCompatibleTextGenerationConfig {
  readonly provider: OpenCodeCompatibleTextGenerationProvider;
  readonly displayName: string;
  readonly serviceName: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
  readonly resolveServerPassword?: (
    provider: OpenCodeCompatibleTextGenerationProvider,
  ) => Effect.Effect<string | undefined>;
}

function resolveOpenCodeCompatibleModelSelection(
  config: OpenCodeCompatibleTextGenerationConfig,
  input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string; model: string; options?: unknown };
  },
): OpenCodeCompatibleModelSelection | null {
  if (input.modelSelection?.provider === config.provider) {
    return input.modelSelection as OpenCodeCompatibleModelSelection;
  }

  const model = input.model?.trim();
  if (config.provider !== "opencode" || !model || parseOpenCodeModelSlug(model) === null) {
    return null;
  }

  return {
    provider: "opencode",
    model,
  };
}

const makeOpenCodeCompatibleTextGeneration = (config: OpenCodeCompatibleTextGenerationConfig) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const sharedServerMutex = yield* Semaphore.make(1);
    const sharedServerState: SharedOpenCodeTextGenerationServerState = {
      server: null,
      serverScope: null,
      binaryPath: null,
      cwd: null,
      isolationKey: null,
      activeRequests: 0,
      idleCloseFiber: null,
    };

    const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
      const scope = sharedServerState.serverScope;
      sharedServerState.server = null;
      sharedServerState.serverScope = null;
      sharedServerState.binaryPath = null;
      sharedServerState.cwd = null;
      sharedServerState.isolationKey = null;
      if (scope !== null) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      }
    });

    const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
      const idleCloseFiber = sharedServerState.idleCloseFiber;
      sharedServerState.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

    const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
      server: OpenCodeServerProcess,
    ) {
      yield* cancelIdleCloseFiber();
      const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
        Effect.andThen(
          sharedServerMutex.withPermit(
            Effect.gen(function* () {
              if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
                return;
              }
              sharedServerState.idleCloseFiber = null;
              yield* closeSharedServer();
            }),
          ),
        ),
        Effect.forkIn(idleFiberScope),
      );
      sharedServerState.idleCloseFiber = fiber;
    });

    const acquireSharedServer = (input: {
      readonly binaryPath: string;
      readonly cwd: string;
      readonly operation: TextGenerationOperation;
      readonly isolationKey: string;
      readonly processEnv?: NodeJS.ProcessEnv;
    }) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();

          const startServer = Effect.fn("startOpenCodeTextGenerationServer")(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              openCodeRuntime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  cliSpec: config.cliSpec,
                  cwd: input.cwd,
                  ...(input.processEnv ? { processEnv: input.processEnv } : {}),
                })
                .pipe(
                  Effect.provideService(Scope.Scope, serverScope),
                  Effect.mapError(
                    (cause) =>
                      new TextGenerationError({
                        operation: input.operation,
                        detail: openCodeRuntimeErrorDetail(cause),
                        cause,
                      }),
                  ),
                ),
            );

            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            return {
              server: startedExit.value,
              serverScope,
            };
          });

          const existingServer = sharedServerState.server;
          if (existingServer !== null) {
            const sameConfigScope =
              sharedServerState.binaryPath === input.binaryPath &&
              sharedServerState.cwd === input.cwd &&
              sharedServerState.isolationKey === input.isolationKey;
            if (!sameConfigScope && sharedServerState.activeRequests === 0) {
              yield* closeSharedServer();
            } else {
              if (!sameConfigScope) {
                yield* Effect.logWarning(
                  `${config.displayName} shared server config scope mismatch: requested ` +
                    input.binaryPath +
                    " at " +
                    input.cwd +
                    " but active server uses " +
                    sharedServerState.binaryPath +
                    " at " +
                    sharedServerState.cwd +
                    "; starting a dedicated server for this request",
                );
                const dedicated = yield* startServer();
                return {
                  server: dedicated.server,
                  shared: false,
                  serverScope: dedicated.serverScope,
                } satisfies AcquiredOpenCodeTextGenerationServer;
              }
              sharedServerState.activeRequests += 1;
              return {
                server: existingServer,
                shared: true,
                serverScope: null,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }
          }

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { server, serverScope } = yield* restore(startServer());
              sharedServerState.server = server;
              sharedServerState.serverScope = serverScope;
              sharedServerState.binaryPath = input.binaryPath;
              sharedServerState.cwd = input.cwd;
              sharedServerState.isolationKey = input.isolationKey;
              sharedServerState.activeRequests = 1;
              return {
                server,
                shared: true,
                serverScope: null,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }),
          );
        }),
      );

    const releaseSharedServer = (acquired: AcquiredOpenCodeTextGenerationServer) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          if (!acquired.shared) {
            if (acquired.serverScope !== null) {
              yield* Scope.close(acquired.serverScope, Exit.void).pipe(Effect.ignore);
            }
            return;
          }
          if (sharedServerState.server !== acquired.server) {
            return;
          }
          sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
          if (sharedServerState.activeRequests === 0) {
            yield* scheduleIdleClose(acquired.server);
          }
        }),
      );

    yield* Effect.addFinalizer(() =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();
          sharedServerState.activeRequests = 0;
          yield* closeSharedServer();
        }),
      ),
    );

    const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
      readonly operation: TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchemaJson: S;
      readonly rawTextFallback?: RawTextFallback;
      readonly modelSelection: OpenCodeCompatibleModelSelection;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      readonly providerOptions?: ProviderStartOptions;
      readonly managedLaunch?: ThreadTitleGenerationInput["managedLaunch"];
    }) {
      const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `${config.displayName} model selection must use the 'provider/model' format.`,
        });
      }

      const providerOptions = input.managedLaunch
        ? undefined
        : input.providerOptions?.[config.provider];
      const binaryPath =
        input.managedLaunch?.binaryPath ??
        providerOptions?.binaryPath?.trim() ??
        config.cliSpec.defaultBinaryPath;
      const serverUrl = providerOptions?.serverUrl?.trim() || "";
      const processEnv = input.managedLaunch?.childEnvironment(process.env);
      const isolationKey = input.managedLaunch?.isolationKey ?? "unmanaged";
      const serverPassword = config.resolveServerPassword
        ? ((yield* config.resolveServerPassword(config.provider)) ?? "")
        : "";
      const providerId = parsedModel.providerID;
      const modelId = parsedModel.modelID;
      const modelOptions = input.modelSelection.options as OpenCodeModelOptions | undefined;
      const agent = modelOptions?.agent?.trim();
      const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant")?.trim();

      const promptText =
        appendFileAttachmentsPromptBlock({
          text: input.prompt,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        }) ?? input.prompt;
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveProviderAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });

      const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url">) =>
        Effect.tryPromise({
          try: async () => {
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: input.cwd,
              ...(serverPassword.length > 0 ? { serverPassword } : {}),
              cliSpec: config.cliSpec,
            });
            const sessionCreateInput = {
              title: `Penkra ${input.operation}`,
              model: {
                providerID: providerId,
                id: modelId,
                ...(variant ? { variant } : {}),
              },
              ...(agent ? { agent } : {}),
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            };
            const session = await client.session.create(
              sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
            );
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(agent ? { agent } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: "text", text: promptText }, ...fileParts],
            });
            const info = result.data?.info;
            const errorMessage = getOpenCodePromptErrorMessage(info?.error);
            if (errorMessage) {
              throw new Error(errorMessage);
            }
            const rawText = getOpenCodeTextResponse(result.data?.parts);
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: [
                openCodeRuntimeErrorDetail(cause),
                `model=${providerId}/${modelId}`,
                variant ? `variant=${variant}` : null,
                agent ? `agent=${agent}` : null,
                serverUrl.length > 0 ? "server=external" : "server=managed",
              ]
                .filter(Boolean)
                .join(" "),
              cause,
            }),
        });

      yield* Effect.logDebug("OpenCode text generation request", {
        operation: input.operation,
        cwd: input.cwd,
        providerId,
        modelId,
        variant,
        agent,
        attachmentCount: input.attachments?.length ?? 0,
        filePartCount: fileParts.length,
        binaryPath,
        usingExternalServer: serverUrl.length > 0,
      });

      const rawOutput =
        serverUrl.length > 0
          ? yield* runAgainstServer({ url: serverUrl })
          : yield* Effect.acquireUseRelease(
              acquireSharedServer({
                binaryPath,
                cwd: input.cwd,
                operation: input.operation,
                isolationKey,
                ...(processEnv ? { processEnv } : {}),
              }),
              (acquired) => runAgainstServer(acquired.server),
              releaseSharedServer,
            );

      return yield* decodeStructuredTextGenerationOutput({
        schema: input.outputSchemaJson,
        raw: rawOutput,
        operation: input.operation,
        providerLabel: config.displayName,
        ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
      });
    });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
      `${config.serviceName}.generateThreadTitle`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.managedLaunch ? { managedLaunch: input.managedLaunch } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      };
    });

    return {
      generateThreadTitle,
    } satisfies TextGenerationShape;
  });

export const makeOpenCodeTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
) =>
  Layer.effect(
    OpenCodeTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "opencode",
      displayName: "OpenCode",
      serviceName: "OpenCodeTextGeneration",
      cliSpec: OPENCODE_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
    }),
  );

export const makeKiloTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
) =>
  Layer.effect(
    KiloTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "kilo",
      displayName: "Kilo",
      serviceName: "KiloTextGeneration",
      cliSpec: KILO_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
    }),
  );

export const OpenCodeTextGenerationServiceLive = makeOpenCodeTextGenerationServiceLive();
export const KiloTextGenerationServiceLive = makeKiloTextGenerationServiceLive();
