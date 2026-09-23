import { ThreadId, type OrchestrationThreadShell } from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderRuntimeEventRepositoryShape } from "../persistence/Services/ProviderRuntimeEvents.ts";
import type { AgentGatewayShape } from "./Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { extractBearerToken } from "./bearerToken.ts";
import {
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  mcpToolResultError,
  parseMcpMessage,
  type JsonRpcRequest,
} from "./protocol.ts";
import { resolveAuthoritativeActiveTurn } from "./activeExecution.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { errorText } from "./toolInput.ts";

const MCP_MAX_BATCH_MESSAGES = 50;

export function makeAgentGatewayMcpTransport(input: {
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly providerRuntimeEvents: Pick<
    ProviderRuntimeEventRepositoryShape,
    "listOpenTurnsByThreadId"
  >;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly instructions:
    | string
    | ((context: Omit<ToolContext, "jsonRpcRequestId">) => Effect.Effect<string, unknown>);
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
}): AgentGatewayShape["handleMcpPost"] {
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));

  const resolveCallerTurnId = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const [projectedTurn, openTurns] = yield* Effect.all([
        resolveAuthoritativeActiveTurn({
          threadId: thread.id,
          session: thread.session,
          projectionTurns: input.projectionTurns,
        }),
        input.providerRuntimeEvents.listOpenTurnsByThreadId(thread.id),
      ]);
      const projectedTurnId = projectedTurn?.turnId ?? null;
      const projectedProviderTurnId = projectedTurn?.providerTurnId ?? null;
      const openTurnIds: string[] = openTurns.map((turn) => turn.turnId);
      const sessionTurnId = thread.session?.activeTurnId ?? null;
      const projectedAliases: string[] = [];
      if (projectedTurnId !== null) projectedAliases.push(projectedTurnId);
      if (projectedProviderTurnId !== null) projectedAliases.push(projectedProviderTurnId);

      if (
        thread.session?.status === "running" &&
        sessionTurnId !== null &&
        openTurnIds.includes(sessionTurnId)
      ) {
        if (
          projectedTurnId !== null &&
          (sessionTurnId === projectedTurnId || sessionTurnId === projectedProviderTurnId)
        ) {
          return {
            turnId: projectedTurnId,
            activeTurnIds: projectedAliases,
            projectedTurnId,
            projectedProviderTurnId,
            openTurnIds,
          };
        }
        return {
          turnId: sessionTurnId,
          activeTurnIds: [sessionTurnId],
          projectedTurnId,
          projectedProviderTurnId,
          openTurnIds,
        };
      }
      if (projectedTurnId !== null && openTurnIds.length === 0) {
        return {
          turnId: projectedTurnId,
          activeTurnIds: projectedAliases,
          projectedTurnId,
          projectedProviderTurnId,
          openTurnIds,
        };
      }
      if (
        projectedTurnId !== null &&
        openTurnIds.some(
          (turnId) => turnId === projectedTurnId || turnId === projectedProviderTurnId,
        )
      ) {
        return {
          turnId: projectedTurnId,
          activeTurnIds: projectedAliases,
          projectedTurnId,
          projectedProviderTurnId,
          openTurnIds,
        };
      }
      if (projectedTurnId === null && openTurnIds.length === 1) {
        const openTurnId = openTurnIds[0] ?? null;
        if (
          thread.session?.status !== "running" ||
          (sessionTurnId !== null && sessionTurnId !== openTurnId)
        ) {
          return {
            turnId: null,
            activeTurnIds: [],
            projectedTurnId,
            projectedProviderTurnId,
            openTurnIds,
          };
        }
        return {
          turnId: openTurnId,
          activeTurnIds: openTurnId === null ? [] : [openTurnId],
          projectedTurnId,
          projectedProviderTurnId,
          openTurnIds,
        };
      }
      return {
        turnId: null,
        activeTurnIds: [],
        projectedTurnId,
        projectedProviderTurnId,
        openTurnIds,
      };
    });

  const handleRequest = (request: JsonRpcRequest, context: Omit<ToolContext, "jsonRpcRequestId">) =>
    Effect.gen(function* () {
      switch (request.method) {
        case "initialize":
          const instructions =
            typeof input.instructions === "string"
              ? input.instructions
              : yield* input.instructions(context);
          return jsonRpcResult(
            request.id,
            buildMcpInitializeResult({
              requestedProtocolVersion: request.params.protocolVersion,
              serverVersion: "1.0.0",
              instructions,
            }),
          );
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, {
            tools: input.tools.map((tool) => tool.definition),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const tool = toolsByName.get(toolName);
          if (!tool) {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
          }
          const rawArgs = request.params.arguments;
          const args =
            typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          const requiredCapability = tool.requiredCapability;
          if (!context.callerCapabilities.has(requiredCapability)) {
            return jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  `This provider session is not authorized for ${requiredCapability}.`,
                  { requiredCapability },
                ),
              ),
            );
          }
          const invocationContext: ToolContext = {
            ...context,
            jsonRpcRequestId: request.id,
          };
          if (tool.requiresActiveTurn) {
            const authorityError = yield* context.assertCallerTurnActive().pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
            if (authorityError !== null) {
              yield* Effect.logWarning("agent_gateway.write_rejected", {
                callerThreadId: context.callerThreadId,
                callerProvider: context.callerProvider,
                toolName,
                jsonRpcRequestId: request.id,
                errorCode: authorityError.code,
              });
              return jsonRpcResult(request.id, gatewayToolErrorResult(authorityError));
            }
          }
          const result = yield* Effect.suspend(() => tool.handler(args, invocationContext)).pipe(
            Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
          );
          return jsonRpcResult(request.id, result);
        }
        default:
          return jsonRpcError(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method "${request.method}" is not supported.`,
          );
      }
    });

  return (requestInput) =>
    Effect.gen(function* () {
      const token = extractBearerToken(requestInput.authorizationHeader);
      const callerSession = token ? input.credentials.verifySession(token) : null;
      if (!token || !callerSession) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
          ),
        };
      }
      const callerThreadId = callerSession.threadId;
      const callerThread = yield* input.snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "Bearer token refers to a thread that no longer exists.",
          ),
        };
      }
      const liveProvider = callerThread.value.session?.providerName;
      if ((liveProvider ?? callerThread.value.modelSelection.provider) !== callerSession.provider) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Provider session no longer owns this thread.",
          ),
        };
      }
      const ingressAuthority = yield* resolveCallerTurnId(callerThread.value).pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent_gateway.active_turn_lookup_failed", {
            callerThreadId,
            error: errorText(error),
          }).pipe(
            Effect.as({
              turnId: null,
              activeTurnIds: [],
              projectedTurnId: null,
              projectedProviderTurnId: null,
              openTurnIds: [],
            }),
          ),
        ),
      );
      if (
        callerThread.value.session?.status === "running" &&
        callerThread.value.session.activeTurnId !== null &&
        ingressAuthority.turnId === null
      ) {
        yield* Effect.logWarning("agent_gateway.active_turn_projection_mismatch", {
          callerThreadId,
          sessionActiveTurnId: callerThread.value.session.activeTurnId,
          latestTurnId: callerThread.value.latestTurn?.turnId ?? null,
          latestProviderTurnId: callerThread.value.latestTurn?.providerTurnId ?? null,
          latestTurnState: callerThread.value.latestTurn?.state ?? null,
          projectedTurnId: ingressAuthority.projectedTurnId,
          projectedProviderTurnId: ingressAuthority.projectedProviderTurnId,
          openRuntimeTurnIds: ingressAuthority.openTurnIds,
        });
      }
      const callerWriteAuthority =
        ingressAuthority.turnId === null
          ? null
          : input.credentials.bindWriteAuthority(token, ingressAuthority.turnId);
      const assertCallerTurnActive = () =>
        Effect.gen(function* () {
          if (callerWriteAuthority === null) {
            yield* Effect.logWarning("agent_gateway.caller_turn_inactive", {
              callerThreadId,
              sessionStatus: callerThread.value.session?.status ?? null,
              sessionActiveTurnId: callerThread.value.session?.activeTurnId ?? null,
              latestTurnId: callerThread.value.latestTurn?.turnId ?? null,
              latestProviderTurnId: callerThread.value.latestTurn?.providerTurnId ?? null,
              latestTurnState: callerThread.value.latestTurn?.state ?? null,
              projectedTurnId: ingressAuthority.projectedTurnId,
              projectedProviderTurnId: ingressAuthority.projectedProviderTurnId,
              openRuntimeTurnIds: ingressAuthority.openTurnIds,
            });
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Penkra write was rejected because no caller turn was active when the MCP request arrived.",
                { callerThreadId },
              ),
            );
          }
          if (!input.credentials.verifyWriteAuthority(callerWriteAuthority)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Penkra write was rejected because its provider-session authority is no longer active.",
                { callerThreadId },
              ),
            );
          }
          const caller = yield* input
            .requireThreadShell(callerThreadId)
            .pipe(
              Effect.mapError(
                (error) =>
                  new GatewayToolError(
                    "caller_turn_inactive",
                    "This Penkra write was rejected because the caller thread could no longer be verified.",
                    { callerThreadId, error: errorText(error) },
                  ),
              ),
            );
          const activeAuthority = yield* resolveCallerTurnId(caller).pipe(
            Effect.mapError(
              (error) =>
                new GatewayToolError(
                  "caller_turn_inactive",
                  "This Penkra write was rejected because the active execution could not be verified.",
                  { callerThreadId, error: errorText(error) },
                ),
            ),
          );
          const activeTurnIds: ReadonlyArray<string> = activeAuthority.activeTurnIds;
          if (!activeTurnIds.includes(callerWriteAuthority.turnId)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Penkra write was rejected because the turn that received this MCP request is no longer active. In-flight requests cannot inherit authority from a later turn.",
                {
                  callerThreadId,
                  authorizedTurnId: callerWriteAuthority.turnId,
                  sessionStatus: caller.session?.status ?? null,
                  sessionActiveTurnId: caller.session?.activeTurnId ?? null,
                  latestTurnId: caller.latestTurn?.turnId ?? null,
                  latestProviderTurnId: caller.latestTurn?.providerTurnId ?? null,
                  latestTurnState: caller.latestTurn?.state ?? null,
                  projectedTurnId: activeAuthority.projectedTurnId,
                  projectedProviderTurnId: activeAuthority.projectedProviderTurnId,
                  openRuntimeTurnIds: activeAuthority.openTurnIds,
                },
              ),
            );
          }
        });
      const context: Omit<ToolContext, "jsonRpcRequestId"> = {
        principal: {
          kind: "provider-session",
          sessionKey: callerSession.sessionKey,
          threadId: callerThreadId,
          provider: callerSession.provider,
          turnId: callerWriteAuthority?.turnId ?? null,
        },
        callerThreadId,
        callerSessionKey: callerSession.sessionKey,
        callerProvider: callerSession.provider,
        callerCapabilities: callerSession.capabilities,
        callerTurnId: callerWriteAuthority?.turnId ?? null,
        assertCallerTurnActive,
      };

      const rawMessages = Array.isArray(requestInput.body)
        ? requestInput.body
        : [requestInput.body];
      if (rawMessages.length === 0) {
        return {
          status: 400,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        };
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = `${typeof parsed.request.id}:${String(parsed.request.id)}`;
        if (requestIds.has(key)) {
          return {
            status: 400,
            body: jsonRpcError(
              parsed.request.id,
              JSON_RPC_INVALID_REQUEST,
              `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            ),
          };
        }
        requestIds.add(key);
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request":
            responses.push(
              yield* handleRequest(parsed.request, context).pipe(
                Effect.catch((error) =>
                  Effect.succeed(
                    jsonRpcResult(parsed.request.id, mcpToolResultError(errorText(error))),
                  ),
                ),
              ),
            );
            break;
          case "notification":
          case "response":
            break;
          case "invalid":
            responses.push(
              jsonRpcError(parsed.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
            );
            break;
        }
      }
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    });
}
