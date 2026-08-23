/**
 * AgentGatewayLive - Penkra app-control MCP tool surface.
 *
 * Implements the single `penkra_exec_command` tool served over `POST /mcp`
 * (streamable HTTP, stateless JSON responses). Every provider session gets
 * this endpoint plus a thread-bound bearer token injected at session start, so
 * any agent running in a Penkra thread can use Penkra's registered commands.
 *
 * All tools delegate to existing services (OrchestrationEngine dispatch,
 * ProjectionSnapshotQuery reads); no orchestration
 * state lives here.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  MessageId,
  ThreadId,
  type ProviderKind,
  type ServerProviderStatus,
  type TurnDispatchMode,
} from "@penkra/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayToolBridge } from "../Services/AgentGatewayToolBridge.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type AgentGatewayProviderAvailability } from "../targetResolver.ts";
import { mcpToolResultError, mcpToolResultImage, mcpToolResultJson } from "../protocol.ts";
import { gatewayIsoNow as isoNow } from "../creationUtils.ts";
import {
  MODEL_SELECTION_INPUT_SCHEMA,
  PROVIDER_KINDS,
  ToolInputError,
  decodeCreateThreadInput,
  errorText,
  readRecordArg,
  readStringArg,
} from "../toolInput.ts";
import {
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "../toolRuntime.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import {
  agentGatewayCommandCatalog,
  invokeResolvedAgentGatewayCommand,
  resolveAgentGatewayCommand,
  type AgentGatewayCommandEntry,
} from "../commandSurface.ts";
import { makeCreateThreadHandler } from "../creationCoordinator.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { makeThreadDiagnosticTools } from "../threadDiagnosticTools.ts";
import { executePenkraExecCommand, penkraRootInstructions } from "../../appRuntimeCli.ts";
import type { PenkraExecCommandInput, PenkraExecFlagValue } from "../../appRuntimeCli.ts";
import { requireThreadSpaceId } from "../threadSpaceContext.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderThreadSwitchCoordinator } from "../../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { attachmentPrincipalForSession } from "../../managedAttachmentPrincipal.ts";
import {
  PENKRA_EXEC_COMMAND_ANNOTATIONS,
  PENKRA_EXEC_COMMAND_DESCRIPTION,
  PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
  PENKRA_EXEC_COMMAND_NAME,
} from "../hostToolContract.ts";

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const toolBridge = yield* AgentGatewayToolBridge;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerTurnSelectionResolver = yield* ProviderTurnSelectionResolver;
  const providerThreadSwitchCoordinator = yield* ProviderThreadSwitchCoordinator;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const projectionTurns = yield* ProjectionTurnRepository;
  const eventStore = yield* OrchestrationEventStore;
  const eventDeliveries = yield* OrchestrationEventDeliveryRepository;
  const providerRuntimeEvents = yield* ProviderRuntimeEventRepository;
  const diagnostics = yield* ThreadDiagnosticsQuery;
  const serverConfig = yield* ServerConfig;
  const loadProviderAvailabilities = Effect.gen(function* () {
    const [settings, statuses] = yield* Effect.all([
      serverSettings.getSettings,
      providerHealth.getStatuses,
    ]);
    const statusByProvider = new Map<ProviderKind, ServerProviderStatus>(
      statuses.map((status) => [status.provider, status]),
    );
    return new Map<ProviderKind, AgentGatewayProviderAvailability>(
      PROVIDER_KINDS.map((provider) => {
        const status = statusByProvider.get(provider);
        return [
          provider,
          {
            enabled: settings.providers[provider].enabled,
            ...(status
              ? {
                  available: status.available,
                  authStatus: status.authStatus,
                  ...(status.message ? { message: status.message } : {}),
                }
              : {}),
          },
        ];
      }),
    );
  });

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
          onSome: (shell) => Effect.succeed(shell),
        }),
      ),
    );

  // Privilege boundary shared by every tool that makes another thread execute
  // work or mutates another thread's state: a caller must not drive a thread
  // that runs with more privileges than the user granted the caller itself —
  // otherwise an approval-required agent escalates by proxy.
  const assertCallerMayDriveThread = (
    caller: { readonly runtimeMode: string },
    target: {
      readonly id: string;
      readonly runtimeMode: string;
    },
  ) =>
    Effect.gen(function* () {
      if (target.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs in "full-access" mode but your thread is "approval-required"; you cannot drive higher-privileged threads. Ask the user to do this or to elevate your thread.`,
          ),
        );
      }
    });

  const readTools = makeThreadReadTools({
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths: {
      homeDir: serverConfig.homeDir,
      chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
    },
  });
  const diagnosticTools = makeThreadDiagnosticTools({
    snapshotQuery,
    diagnostics,
    eventStore,
    providerRuntimeEvents,
    eventDeliveries,
    requireThreadShell,
  });

  // --- write tools ----------------------------------------------------------

  const runCreateThread = yield* makeCreateThreadHandler({
    snapshotQuery,
    orchestrationEngine,
    providerDiscovery,
    providerTurnSelectionResolver,
    providerThreadSwitchCoordinator,
    loadProviderAvailabilities,
    requireThreadShell,
  });

  const createThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "penkra_create_thread",
      description:
        "Create one standalone Penkra thread. Retrying the same requestId is idempotent. Multiple create calls are independent and are not atomic: if a later call fails, earlier threads remain.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256 },
          prompt: { type: "string" },
          title: { type: "string" },
          target: {
            ...MODEL_SELECTION_INPUT_SCHEMA,
          },
          folderId: { type: "string" },
          runtimeMode: { type: "string", enum: ["approval-required", "full-access"] },
        },
        required: ["requestId", "prompt", "target"],
        additionalProperties: false,
      },
      annotations: { title: "Create a Penkra thread", ...IDEMPOTENT_WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.suspend(() =>
        runCreateThread(decodeCreateThreadInput(args), {
          kind: "provider-session",
          callerThreadId: context.callerThreadId,
          callerTurnId: context.callerTurnId,
          assertAuthority: context.assertCallerTurnActive,
          attachmentPrincipal: attachmentPrincipalForSession(context.callerSessionKey),
        }),
      ).pipe(Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const sendMessage: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "penkra_send_message",
      description:
        'Send a Penkra follow-up message to an existing thread. mode "queue" (default) waits for the current turn; "steer" redirects a running turn where the provider supports it (otherwise it is queued).',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Target thread." },
          message: { type: "string", description: "Message text." },
          mode: { type: "string", enum: ["queue", "steer"], description: "Dispatch mode." },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Send a Penkra message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", { required: true })!;
        if (threadId === context.callerThreadId) {
          throw new ToolInputError(
            "Cannot send to the caller Thread: send writes an agent-authored message with user role and starts another turn on top of the current turn.",
          );
        }
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError(`Argument "mode" must be "queue" or "steer".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        // Pass the requested mode through unchanged: the reactor checks live
        // provider state (authoritative, unlike this projection snapshot) and
        // already downgrades steers whose turn is not actually live.
        const dispatchMode: TurnDispatchMode = modeArg;
        const suffix = randomUUID();
        const cwd = target.workingDirectory;
        yield* providerThreadSwitchCoordinator
          .dispatchTurnStart({
            command: {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`agent:${suffix}:send`),
              threadId: target.id,
              message: {
                messageId: MessageId.makeUnsafe(`agent:${suffix}:message`),
                role: "user",
                text: message,
                attachments: [],
              },
              dispatchMode,
              dispatchOrigin: "agent",
              runtimeMode: target.runtimeMode,
              createdAt: isoNow(),
            },
            attachmentPrincipal: attachmentPrincipalForSession(context.callerSessionKey),
            ...(cwd ? { cwd } : {}),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, dispatched: dispatchMode });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const interruptThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "penkra_interrupt_thread",
      description: "Interrupt the running turn of a Penkra thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose turn should be interrupted." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Interrupt a Penkra thread",
        ...DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        // Stopping a higher-privileged thread's work is still driving it.
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:interrupt`),
            threadId: target.id,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, interrupted: true });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadTitle: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "penkra_set_thread_title",
      description: "Rename a Penkra thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to rename." },
          title: { type: "string", description: "New title." },
        },
        required: ["threadId", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Rename a Penkra thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const title = readStringArg(args, "title", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:rename`),
            threadId: target.id,
            title,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, title });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const makeSetThreadArchived = (archived: boolean): ToolEntry => ({
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: archived ? "penkra_archive_thread" : "penkra_unarchive_thread",
      description: `${archived ? "Archive" : "Unarchive"} a Penkra thread. The target threadId is required.`,
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: `Thread to ${archived ? "archive" : "unarchive"}.`,
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: {
        title: `${archived ? "Archive" : "Unarchive"} a Penkra thread`,
        ...(archived ? DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS),
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: archived ? "thread.archive" : "thread.unarchive",
            commandId: CommandId.makeUnsafe(
              `agent:${randomUUID()}:${archived ? "archive" : "unarchive"}`,
            ),
            threadId: target.id,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, archived });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  });
  const archiveThread = makeSetThreadArchived(true);
  const unarchiveThread = makeSetThreadArchived(false);

  const internalCommandTools = [
    ...readTools,
    ...diagnosticTools,
    createThread,
    sendMessage,
    interruptThread,
    setThreadTitle,
    archiveThread,
    unarchiveThread,
  ] as const;
  const requireInternalTool = (name: string): ToolEntry => {
    const tool = internalCommandTools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`Missing internal Penkra command handler ${name}.`);
    return tool;
  };
  const gatewayCommands: ReadonlyArray<AgentGatewayCommandEntry> = [
    { words: ["context"], tool: requireInternalTool("penkra_context") },
    { words: ["capabilities"], tool: requireInternalTool("penkra_capabilities") },
    { words: ["folders", "list"], tool: requireInternalTool("penkra_list_folders") },
    { words: ["threads", "list"], tool: requireInternalTool("penkra_list_threads") },
    { words: ["threads", "read"], tool: requireInternalTool("penkra_read_thread") },
    { words: ["threads", "wait"], tool: requireInternalTool("penkra_wait_for_threads") },
    {
      words: ["threads", "activity"],
      tool: requireInternalTool("penkra_read_thread_activity"),
    },
    { words: ["threads", "events"], tool: requireInternalTool("penkra_read_thread_events") },
    {
      words: ["threads", "runtime-events"],
      tool: requireInternalTool("penkra_read_thread_runtime_events"),
    },
    { words: ["threads", "diagnose"], tool: requireInternalTool("penkra_diagnose_thread") },
    {
      words: ["threads", "retry-projection"],
      tool: requireInternalTool("penkra_retry_thread_projection"),
    },
    { words: ["threads", "create"], tool: createThread },
    { words: ["threads", "send"], tool: sendMessage },
    { words: ["threads", "interrupt"], tool: interruptThread },
    { words: ["threads", "rename"], tool: setThreadTitle },
    {
      words: ["threads", "archive"],
      tool: archiveThread,
    },
    {
      words: ["threads", "unarchive"],
      tool: unarchiveThread,
    },
  ];

  const penkraExecCommand: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: PENKRA_EXEC_COMMAND_NAME,
      description: PENKRA_EXEC_COMMAND_DESCRIPTION,
      inputSchema: PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
      annotations: PENKRA_EXEC_COMMAND_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const rawCommand = args.command;
        if (
          !Array.isArray(rawCommand) ||
          rawCommand.length === 0 ||
          !rawCommand.every((word) => typeof word === "string" && word.length > 0)
        ) {
          return yield* Effect.fail(
            new ToolInputError("command must be a non-empty array of non-empty strings."),
          );
        }
        const rawFlags = args.flags;
        if (
          rawFlags !== undefined &&
          (!rawFlags ||
            typeof rawFlags !== "object" ||
            Array.isArray(rawFlags) ||
            !Object.values(rawFlags).every(
              (value) =>
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean",
            ))
        ) {
          return yield* Effect.fail(
            new ToolInputError("flags must contain only string, number, or boolean values."),
          );
        }
        const tabId = args.tabId;
        if (tabId !== undefined && (typeof tabId !== "string" || !tabId)) {
          return yield* Effect.fail(new ToolInputError("tabId must be a non-empty string."));
        }
        const commandInput: PenkraExecCommandInput = {
          command: rawCommand,
          ...(args.input === undefined ? {} : { input: args.input }),
          ...(rawFlags === undefined
            ? {}
            : { flags: rawFlags as Record<string, PenkraExecFlagValue> }),
          ...(tabId === undefined ? {} : { tabId }),
        };
        const resolution = resolveAgentGatewayCommand(commandInput, gatewayCommands);
        if (resolution.kind === "result") return resolution.result;
        if (resolution.kind === "call") {
          return yield* invokeResolvedAgentGatewayCommand({ resolution, context });
        }

        const caller = yield* requireThreadShell(context.callerThreadId);
        const callerSpaceId = yield* requireThreadSpaceId(snapshotQuery, caller);
        if (!context.callerCapabilities.has("thread:write")) {
          return yield* Effect.fail(
            new ToolInputError("This provider session cannot execute mutable Penkra commands."),
          );
        }
        yield* context.assertCallerTurnActive();
        const result = yield* Effect.tryPromise({
          try: () =>
            executePenkraExecCommand(commandInput, {
              spaceId: callerSpaceId,
              threadId: caller.id,
              workingDirectory: caller.workingDirectory ?? null,
              additionalCoreCommands: agentGatewayCommandCatalog(gatewayCommands),
            }),
          catch: (error) => new ToolInputError(errorText(error)),
        });
        if (isPenkraExecImage(result)) {
          return mcpToolResultImage({
            data: result.data,
            mimeType: result.mimeType,
            description: "Screenshot of the explicitly targeted Penkra App tab.",
          });
        }
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  function isPenkraExecImage(
    value: unknown,
  ): value is { kind: "image"; data: string; mimeType: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      record.kind === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    );
  }

  const tools: ReadonlyArray<ToolEntry> = [penkraExecCommand];
  const handleMcpPost = makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools,
    instructions: (context) =>
      Effect.tryPromise({
        try: async () => {
          const caller = await Effect.runPromise(requireThreadShell(context.callerThreadId));
          const spaceId = await Effect.runPromise(requireThreadSpaceId(snapshotQuery, caller));
          const coreCommands = agentGatewayCommandCatalog(gatewayCommands);
          if (!process.env.PENKRA_APP_COMMAND_PIPE) {
            return penkraRootInstructions([], coreCommands);
          }
          const instructions = await executePenkraExecCommand(
            { command: ["penkra", "--help"] },
            {
              spaceId,
              threadId: caller.id,
              workingDirectory: caller.workingDirectory ?? null,
              additionalCoreCommands: coreCommands,
            },
          );
          if (typeof instructions !== "string") {
            throw new Error("Penkra root help did not return its instruction document.");
          }
          return instructions;
        },
        catch: (error) => new ToolInputError(errorText(error)),
      }),
    requireThreadShell,
  });
  const invokeTool: AgentGatewayShape["invokeTool"] = (input) =>
    handleMcpPost({
      authorizationHeader: `Bearer ${input.bearerToken}`,
      body: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name: input.name, arguments: input.arguments },
      },
    }).pipe(
      Effect.map((response) => {
        if (response.status !== 200 || !response.body || typeof response.body !== "object") {
          return mcpToolResultError(`Penkra host tool request failed (${response.status}).`);
        }
        const body = response.body as Record<string, unknown>;
        const result = body.result;
        if (
          !result ||
          typeof result !== "object" ||
          !Array.isArray((result as { content?: unknown }).content)
        ) {
          const rpcError = body.error as { message?: unknown } | undefined;
          return mcpToolResultError(
            typeof rpcError?.message === "string"
              ? rpcError.message
              : "Penkra host tool returned an invalid result.",
          );
        }
        return result as ReturnType<typeof mcpToolResultError>;
      }),
    );
  const service = {
    toolDefinitions: tools.map((tool) => tool.definition),
    invokeTool,
    handleMcpPost,
  } satisfies AgentGatewayShape;
  toolBridge.install({
    definitions: service.toolDefinitions,
    invoke: (input) => Effect.runPromise(service.invokeTool(input)),
  });
  return service;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);
