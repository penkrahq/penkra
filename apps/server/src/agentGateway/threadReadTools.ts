import {
  PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { PENKRA_INSTRUCTION_SET_VERSION } from "./harnessPolicy.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  agentGatewayTargetOptionGuidance,
  loadAgentGatewayProviderCatalog,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import {
  deriveAgentThreadStatus,
  summarizeThreadDetail,
  summarizeThreadShell,
  summarizeWaitThreadText,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
} from "./threadSummary.ts";
import { resolveAuthoritativeActiveTurn } from "./activeExecution.ts";
import {
  decodeWaitForThreadsInput,
  errorText,
  PROVIDER_KINDS,
  readBooleanArg,
  readIsoTimestampArg,
  readNumberArg,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  gatewayToolErrorResult,
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;
const CAPABILITIES_RESPONSE_MAX_CHARS = 40_000;

export interface ThreadReadToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown,
    never
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
  readonly workspacePaths: {
    readonly homeDir: string;
    readonly chatWorkspaceRoot: string;
  };
}

export function makeThreadReadTools(input: ThreadReadToolsInput): ReadonlyArray<ToolEntry> {
  const {
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths: _workspacePaths,
  } = input;

  const contextTool: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_context",
      description:
        "Use when you need the caller's own Penkra thread id, active turn id, folder, provider, or coordination permissions. This identifies the current execution context; use penkra_list_threads to discover other threads and penkra_capabilities to choose a provider/model target.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { title: "Penkra context", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const turnId =
          (yield* resolveAuthoritativeActiveTurn({
            threadId: caller.id,
            session: caller.session,
            projectionTurns,
          }))?.turnId ?? null;
        return mcpToolResultJson({
          harness: {
            name: "Penkra",
            policyVersion: PENKRA_INSTRUCTION_SET_VERSION,
          },
          caller: {
            threadId: caller.id,
            turnId,
            provider: context.callerProvider,
            folderId: caller.folderId,
          },
          capabilities: {
            threadRead: context.callerCapabilities.has("thread:read"),
            threadCreate: turnId !== null && context.callerCapabilities.has("thread:write"),
            threadWait: context.callerCapabilities.has("thread:read"),
            diagnostics: context.callerCapabilities.has("diagnostics:read"),
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const capabilitiesTool: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_capabilities",
      description: `Use immediately before penkra_create_thread when you need a valid provider/model target or provider-specific option keys. By default it returns a compact summary of available providers; pass provider for one exact catalog or detail "full" for complete model metadata. Returns canonical targets and gateway limits, not existing threads or folders; use penkra_list_threads or penkra_list_folders for those. ${AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION}`,
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: [...PROVIDER_KINDS],
            description:
              "Only this exact provider kind, including its unavailable reason when it cannot run.",
          },
          detail: {
            type: "string",
            enum: ["summary", "full"],
            description:
              "summary (default) returns model slug/name plus target rules; full adds all discovered model metadata.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Penkra capabilities",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const requestedProvider = readStringArg(args, "provider");
        if (
          requestedProvider !== undefined &&
          !PROVIDER_KINDS.includes(requestedProvider as ProviderKind)
        ) {
          throw new ToolInputError(
            `Argument "provider" received "${requestedProvider}". Use one of: ${PROVIDER_KINDS.join(", ")}.`,
          );
        }
        const detail = readStringArg(args, "detail") ?? "summary";
        if (detail !== "summary" && detail !== "full") {
          throw new ToolInputError(
            `Argument "detail" received "${detail}". Use "summary" or "full".`,
          );
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const project = yield* snapshotQuery.getFolderShellById(caller.folderId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolInputError(`Folder "${caller.folderId}" was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );
        const availabilities = yield* loadProviderAvailabilities;
        const providerKinds = requestedProvider
          ? [requestedProvider as ProviderKind]
          : PROVIDER_KINDS;
        const discoveredProviders = yield* Effect.forEach(providerKinds, (provider) =>
          loadAgentGatewayProviderCatalog({
            provider,
            discovery: providerDiscovery,
            ...(availabilities.get(provider) !== undefined
              ? { availability: availabilities.get(provider)! }
              : {}),
            ...(project.workspaceRoot ? { cwd: project.workspaceRoot } : {}),
          }),
        );
        const providers = requestedProvider
          ? discoveredProviders
          : discoveredProviders.filter((provider) => provider.available);
        const targetConstruction = Object.fromEntries(
          providers.map((provider) => [
            provider.provider,
            {
              modelValueSource: "providers[].models[].slug",
              ...agentGatewayTargetOptionGuidance(provider),
            },
          ]),
        );
        const payload = {
          targetConstruction,
          providers:
            detail === "full"
              ? providers
              : providers.map((provider) => ({
                  provider: provider.provider,
                  defaultModel: provider.defaultModel,
                  enabled: provider.enabled,
                  available: provider.available,
                  ...(provider.authStatus ? { authStatus: provider.authStatus } : {}),
                  ...(provider.source ? { source: provider.source } : {}),
                  ...(provider.error ? { error: provider.error } : {}),
                  models: provider.models.map((model) => ({
                    slug: model.slug,
                    name: model.name,
                  })),
                })),
          ...(!requestedProvider
            ? {
                omittedUnavailableProviders: discoveredProviders
                  .filter((provider) => !provider.available)
                  .map((provider) => provider.provider),
              }
            : {}),
          limits: {
            maxThreadsPerWait: PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
            maxWaitMs: 60_000,
          },
        };
        const responseChars = JSON.stringify(payload).length;
        if (responseChars > CAPABILITIES_RESPONSE_MAX_CHARS) {
          throw new ToolInputError(
            `Capabilities response is ${responseChars} characters, exceeding the ${CAPABILITIES_RESPONSE_MAX_CHARS}-character limit. Pass one exact provider or use detail "summary".`,
          );
        }
        return mcpToolResultJson(payload);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listFolders: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_list_folders",
      description:
        "Use to resolve a Penkra folder id and workspace root before creating or filtering threads in another folder. Returns folder metadata only; use penkra_list_threads to discover conversations and penkra_context for the caller's current folder.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        title: "List Penkra folders",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: () =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            folders: snapshot.folders.map((project) => ({
              folderId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              isPinned: project.isPinned,
            })),
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const listThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_list_threads",
      description:
        "Use to discover existing Penkra threads or child threads before reading, waiting, sending, interrupting, or diagnosing them. Filters by folder, hierarchy, provider/model, status, title, source, and update window; archived threads are hidden unless includeArchived is true. Use penkra_read_thread once you know the exact thread id.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: {
            type: "string",
            description: "Only threads in this exact Penkra folder id.",
          },
          parentThreadId: {
            type: "string",
            description: "Only direct child threads of this exact Penkra parent thread id.",
          },
          provider: {
            type: "string",
            enum: [...PROVIDER_KINDS],
            description: "Only threads using this exact provider kind.",
          },
          model: { type: "string", description: "Exact model slug." },
          status: {
            type: "string",
            description:
              "Derived thread status such as working, idle, error, or waiting-for-approval.",
          },
          titleContains: {
            type: "string",
            description: "Case-insensitive title substring.",
          },
          creationSource: {
            type: "string",
            description: "Exact thread creation source.",
          },
          updatedAfter: {
            type: "string",
            description: "ISO timestamp lower bound (inclusive).",
          },
          updatedBefore: {
            type: "string",
            description: "ISO timestamp upper bound (inclusive).",
          },
          includeArchived: {
            type: "boolean",
            description: "Include archived threads.",
          },
          limit: {
            type: "number",
            description: "Max results (default 50, max 200).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "List Penkra threads",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const folderId = readStringArg(args, "folderId");
        const parentThreadId = readStringArg(args, "parentThreadId");
        const provider = readStringArg(args, "provider");
        const model = readStringArg(args, "model");
        const status = readStringArg(args, "status");
        const titleContains = readStringArg(args, "titleContains")?.toLocaleLowerCase();
        const creationSource = readStringArg(args, "creationSource");
        const updatedAfter = readIsoTimestampArg(args, "updatedAfter");
        const updatedBefore = readIsoTimestampArg(args, "updatedBefore");
        const includeArchived = readBooleanArg(args, "includeArchived") ?? false;
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
            LIST_THREADS_MAX_LIMIT,
          ),
        );
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const matching = snapshot.threads
          .filter((thread) => (folderId ? thread.folderId === folderId : true))
          .filter((thread) => (parentThreadId ? thread.parentThreadId === parentThreadId : true))
          .filter((thread) => (provider ? thread.modelSelection.provider === provider : true))
          .filter((thread) => (model ? thread.modelSelection.model === model : true))
          .filter((thread) => (status ? deriveAgentThreadStatus(thread) === status : true))
          .filter((thread) =>
            titleContains ? thread.title.toLocaleLowerCase().includes(titleContains) : true,
          )
          .filter((thread) =>
            creationSource ? (thread.creationSource ?? null) === creationSource : true,
          )
          .filter((thread) => (updatedAfter ? thread.updatedAt >= updatedAfter : true))
          .filter((thread) => (updatedBefore ? thread.updatedAt <= updatedBefore : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        const threads = matching
          .slice(0, limit)
          .map((thread) => summarizeThreadShell(thread, context.callerThreadId));
        return mcpToolResultJson({ threads, totalMatching: matching.length });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readThread: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_read_thread",
      description:
        "Use after penkra_list_threads when you need one thread's status and transcript. Returns newest-last message pages with bounded text; follow nextCursor until null before treating the transcript as complete. Use penkra_read_thread_activity for the work log or penkra_diagnose_thread when behavior is inconsistent.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id to read.",
          },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the preceding transcript page.",
          },
          messageLimit: {
            type: "number",
            description: "Messages per page (default 20, max 100).",
          },
          maxMessageChars: {
            type: "number",
            description: "Per-message truncation limit (default 1500).",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Read a Penkra thread",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const cursor = readStringArg(args, "cursor");
        const messageLimit = readNumberArg(args, "messageLimit");
        const maxMessageChars = readNumberArg(args, "maxMessageChars");
        const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
              onSome: (thread) => Effect.succeed(thread),
            }),
          ),
        );
        return mcpToolResultJson(
          summarizeThreadDetail({
            thread: detail,
            cursor,
            messageLimit,
            maxMessageChars,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const waitForThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_wait_for_threads",
      description: `Use after creating or otherwise identifying background Penkra threads when you need all of their turn outcomes. Waits for 1–20 pinned turns and returns every result in input order. Assistant summaries are capped at ${WAIT_THREAD_SUMMARY_MAX_CHARS} characters; use each result's readThread call for the full transcript. A timeout reports progress only and never retries, replaces, cancels, or creates work.`,
      inputSchema: {
        type: "object",
        properties: {
          threadIds: {
            type: "array",
            minItems: 1,
            maxItems: PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: "string" },
            description: "Exact Penkra thread ids to wait for, in the desired result order.",
          },
          runIds: {
            type: "array",
            maxItems: PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: ["string", "null"] },
            description: "Optional pinned turn ids from a prior wait. Must match threadIds length.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            description: "Long-poll duration; defaults to 30000ms.",
          },
        },
        required: ["threadIds"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for Penkra threads",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const waitInput = decodeWaitForThreadsInput(args);
        if (waitInput.runIds && waitInput.runIds.length !== waitInput.threadIds.length) {
          throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
        }
        const timeoutMs = waitInput.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        const pinned = yield* Effect.forEach(waitInput.threadIds, (threadId, index) =>
          snapshotQuery.getThreadShellById(threadId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
                  ),
                onSome: (thread) =>
                  Effect.succeed({
                    threadId,
                    runId: waitInput.runIds?.[index] ?? thread.latestTurn?.turnId ?? null,
                    shell: thread,
                  }),
              }),
            ),
          ),
        );

        const initialStateByKey = new Map(
          pinned.map((pin) => {
            const shell = pin.shell;
            return [
              `${pin.threadId}\u0000${pin.runId ?? ""}`,
              shell.latestTurn?.turnId === pin.runId ? shell.latestTurn.state : "pending",
            ] as const;
          }),
        );
        const readPinnedStates = () =>
          projectionTurns
            .getManyWaitSnapshot({
              threadIds: pinned.map((pin) => ThreadId.makeUnsafe(pin.threadId)),
              turns: pinned.flatMap((pin) =>
                pin.runId === null
                  ? []
                  : [
                      {
                        threadId: pin.threadId,
                        turnId: TurnId.makeUnsafe(pin.runId),
                      },
                    ],
              ),
            })
            .pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap((snapshot) => {
                const existingThreadIds = new Set(snapshot.existingThreadIds);
                const missing = pinned.find((pin) => !existingThreadIds.has(pin.threadId));
                if (missing) {
                  return Effect.fail(
                    new GatewayToolError(
                      "thread_not_found",
                      `Thread "${missing.threadId}" was not found.`,
                    ),
                  );
                }
                const turnsByKey = new Map(
                  snapshot.turns.map(
                    (turn) => [`${turn.threadId}\u0000${turn.turnId}`, turn] as const,
                  ),
                );
                return Effect.succeed(
                  pinned.map((pin) => {
                    const state =
                      pin.runId === null
                        ? ("idle" as const)
                        : (turnsByKey.get(`${pin.threadId}\u0000${pin.runId}`)?.state ??
                          initialStateByKey.get(`${pin.threadId}\u0000${pin.runId}`) ??
                          "pending");
                    const terminal =
                      state === "idle" ||
                      state === "completed" ||
                      state === "error" ||
                      state === "interrupted";
                    return {
                      threadId: pin.threadId,
                      runId: pin.runId,
                      state,
                      terminal,
                      timedOut: false,
                      summary: null as string | null,
                      summaryTruncated: false,
                      error: null as string | null,
                      readThread: {
                        tool: "penkra_read_thread" as const,
                        arguments: { threadId: pin.threadId },
                      },
                    };
                  }),
                );
              }),
            );

        let results = yield* readPinnedStates();
        let pollDelayMs = 200;
        while (results.some((result) => !result.terminal) && Date.now() < deadline) {
          yield* Effect.sleep(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
          results = yield* readPinnedStates();
          pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
        }
        const timedOut = results.some((result) => !result.terminal);
        const finalResults = yield* Effect.forEach(results, (result) =>
          Effect.gen(function* () {
            if (!result.terminal || result.runId === null) {
              return { ...result, timedOut: !result.terminal && timedOut };
            }
            const detail = yield* snapshotQuery.getThreadDetailById(result.threadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new GatewayToolError(
                        "thread_not_found",
                        `Thread "${result.threadId}" was not found.`,
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            const assistantMessage = detail.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === result.runId,
            );
            const summary = summarizeWaitThreadText(assistantMessage?.text);
            return {
              ...result,
              timedOut: false,
              summary: summary.summary,
              summaryTruncated: summary.truncated,
              error:
                result.state === "error" ? (detail.session?.lastError ?? "Turn failed.") : null,
            };
          }),
        );
        return mcpToolResultJson({
          callerThreadId: context.callerThreadId,
          runIds: pinned.map((pin) => pin.runId),
          allTerminal: finalResults.every((result) => result.terminal),
          timedOut,
          threads: finalResults,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof GatewayToolError
              ? gatewayToolErrorResult(error)
              : mcpToolResultError(errorText(error)),
          ),
        ),
      ),
  };

  return [contextTool, capabilitiesTool, listFolders, listThreads, readThread, waitForThreads];
}
