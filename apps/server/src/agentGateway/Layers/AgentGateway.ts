import { ThreadRunningError } from "../../cleanCore/threadStore.ts";
import { ThreadLifecycle } from "../../cleanCore/threadLifecycle.ts";
/**
 * AgentGatewayLive - Penkra app-control MCP tool surface.
 *
 * Implements the single `penkra_exec_command` tool served over `POST /mcp`
 * (streamable HTTP, stateless JSON responses). Every provider session gets
 * this endpoint plus a thread-bound bearer token injected at session start, so
 * any agent running in a Penkra thread can use Penkra's registered commands.
 *
 * All tools delegate to canonical thread services (admission,
 * ThreadReads reads); no orchestration
 * state lives here.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { randomUUID } from "node:crypto";

import {
  MessageId,
  ThreadId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@penkra/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import { findThreadPolicyError } from "../../cleanCore/threadErrors.ts";
import { ThreadReads } from "../../cleanCore/ThreadReads.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayToolBridge } from "../Services/AgentGatewayToolBridge.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { type AgentGatewayProviderAvailability } from "../targetResolver.ts";
import {
  extractPenkraExecRichResult,
  mcpToolResultError,
  mcpToolResultImage,
  mcpToolResultJson,
  mcpToolResultRich,
  mcpToolErrorResult,
} from "../protocol.ts";
import { gatewayIsoNow as isoNow } from "../creationUtils.ts";
import {
  MODEL_SELECTION_INPUT_SCHEMA,
  PROVIDER_KINDS,
  ToolInputError,
  decodeCreateThreadInput,
  decodeSendMessageInput,
  errorText,
  readStringArrayArg,
  readStringArg,
} from "../toolInput.ts";
import {
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolEntry,
  type ToolContext,
} from "../toolRuntime.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import {
  agentGatewayCommandCatalog,
  invokeResolvedAgentGatewayCommand,
  resolveAgentGatewayCommand,
  type AgentGatewayCommandEntry,
} from "../commandSurface.ts";
import { makeCreateThreadHandler } from "../creationCoordinator.ts";
import { requestAppRuntimeBridge } from "../../appRuntimeCli.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { executePenkraExecCommand } from "../../appRuntimeCli.ts";
import type { PenkraExecCommandInput } from "../../appRuntimeCli.ts";
import { requireThreadSpaceId } from "../threadSpaceContext.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
} from "../../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { attachmentPrincipalForSession } from "../../managedAttachmentPrincipal.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import {
  PENKRA_EXEC_COMMAND_ANNOTATIONS,
  PENKRA_EXEC_COMMAND_DESCRIPTION,
  PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
  PENKRA_EXEC_COMMAND_NAME,
} from "../hostToolContract.ts";
import { renderPenkraMcpServerInstructions } from "../harnessPolicy.ts";
import { presentFile, resolvePresentFileCwd } from "../presentFile.ts";
import { ThreadSender } from "../../cleanCore/ThreadSender.ts";

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

function command(
  words: ReadonlyArray<string>,
  tool: ToolEntry,
  example: string | ReadonlyArray<{ readonly name: string; readonly command: string }>,
  instructions?: string,
): AgentGatewayCommandEntry {
  return {
    words,
    tool,
    examples:
      typeof example === "string"
        ? [{ name: `Use ${["penkra", ...words].join(" ")}`, command: example }]
        : example,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function sendMessageErrorResult(error: unknown) {
  if (error instanceof GatewayToolError) return gatewayToolErrorResult(error);
  const threadGuard = findThreadPolicyError(error);
  if (threadGuard?.code === "thread_archived") {
    return gatewayToolErrorResult(new GatewayToolError(threadGuard.code, threadGuard.detail));
  }
  if (error instanceof ProviderThreadSwitchCoordinatorError) {
    return gatewayToolErrorResult(new GatewayToolError(error.code, error.message));
  }
  return mcpToolErrorResult(error);
}

export const makeAgentGateway = Effect.gen(function* () {
  const sender = yield* ThreadSender;
  const lifecycle = yield* ThreadLifecycle;
  const credentials = yield* AgentGatewayCredentials;
  const toolBridge = yield* AgentGatewayToolBridge;
  const snapshotQuery = yield* ThreadReads;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const providerTurnSelectionResolver = yield* ProviderTurnSelectionResolver;
  const providerThreadSwitchCoordinator = yield* ProviderThreadSwitchCoordinator;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const connections = yield* ProviderConnectionRepository;
  const serverConfig = yield* ServerConfig;
  const managedAttachments = yield* ManagedAttachmentRepository;
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

  const requireCanonicalThread = (id: string) =>
    lifecycle.get(ThreadId.makeUnsafe(id)).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap((row) =>
        row === null || row.deletedAt !== null
          ? Effect.fail(new ToolInputError(`Thread "${id}" was not found.`))
          : Effect.succeed(row),
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
    loadConnections: connections.list(),
    loadSettings: serverSettings.getSettings,
    snapshotQuery,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths: {
      homeDir: serverConfig.homeDir,
      chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
    },
  });

  // --- write tools ----------------------------------------------------------

  const runCreateThread = yield* makeCreateThreadHandler({
    stateDir: serverConfig.stateDir,
    lifecycle,
    sender,
    snapshotQuery,
    providerDiscovery,
    providerTurnSelectionResolver,
    loadProviderAvailabilities,
    onThreadCreated: (creatorThreadId, childThreadId) =>
      Effect.tryPromise(() =>
        requestAppRuntimeBridge("thread.home.inherit", { creatorThreadId, childThreadId }),
      ).pipe(Effect.asVoid),
  });

  const createThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresThreadAuthority: true,
    requiresActiveTurn: true,
    definition: {
      name: "penkra_create_thread",
      description:
        "Use when work should run in a separate Penkra conversation. The returned sendAdmission confirms the initial message was persisted. Read the thread for the provider outcome. Create one standalone Thread from a self-contained prompt and a target returned by `penkra models list --availability available`; optionally choose a Connection from `penkra connections list` and a folder from `penkra folders list`. Retrying the same requestId is idempotent. Separate create calls are independent and non-atomic, so retain successful Thread ids if a later call fails.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            maxLength: 256,
            description:
              "Stable caller-chosen idempotency key for this one creation attempt; reuse it only when retrying the same request.",
          },
          prompt: {
            type: "string",
            description:
              "Self-contained instructions for the new thread, which cannot read the caller's conversation.",
          },
          title: {
            type: "string",
            description: "Optional short outcome-oriented title shown in Penkra.",
          },
          target: {
            ...MODEL_SELECTION_INPUT_SCHEMA,
            description: "Provider and model for the new thread.",
          },
          connectionId: {
            type: ["string", "null"],
            description:
              "Exact Connection from capabilities. Omit to use the default; null requests an anonymous route. Never substitutes another account.",
          },
          folderId: {
            type: "string",
            description: "Optional exact Penkra folder id; defaults to the caller's folder.",
          },
          runtimeMode: {
            type: "string",
            enum: ["approval-required", "full-access"],
            description: "Permission mode for the new thread; defaults to the caller's mode.",
          },
        },
        required: ["requestId", "prompt", "target"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Penkra thread",
        ...IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
      },
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
      ).pipe(Effect.catchDefect((error) => Effect.succeed(mcpToolErrorResult(error)))),
  };

  const sendMessage: ToolEntry = {
    requiredCapability: "thread:write",
    requiresThreadAuthority: true,
    requiresActiveTurn: true,
    definition: {
      name: "penkra_send_message",
      description:
        "Post an agent-authored follow-up into another existing Penkra thread. Never target the caller thread. By default the message waits behind the thread's running and queued work, in order. Pass now only when it must take effect right away; Penkra chooses the provider-specific way to deliver it. To switch the target thread's Connection or model, pass connectionId, modelSelection, or both. The switch takes effect when this message's turn starts and stays for later turns. The provider cannot change: to use another provider, create a new thread. Penkra never falls back to another account. The admission reply confirms persistence, not provider acceptance: deliver, steer and interrupt-deliver include the transcript seq; queue includes position and queueLength. Read the thread for the outcome: sending becomes delivered or failed. A failed direct message stays in the transcript and joins the next send; no automatic retry occurs. A rejection before admission is an error and writes nothing.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact target Penkra thread id; it must differ from the caller thread id.",
          },
          message: {
            type: "string",
            description:
              "Self-contained follow-up text recorded with user role as sent by the agent.",
          },
          now: {
            type: "boolean",
            description:
              "Request action during a running turn: native steer where supported, otherwise interrupt that turn and run this message afterward. Without now, wait in FIFO until the running turn ends.",
          },
          connectionId: {
            type: ["string", "null"],
            description:
              "Exact Connection ID from `penkra connections list`. Omit to keep the thread's current Connection. Pass null only to request the provider's anonymous route where it is authorized. Never substitutes another account.",
          },
          modelSelection: {
            ...MODEL_SELECTION_INPUT_SCHEMA,
            description:
              "Model to use from this turn on. provider must be the thread's current provider. Omit to keep the current model.",
          },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      annotations: {
        title: "Send a Penkra message",
        ...WRITE_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = decodeSendMessageInput(args);
        const threadId = input.threadId;
        const message = input.message;
        if (threadId === context.callerThreadId) {
          throw new ToolInputError(
            "Cannot send to the caller Thread: send writes an agent-authored message with user role and starts another turn on top of the current turn.",
          );
        }
        const now = input.now ?? false;
        const caller = yield* requireCanonicalThread(context.callerThreadId);
        const target = yield* requireCanonicalThread(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        const result = yield* sender.send({
          threadId: target.id,
          message: {
            messageId: MessageId.makeUnsafe(randomUUID()),
            text: message,
            attachments: [],
            origin: { _tag: "agent", senderThreadId: ThreadId.makeUnsafe(context.callerThreadId) },
            queuedAt: isoNow(),
          },
          dispatchMode: now ? "steer" : "queue",
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        });
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(sendMessageErrorResult(error)))),
  };

  const steerMessage: ToolEntry = {
    requiredCapability: "thread:write",
    requiresThreadAuthority: true,
    requiresActiveTurn: true,
    definition: {
      name: "penkra_steer_message",
      description:
        "Deliver an already-queued message now in another Penkra thread. Supply its exact threadId and messageId from the send admission or thread read. You may steer only a message your own thread queued. This does not create a message or touch the composer. Penkra uses native steer where supported, otherwise interrupts and delivers next. The reply is the admission; read the thread for the provider outcome.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Exact target Penkra thread id." },
          messageId: { type: "string", description: "Exact id of your already-queued message." },
        },
        required: ["threadId", "messageId"],
        additionalProperties: false,
      },
      annotations: { title: "Steer a queued Penkra message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId");
        const messageId = readStringArg(args, "messageId");
        if (!threadId || !messageId) throw new ToolInputError("Supply threadId and messageId.");
        if (threadId === context.callerThreadId)
          throw new ToolInputError("Cannot steer a message in the caller thread.");
        const caller = yield* requireCanonicalThread(context.callerThreadId);
        const target = yield* requireCanonicalThread(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        return mcpToolResultJson(
          yield* sender.steerQueued(
            {
              threadId: target.id,
              messageId: MessageId.makeUnsafe(messageId),
            },
            ThreadId.makeUnsafe(context.callerThreadId),
          ),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(sendMessageErrorResult(error)))),
  };

  const interruptThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresThreadAuthority: true,
    requiresActiveTurn: true,
    definition: {
      name: "penkra_interrupt_thread",
      description:
        "Use threadId to request interruption of the running turn; it has no effect when idle. Use messageId to remove a queued message; it has no effect if that message is not queued. A message id never interrupts a started turn. The provider end event confirms stopping.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread whose running turn should be interrupted.",
          },
          messageId: {
            type: "string",
            description:
              "Queued message to remove. With threadId, cancellation is scoped to that thread.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "Interrupt a Penkra thread", ...DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const requestedThreadId = readStringArg(args, "threadId");
        const messageId = readStringArg(args, "messageId");
        if (!requestedThreadId && !messageId)
          throw new ToolInputError("Supply threadId or messageId.");
        const caller = yield* requireCanonicalThread(context.callerThreadId);
        const threadId =
          requestedThreadId === undefined
            ? yield* sender.queuedThread(messageId!)
            : ThreadId.makeUnsafe(requestedThreadId);
        if (threadId === null)
          return mcpToolResultJson({ threadId: null, messageId, removed: false });
        const target = yield* requireCanonicalThread(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        const result =
          messageId === undefined
            ? yield* sender.interrupt(target.id)
            : yield* sender.cancelQueued({ threadId: target.id, messageId });
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolErrorResult(error)))),
  };

  const makeSetThreadArchived = (archived: boolean): ToolEntry => ({
    requiredCapability: "thread:write",
    requiresThreadAuthority: true,
    requiresActiveTurn: true,
    definition: {
      name: archived ? "penkra_archive_thread" : "penkra_unarchive_thread",
      description: archived
        ? "Use to hide an inactive Penkra Thread from normal listings without deleting its transcript. Archived Threads remain discoverable with includeArchived and can be restored with `penkra threads unarchive`."
        : "Use to restore an archived Penkra thread to normal listings. This preserves its existing transcript and does not start a new turn.",
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
        const caller = yield* requireCanonicalThread(context.callerThreadId);
        const target = yield* requireCanonicalThread(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        const updatedAt = new Date().toISOString();
        yield* lifecycle
          .update({
            action: "archive",
            threadId: target.id,
            archivedAt: archived ? updatedAt : null,
            updatedAt,
          })
          .pipe(
            Effect.mapError((error) =>
              error instanceof ThreadRunningError
                ? new GatewayToolError(error.code, error.message)
                : new ToolInputError(errorText(error)),
            ),
          );
        return mcpToolResultJson({ threadId: target.id, archived });
      }).pipe(
        Effect.catch((error) => {
          return Effect.succeed(
            error instanceof GatewayToolError
              ? gatewayToolErrorResult(error)
              : mcpToolErrorResult(error),
          );
        }),
      ),
  });
  const archiveThread = makeSetThreadArchived(true);
  const unarchiveThread = makeSetThreadArchived(false);

  const internalCommandTools = [
    ...readTools,
    createThread,
    sendMessage,
    steerMessage,
    interruptThread,
    archiveThread,
    unarchiveThread,
    {
      requiredCapability: "thread:write",
      requiresThreadAuthority: true,
      requiresActiveTurn: true,
      definition: {
        name: "penkra_show_file",
        description:
          "Present local files at this point in the caller Thread. One image appears inline; multiple images in one call form a switchable gallery. Other files appear as downloadable cards. Penkra stores durable copies, so the display survives source-file deletion and Thread reload. Paths are resolved relative to this Thread's working directory. This operation never sends files to another Thread or external service.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              description:
                "Local file paths in display order. Repeat --path to present several images as one gallery.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        annotations: { title: "Show a file in this Thread", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args: Record<string, unknown>, context: ToolContext) =>
        Effect.gen(function* () {
          const requestedPaths = readStringArrayArg(args, "path");
          if (!requestedPaths?.length) {
            return yield* Effect.fail(new ToolInputError("At least one --path is required."));
          }
          const caller = yield* requireCanonicalThread(context.callerThreadId);
          const folder = yield* snapshotQuery.getFolderShellById(caller.folderId);
          const cwd = resolvePresentFileCwd({
            threadId: caller.id,
            projectCwd: Option.isSome(folder) ? folder.value.workspaceRoot : null,
            stateDir: serverConfig.stateDir,
          });
          const presentationId = requestedPaths.length > 1 ? randomUUID() : undefined;
          const results = yield* Effect.forEach(requestedPaths, (requestedPath, index) =>
            presentFile({
              requestedPath,
              cwd,
              threadId: caller.id,
              turnId: context.callerTurnId,
              attachmentsDir: serverConfig.attachmentsDir,
              stateDir: serverConfig.stateDir,
              repository: managedAttachments,
              publisher,
              assertActive: context.assertCallerTurnActive,
              ...(presentationId === undefined ? {} : { presentationId, presentationIndex: index }),
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          );
          return mcpToolResultJson(results.length === 1 ? results[0] : { items: results });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolErrorResult(error)))),
    } satisfies ToolEntry,
  ] as const;
  const requireInternalTool = (name: string): ToolEntry => {
    const tool = internalCommandTools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`Missing internal Penkra command handler ${name}.`);
    return tool;
  };
  const gatewayCommands: ReadonlyArray<AgentGatewayCommandEntry> = [
    command(["context"], requireInternalTool("penkra_context"), "penkra context"),
    command(
      ["show"],
      requireInternalTool("penkra_show_file"),
      "penkra show --path ./logo.png",
      "Repeat --path in one call, in display order, to make a switchable gallery of images. A single path keeps the normal inline image or download card.",
    ),
    command(
      ["connections", "list"],
      requireInternalTool("penkra_list_connections"),
      "penkra connections list --provider codex",
    ),
    command(
      ["models", "list"],
      requireInternalTool("penkra_list_models"),
      "penkra models list --availability available --provider opencode",
    ),
    command(["folders", "list"], requireInternalTool("penkra_list_folders"), "penkra folders list"),
    command(
      ["threads", "list"],
      requireInternalTool("penkra_list_threads"),
      "penkra threads list --limit 50",
    ),
    command(
      ["threads", "read"],
      requireInternalTool("penkra_read_thread"),
      "penkra threads read --thread-id <thread-id> [--turn-id <penkra-turn-handle>]",
    ),
    command(
      ["threads", "create"],
      createThread,
      'penkra threads create --input \'{"requestId":"review-api","prompt":"Review the API contract.","target":{...}}\'',
    ),
    command(["threads", "send"], sendMessage, [
      {
        name: "Send a follow-up",
        command: "penkra threads send --thread-id <thread-id> --message 'Continue the review.'",
      },
      {
        name: "Send and switch model and Connection",
        command: `penkra threads send --input '{"threadId":"<thread-id>","message":"Continue the review.","connectionId":"<connection-id>","modelSelection":{"provider":"codex","model":"gpt-6-sol"}}'`,
      },
    ]),
    command(
      ["threads", "steer"],
      steerMessage,
      "penkra threads steer --thread-id <thread-id> --message-id <message-id>",
    ),
    command(
      ["threads", "interrupt"],
      interruptThread,
      "penkra threads interrupt --thread-id <thread-id>",
    ),
    command(
      ["threads", "archive"],
      archiveThread,
      "penkra threads archive --thread-id <thread-id>",
    ),
    command(
      ["threads", "unarchive"],
      unarchiveThread,
      "penkra threads unarchive --thread-id <thread-id>",
    ),
  ];

  const penkraExecCommand: ToolEntry = {
    requiredCapability: "thread:read",
    requiresThreadAuthority: true,
    definition: {
      name: PENKRA_EXEC_COMMAND_NAME,
      description: PENKRA_EXEC_COMMAND_DESCRIPTION,
      inputSchema: PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
      annotations: PENKRA_EXEC_COMMAND_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const rawCommand = args.command;
        if (typeof rawCommand !== "string" || !rawCommand.trim()) {
          return yield* Effect.fail(new ToolInputError("command must be a non-empty string."));
        }
        const commandInput: PenkraExecCommandInput = { command: rawCommand };
        const resolution = resolveAgentGatewayCommand(commandInput, gatewayCommands);
        if (resolution.kind === "result") return resolution.result;
        if (resolution.kind === "call") {
          return yield* invokeResolvedAgentGatewayCommand({
            resolution,
            context,
          });
        }

        const caller = yield* requireCanonicalThread(context.callerThreadId);
        const callerSpaceId = yield* requireThreadSpaceId(snapshotQuery, caller);
        if (!context.callerCapabilities.has("thread:write")) {
          return yield* Effect.fail(
            new ToolInputError("This provider session cannot execute mutable Penkra commands."),
          );
        }
        yield* context.assertCallerTurnActive();
        const folder = yield* snapshotQuery.getFolderShellById(caller.folderId);
        const cwd = resolvePresentFileCwd({
          threadId: caller.id,
          projectCwd: Option.isSome(folder) ? folder.value.workspaceRoot : null,
          stateDir: serverConfig.stateDir,
        });
        const result = yield* Effect.tryPromise({
          try: () =>
            executePenkraExecCommand(commandInput, {
              spaceId: callerSpaceId,
              folderId: caller.folderId,
              threadId: caller.id,
              callerTurnId: context.callerWriteTurnId,
              cwd,
              additionalCoreCommands: agentGatewayCommandCatalog(gatewayCommands),
            }),
          catch: (error) => new ToolInputError(errorText(error)),
        });
        if (isPenkraExecImage(result)) {
          return mcpToolResultImage({
            data: result.data,
            mimeType: result.mimeType,
            description:
              "Screenshot of the App tab visible in the exact window surface for this agent turn.",
          });
        }
        const rich = extractPenkraExecRichResult(result);
        if (rich) {
          return mcpToolResultRich({
            content: [
              {
                type: "text",
                text: JSON.stringify(rich.structuredContent, null, 2),
              },
              ...rich.content,
            ],
            structuredContent: rich.structuredContent,
          });
        }
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolErrorResult(error)))),
  };

  const tools: ReadonlyArray<ToolEntry> = [penkraExecCommand];
  const handleMcpPost = makeAgentGatewayMcpTransport({
    stateDir: serverConfig.stateDir,
    credentials,
    snapshotQuery,
    tools,
    instructions: () => Effect.succeed(renderPenkraMcpServerInstructions()),
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
      ...(input.originTurnId !== undefined ? { originTurnId: input.originTurnId } : {}),
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
