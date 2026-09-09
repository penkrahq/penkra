import {
  CommandId,
  EventId,
  FolderId,
  OrchestrationCommand,
  PenkraCreateThreadResult,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type PenkraCreateThreadInput,
  type ProviderKind,
  type ThreadRuntimeBinding,
} from "@penkra/contracts";
import { buildPromptThreadTitleFallback } from "@penkra/shared/chatThreads";
import { Effect, Option, Schema } from "effect";

import type { ManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import type {
  AgentGatewayCreationAdmission,
  AgentGatewayCreationAdmissionRepositoryShape,
} from "../persistence/Services/AgentGatewayCreationAdmissions.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import type { ThreadDiagnosticsQueryShape } from "../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { gatewayIsoNow, makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import { extractGatewayErrorProvenance } from "./errorProvenance.ts";
import { mcpToolResultJson } from "./protocol.ts";
import {
  AgentGatewayTargetError,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { GatewayToolError, gatewayToolErrorResult } from "./toolRuntime.ts";

const REQUEST_FINGERPRINT_VERSION = 1;
const CREATION_PLAN_SCHEMA_VERSION = 1;

interface CreationCoordinatorDependencies {
  readonly diagnostics: ThreadDiagnosticsQueryShape;
  readonly admissions: AgentGatewayCreationAdmissionRepositoryShape;
  readonly commandReceipts: OrchestrationCommandReceiptRepositoryShape;
  readonly loadExistingBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadRuntimeBinding>, unknown>;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly providerTurnSelectionResolver: ProviderTurnSelectionResolverShape;
  readonly providerThreadSwitchCoordinator: ProviderThreadSwitchCoordinatorShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
}

export interface GatewayCreationContext {
  readonly kind: "provider-session";
  readonly callerThreadId: string;
  readonly callerTurnId: string | null;
  readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

const decodeCommand = (json: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(OrchestrationCommand)(JSON.parse(json)),
    catch: (cause) => new ToolInputError(`Stored creation command is invalid: ${errorText(cause)}`),
  });
const decodeResult = (json: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PenkraCreateThreadResult)(JSON.parse(json)),
    catch: (cause) => new ToolInputError(`Stored creation result is invalid: ${errorText(cause)}`),
  });

/** Request ids select one durable, immutable resolved creation plan. */
export const makeCreateThreadHandler = Effect.fn(function* (
  dependencies: CreationCoordinatorDependencies,
) {
  const {
    diagnostics,
    admissions,
    commandReceipts,
    snapshotQuery,
    orchestrationEngine,
    providerDiscovery,
    providerTurnSelectionResolver,
    providerThreadSwitchCoordinator,
    loadProviderAvailabilities,
    requireThreadShell,
  } = dependencies;

  return (input: PenkraCreateThreadInput, context: GatewayCreationContext) => {
    const operationIdForError =
      context.callerTurnId === null
        ? null
        : `gateway:create:${stableGatewayDigest({
            principalKind: context.kind,
            principalId: context.callerThreadId,
            callerTurnId: context.callerTurnId,
            requestId: input.requestId,
          })}`;
    const idsForError =
      context.callerTurnId === null
        ? null
        : makeAgentCreationIds(
            `gateway:create:${stableGatewayDigest({
              principalKind: context.kind,
              principalId: context.callerThreadId,
              callerTurnId: context.callerTurnId,
              requestId: input.requestId,
            })}`,
            0,
          );
    let dispatchAttempted = false;
    return Effect.gen(function* () {
      if (context.callerTurnId === null)
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      const callerTurnId = context.callerTurnId;
      const operationId = `gateway:create:${stableGatewayDigest({
        principalKind: context.kind,
        principalId: context.callerThreadId,
        callerTurnId,
        requestId: input.requestId,
      })}`;
      const ids = makeAgentCreationIds(operationId, 0);
      const requestFingerprint = stableGatewayDigest(input, 64);

      const validateAdmission = (admission: AgentGatewayCreationAdmission) =>
        admission.callerThreadId !== context.callerThreadId ||
        admission.callerTurnId !== callerTurnId ||
        admission.requestId !== input.requestId ||
        admission.requestFingerprintVersion !== REQUEST_FINGERPRINT_VERSION ||
        admission.requestFingerprint !== requestFingerprint ||
        admission.planSchemaVersion !== CREATION_PLAN_SCHEMA_VERSION
          ? Effect.fail(
              new ToolInputError(
                "This requestId is already admitted with different creation input, including a different Connection, and cannot be reused.",
              ),
            )
          : Effect.void;

      const executeAdmission = Effect.fn(function* (admission: AgentGatewayCreationAdmission) {
        yield* validateAdmission(admission);
        const createCommand = yield* decodeCommand(admission.threadCreateCommandJson);
        const turnCommand = yield* decodeCommand(admission.turnStartCommandJson);
        const recapCommand = yield* decodeCommand(admission.recapCommandJson);
        const result = yield* decodeResult(admission.resultJson);
        if (
          createCommand.type !== "thread.create" ||
          turnCommand.type !== "thread.turn.start" ||
          recapCommand.type !== "thread.activity.append" ||
          createCommand.threadId !== result.threadId ||
          turnCommand.threadId !== result.threadId ||
          recapCommand.threadId !== context.callerThreadId ||
          result.operationId !== operationId ||
          result.requestId !== input.requestId ||
          createCommand.commandId !== ids.threadCreateCommandId ||
          turnCommand.commandId !== ids.turnStartCommandId ||
          createCommand.sourceThreadId !== context.callerThreadId ||
          createCommand.sourceTurnId !== callerTurnId ||
          createCommand.gatewayOperationId !== operationId ||
          turnCommand.turnId !== result.turnId ||
          turnCommand.message.messageId !== result.messageId ||
          turnCommand.connectionId !== result.connectionId ||
          recapCommand.activity.turnId !== callerTurnId
        ) {
          return yield* Effect.fail(new ToolInputError("Stored creation plan has invalid scope."));
        }

        // Admission freezes execution intent, not authorization. Re-read only the
        // current scope and privilege facts before replaying either accepted or
        // unaccepted work; never treat the historical plan as fresh authority.
        const currentCaller = yield* requireThreadShell(context.callerThreadId);
        const [currentCallerFolder, storedDestinationFolder, currentChild] = yield* Effect.all([
          snapshotQuery.getFolderShellById(currentCaller.folderId),
          snapshotQuery.getFolderShellById(createCommand.folderId),
          snapshotQuery.getThreadShellById(result.threadId),
        ]).pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        if (Option.isNone(currentCallerFolder) || Option.isNone(storedDestinationFolder)) {
          return yield* Effect.fail(
            new ToolInputError("The caller or stored destination Folder is no longer available."),
          );
        }
        const currentChildFolder = Option.isSome(currentChild)
          ? yield* snapshotQuery.getFolderShellById(currentChild.value.folderId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new ToolInputError(
                        "The created child Thread's current Folder is unavailable.",
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            )
          : storedDestinationFolder.value;
        if (currentCallerFolder.value.spaceId !== currentChildFolder.spaceId) {
          return yield* Effect.fail(
            new ToolInputError(
              Option.isSome(currentChild)
                ? "The created child Thread is no longer in the caller Thread's Space."
                : "The stored creation destination is no longer in the caller Thread's Space.",
            ),
          );
        }
        if (result.runtimeMode === "full-access" && currentCaller.runtimeMode !== "full-access") {
          return yield* Effect.fail(
            new ToolInputError(
              'The caller Thread is now "approval-required" and can no longer authorize this stored "full-access" creation.',
            ),
          );
        }
        yield* context.assertAuthority();
        dispatchAttempted = true;
        yield* orchestrationEngine.dispatch(createCommand);
        yield* context.assertAuthority();

        const receipt = yield* commandReceipts.getByCommandId({ commandId: turnCommand.commandId });
        const fingerprint = fingerprintOrchestrationCommand(turnCommand);
        if (
          Option.isSome(receipt) &&
          (receipt.value.fingerprintVersion !== fingerprint.version ||
            receipt.value.commandFingerprint !== fingerprint.value ||
            receipt.value.aggregateKind !== "thread" ||
            receipt.value.aggregateId !== turnCommand.threadId)
        ) {
          return yield* Effect.fail(
            new ToolInputError("Stored turn receipt does not belong to this creation command."),
          );
        }
        if (Option.isSome(receipt) && receipt.value.status === "accepted") {
          // Keep the engine's global receipt identity check authoritative even on the fast replay path.
          yield* orchestrationEngine.dispatch(turnCommand, {
            attachmentPrincipal: context.attachmentPrincipal,
          });
        } else {
          yield* providerThreadSwitchCoordinator.dispatchTurnStart({
            command: turnCommand,
            attachmentPrincipal: context.attachmentPrincipal,
            cwd: admission.cwd,
          });
        }
        yield* context.assertAuthority();
        yield* orchestrationEngine.dispatch(recapCommand).pipe(
          Effect.catch((error) =>
            Effect.logWarning("agent gateway could not append thread creation recap", {
              operationId,
              callerThreadId: context.callerThreadId,
              error: errorText(error),
            }),
          ),
        );
        return result;
      });

      const existing = yield* admissions
        .get(operationId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (Option.isSome(existing)) {
        yield* Effect.logInfo("agent gateway creation admission replayed", { operationId });
        return mcpToolResultJson(yield* executeAdmission(existing.value));
      }

      const caller = yield* requireThreadShell(context.callerThreadId);
      const callerFolder = yield* snapshotQuery.getFolderShellById(caller.folderId).pipe(
        Effect.mapError((error) => new ToolInputError(errorText(error))),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new ToolInputError(`Folder "${caller.folderId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const folderId = FolderId.makeUnsafe(input.folderId ?? caller.folderId);
      const folder = yield* snapshotQuery.getFolderShellById(folderId).pipe(
        Effect.mapError((error) => new ToolInputError(errorText(error))),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ToolInputError(`Folder "${folderId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (folder.spaceId !== SpaceId.makeUnsafe(callerFolder.spaceId))
        return yield* Effect.fail(
          new ToolInputError("Created Threads must remain in the caller Thread's Space."),
        );
      if (input.runtimeMode === "full-access" && caller.runtimeMode !== "full-access")
        return yield* Effect.fail(
          new ToolInputError(
            'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
          ),
        );
      const runtimeMode = input.runtimeMode ?? caller.runtimeMode;
      const cwd =
        (caller.folderId === folderId
          ? (caller.workingDirectory ?? folder.workspaceRoot)
          : folder.workspaceRoot) ?? process.cwd();
      const existingBinding = yield* dependencies
        .loadExistingBinding(ids.threadId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (
        Option.isSome(existingBinding) &&
        input.connectionId !== undefined &&
        input.connectionId !== existingBinding.value.connectionId
      )
        return yield* Effect.fail(
          new ToolInputError(
            "This request already created a thread with a different Connection. It cannot be rerouted by retrying creation.",
          ),
        );
      const connectionId = Option.isSome(existingBinding)
        ? existingBinding.value.connectionId
        : yield* providerTurnSelectionResolver
            .resolveNewThreadConnection({
              modelSelection: input.target,
              ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
            })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      const availabilities = yield* loadProviderAvailabilities;
      const target = yield* resolveAgentGatewayTarget({
        target: input.target,
        connectionId,
        discovery: providerDiscovery,
        ...(availabilities.get(input.target.provider) === undefined
          ? {}
          : { availability: availabilities.get(input.target.provider)! }),
        cwd,
      });
      const admittedAt = gatewayIsoNow();
      const title = input.title ?? buildPromptThreadTitleFallback(input.prompt);
      const result = {
        operationId,
        requestId: input.requestId,
        connectionId,
        threadId: ids.threadId,
        folderId,
        title,
        target,
        provider: target.provider,
        model: target.model,
        runtimeMode,
        messageId: ids.messageId,
        turnId: TurnId.makeUnsafe(`turn:${ids.turnStartCommandId}`),
      } satisfies typeof PenkraCreateThreadResult.Type;
      const createCommand = {
        type: "thread.create",
        commandId: ids.threadCreateCommandId,
        threadId: ids.threadId,
        folderId,
        title,
        modelSelection: target,
        runtimeMode,
        creationSource: "penkra_mcp",
        sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
        sourceTurnId: TurnId.makeUnsafe(callerTurnId),
        gatewayOperationId: operationId,
        gatewayOperationIndex: 0,
        createdAt: admittedAt,
      } satisfies typeof OrchestrationCommand.Type;
      const turnCommand = {
        type: "thread.turn.start",
        commandId: ids.turnStartCommandId,
        threadId: ids.threadId,
        turnId: result.turnId,
        message: { messageId: ids.messageId, role: "user", text: input.prompt, attachments: [] },
        modelSelection: target,
        connectionId,
        bindingRevision: 0,
        dispatchMode: "queue",
        dispatchOrigin: "agent",
        runtimeMode,
        createdAt: admittedAt,
      } satisfies typeof OrchestrationCommand.Type;
      const marker = stableGatewayDigest({ operationId, kind: "thread-created-recap" });
      const recapCommand = {
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:thread-created-recap`),
        threadId: ThreadId.makeUnsafe(context.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:thread-created-recap`),
          tone: "info",
          kind: "penkra.threads.created",
          summary: "Created 1 Penkra thread",
          payload: Schema.decodeUnknownSync(Schema.Json)({ source: "penkra_mcp", ...result }),
          turnId: TurnId.makeUnsafe(callerTurnId),
          createdAt: admittedAt,
        },
        createdAt: admittedAt,
      } satisfies typeof OrchestrationCommand.Type;

      yield* context.assertAuthority();
      const reservation = yield* admissions
        .reserve({
          operationId,
          callerThreadId: context.callerThreadId,
          callerTurnId,
          requestId: input.requestId,
          requestFingerprintVersion: REQUEST_FINGERPRINT_VERSION,
          requestFingerprint,
          planSchemaVersion: CREATION_PLAN_SCHEMA_VERSION,
          threadCreateCommandJson: JSON.stringify(createCommand),
          turnStartCommandJson: JSON.stringify(turnCommand),
          recapCommandJson: JSON.stringify(recapCommand),
          cwd,
          resultJson: JSON.stringify(result),
          admittedAt,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      yield* Effect.logInfo(
        reservation.kind === "reserved"
          ? "agent gateway creation admission reserved"
          : "agent gateway creation admission concurrent replay",
        { operationId },
      );
      return mcpToolResultJson(yield* executeAdmission(reservation.admission));
    }).pipe(
      Effect.catch((error) => {
        if (error instanceof GatewayToolError || error instanceof AgentGatewayTargetError) {
          return Effect.succeed(gatewayToolErrorResult(error));
        }

        const provenance = extractGatewayErrorProvenance(error);
        const retainedThread =
          dispatchAttempted && idsForError !== null && operationIdForError !== null;
        const diagnosticWrite: Effect.Effect<"retained" | "write-failed" | null> = retainedThread
          ? diagnostics
              .recordOperationalDiagnostic({
                threadId: idsForError.threadId,
                source: "server",
                kind: "agent-gateway.thread-create-failed",
                severity: "error",
                code: "AGENT_GATEWAY_THREAD_CREATE_FAILED",
                detail: {
                  operationId: operationIdForError,
                  requestId: input.requestId,
                  phase: "thread.create",
                  provenanceSource: provenance.source,
                  provenanceErrorKind: provenance.errorKind,
                  provenanceProvider: provenance.provider,
                  provenanceOperation: provenance.operation,
                  provenanceOperationTruncated: provenance.operationTruncated,
                  provenanceMethod: provenance.method,
                  provenanceMethodTruncated: provenance.methodTruncated,
                  provenanceDetail: provenance.detail,
                  provenanceDetailTruncated: provenance.detailTruncated,
                  provenanceCauseDepth: provenance.causeDepth,
                  provenanceCauseTruncated: provenance.causeTruncated,
                },
                occurredAt: gatewayIsoNow(),
              })
              .pipe(
                Effect.as("retained" as const),
                Effect.catch(() =>
                  Effect.logWarning("agent gateway could not retain creation failure diagnostic", {
                    operationId: operationIdForError,
                    requestId: input.requestId,
                    threadId: idsForError.threadId,
                    failure: "diagnostic_write_failed",
                  }).pipe(Effect.as("write-failed" as const)),
                ),
              )
          : Effect.succeed(null);

        return diagnosticWrite.pipe(
          Effect.map((diagnosticStatus) =>
            retainedThread
              ? gatewayToolErrorResult(
                  new GatewayToolError(
                    "operation_failed",
                    `Thread creation failed. The following thread may already exist: ${input.title ?? buildPromptThreadTitleFallback(input.prompt)} (${idsForError.threadId}). Retry this same requestId to finish it; do not restart the whole multi-call sequence.`,
                    {
                      requestId: input.requestId,
                      existingThreads: [
                        {
                          threadId: idsForError.threadId,
                          title: input.title ?? buildPromptThreadTitleFallback(input.prompt),
                        },
                      ],
                      cause: errorText(error),
                      provenance,
                      diagnosticStatus,
                      ...(diagnosticStatus === "write-failed"
                        ? { diagnosticWriteFailure: "diagnostic_write_failed" }
                        : {}),
                    },
                  ),
                )
              : gatewayToolErrorResult(
                  new GatewayToolError("operation_failed", errorText(error), {
                    requestId: input.requestId,
                    existingThreads: [],
                    provenance,
                  }),
                ),
          ),
        );
      }),
    );
  };
});
