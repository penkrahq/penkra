import {
  PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type OrchestrationGetThreadTurnsPageResult,
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
  summarizeThreadShell,
  summarizeWaitThreadText,
  packAgentTranscriptPage,
  READ_THREAD_DEFAULT_ITEM_LIMIT,
  READ_THREAD_MAX_ITEM_LIMIT,
  type AgentTranscriptCursorAnchor,
  type AgentTranscriptInclude,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
} from "./threadSummary.ts";
import { resolveAuthoritativeActiveTurn } from "./activeExecution.ts";
import { requireThreadSpaceId } from "./threadSpaceContext.ts";
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
const LIST_THREADS_MAX_PAGE_SIZE = 100;
const CAPABILITIES_RESPONSE_MAX_CHARS = 40_000;
const AGENT_THREAD_STATUSES = [
  "working",
  "idle",
  "waiting-for-approval",
  "waiting-for-user-input",
  "interrupted",
  "error",
] as const;
const THREAD_CREATED_BY_VALUES = ["human", "penkra-mcp", "provider-native"] as const;

interface ThreadListCursor {
  readonly updatedAt: string;
  readonly threadId: string;
}

interface ThreadReadCursor {
  readonly version: 1;
  readonly threadId: string;
  readonly pageBefore: string | null;
  readonly anchor?: AgentTranscriptCursorAnchor;
}

interface ThreadSearchCursor {
  readonly version: 1;
  readonly mode: "search";
  readonly query: string;
  readonly threadId: string | null;
  readonly folderId: string | null;
  readonly spaceId: string;
  readonly anchor: {
    readonly createdAt: string;
    readonly threadId: string;
    readonly messageId: string;
  };
}

function encodeThreadReadCursor(cursor: ThreadReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeThreadReadCursor(
  value: string | undefined,
  threadId: string,
): ThreadReadCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      (decoded as ThreadReadCursor).version !== 1 ||
      (decoded as ThreadReadCursor).threadId !== threadId ||
      !(
        (decoded as ThreadReadCursor).pageBefore === null ||
        typeof (decoded as ThreadReadCursor).pageBefore === "string"
      )
    ) {
      throw new Error("invalid shape");
    }
    return decoded as ThreadReadCursor;
  } catch {
    throw new ToolInputError('Argument "cursor" is not a valid cursor for this Thread.');
  }
}

function encodeThreadSearchCursor(cursor: ThreadSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeThreadSearchCursor(
  value: string | undefined,
  expected: Omit<ThreadSearchCursor, "version" | "mode" | "anchor">,
): ThreadSearchCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const cursor = decoded as ThreadSearchCursor;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      cursor.version !== 1 ||
      cursor.mode !== "search" ||
      cursor.query !== expected.query ||
      cursor.threadId !== expected.threadId ||
      cursor.folderId !== expected.folderId ||
      cursor.spaceId !== expected.spaceId ||
      !cursor.anchor ||
      typeof cursor.anchor.createdAt !== "string" ||
      typeof cursor.anchor.threadId !== "string" ||
      typeof cursor.anchor.messageId !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return cursor;
  } catch {
    throw new ToolInputError('Argument "cursor" is not valid for this transcript search.');
  }
}

const isAfterSearchAnchor = (
  candidate: {
    readonly createdAt: string;
    readonly threadId: string;
    readonly messageId: string;
  },
  anchor: ThreadSearchCursor["anchor"],
) =>
  candidate.createdAt < anchor.createdAt ||
  (candidate.createdAt === anchor.createdAt && candidate.threadId < anchor.threadId) ||
  (candidate.createdAt === anchor.createdAt &&
    candidate.threadId === anchor.threadId &&
    candidate.messageId < anchor.messageId);

const AGENT_TRANSCRIPT_INCLUDES: ReadonlyArray<AgentTranscriptInclude> = [
  "messages",
  "tools",
  "approvals",
  "user-input",
  "tasks",
  "compaction",
  "turns",
];

function readTranscriptIncludes(value: string | undefined): ReadonlySet<AgentTranscriptInclude> {
  if (value === undefined || value === "all") return new Set(AGENT_TRANSCRIPT_INCLUDES);
  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (entry) => !AGENT_TRANSCRIPT_INCLUDES.includes(entry as AgentTranscriptInclude),
  );
  if (requested.length === 0 || invalid.length > 0) {
    throw new ToolInputError(
      `Argument "include" must be "all" or a comma-separated subset of: ${AGENT_TRANSCRIPT_INCLUDES.join(", ")}.`,
    );
  }
  return new Set(requested as AgentTranscriptInclude[]);
}

function encodeThreadListCursor(cursor: ThreadListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeThreadListCursor(value: string | undefined): ThreadListCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as ThreadListCursor).updatedAt !== "string" ||
      typeof (decoded as ThreadListCursor).threadId !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return decoded as ThreadListCursor;
  } catch {
    throw new ToolInputError('Argument "cursor" is not a valid thread-list cursor.');
  }
}

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
        "Use when you need the caller's own Penkra thread id, active turn id, folder, provider, or coordination permissions. This identifies the current execution context; use `penkra threads list` to discover other Threads and `penkra capabilities` to choose a provider/model target.",
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
      description:
        'Use immediately before `penkra threads create` when you need a valid provider/model target or provider-specific option keys. By default it returns a compact summary of available providers; pass provider for one exact catalog or detail "full" for complete model metadata. Returns canonical targets and gateway limits, not existing Threads or folders; use `penkra threads list` or `penkra folders list` for those. ' +
        AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
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
        "Use to resolve a Penkra folder id and workspace root before creating or filtering Threads in another folder. Returns folder metadata only; use `penkra threads list` to discover conversations and `penkra context` for the caller's current folder.",
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
    handler: (_args, context) =>
      Effect.gen(function* () {
        yield* requireThreadShell(context.callerThreadId);
        const snapshot = yield* snapshotQuery.getShellSnapshot();
        const spaceById = new Map(snapshot.spaces.map((space) => [space.id, space]));
        return mcpToolResultJson({
          folders: snapshot.folders.map((folder) => ({
            folderId: folder.id,
            spaceId: folder.spaceId,
            spaceTitle: spaceById.get(folder.spaceId)?.name ?? null,
            title: folder.title,
            workspaceRoot: folder.workspaceRoot,
            isPinned: folder.isPinned,
          })),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_list_threads",
      description:
        "Use to discover existing Penkra Threads or child Threads before reading, waiting, sending, or interrupting them. Filters by folder, hierarchy, provider/model, status, title, source, and update window; archived Threads are hidden unless includeArchived is true. Use `penkra threads read` once you know the exact Thread id.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: {
            type: "string",
            description: "Only threads in this exact Penkra folder id.",
          },
          threadId: {
            type: "string",
            description: "Only this exact Penkra thread id.",
          },
          spaceId: {
            type: "string",
            description: "Only threads in this exact Space; defaults to the caller's Space.",
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
            enum: [...AGENT_THREAD_STATUSES],
            description: "Exact derived thread status.",
          },
          titleContains: {
            type: "string",
            description: "Case-insensitive title substring.",
          },
          createdBy: {
            type: "string",
            enum: [...THREAD_CREATED_BY_VALUES],
            description: "human, penkra-mcp, or provider-native.",
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
            description: "Items per page (default 50, max 100).",
          },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the preceding page.",
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
        const exactThreadId = readStringArg(args, "threadId");
        const folderId = readStringArg(args, "folderId");
        const requestedSpaceId = readStringArg(args, "spaceId");
        const parentThreadId = readStringArg(args, "parentThreadId");
        const provider = readStringArg(args, "provider");
        const model = readStringArg(args, "model");
        const status = readStringArg(args, "status");
        const titleContains = readStringArg(args, "titleContains")?.toLocaleLowerCase();
        const createdBy = readStringArg(args, "createdBy");
        const updatedAfter = readIsoTimestampArg(args, "updatedAfter");
        const updatedBefore = readIsoTimestampArg(args, "updatedBefore");
        const includeArchived = readBooleanArg(args, "includeArchived") ?? false;
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
            LIST_THREADS_MAX_PAGE_SIZE,
          ),
        );
        const cursor = decodeThreadListCursor(readStringArg(args, "cursor"));
        const caller = yield* requireThreadShell(context.callerThreadId);
        const callerSpaceId = yield* requireThreadSpaceId(snapshotQuery, caller);
        const spaceId = requestedSpaceId ? SpaceId.makeUnsafe(requestedSpaceId) : callerSpaceId;
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const matching = snapshot.threads
          .filter((thread) => (exactThreadId ? thread.id === exactThreadId : true))
          .filter((thread) => {
            const folder = snapshot.folders.find((candidate) => candidate.id === thread.folderId);
            return folder?.spaceId === spaceId;
          })
          .filter((thread) => (folderId ? thread.folderId === folderId : true))
          .filter((thread) => (parentThreadId ? thread.parentThreadId === parentThreadId : true))
          .filter((thread) => (provider ? thread.modelSelection.provider === provider : true))
          .filter((thread) => (model ? thread.modelSelection.model === model : true))
          .filter((thread) => (status ? deriveAgentThreadStatus(thread) === status : true))
          .filter((thread) =>
            titleContains ? thread.title.toLocaleLowerCase().includes(titleContains) : true,
          )
          .filter((thread) => {
            if (!createdBy) return true;
            if (createdBy === "human") return (thread.creationSource ?? null) === null;
            return thread.creationSource === createdBy.replace("-", "_");
          })
          .filter((thread) => (updatedAfter ? thread.updatedAt >= updatedAfter : true))
          .filter((thread) => (updatedBefore ? thread.updatedAt <= updatedBefore : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .filter((thread) =>
            cursor
              ? thread.updatedAt < cursor.updatedAt ||
                (thread.updatedAt === cursor.updatedAt && thread.id < cursor.threadId)
              : true,
          );
        const page = matching.slice(0, limit);
        const threads = page.map((thread) => summarizeThreadShell(thread, context.callerThreadId));
        const last = page.at(-1);
        return mcpToolResultJson({
          threads,
          pageInfo: {
            nextCursor:
              matching.length > page.length && last
                ? encodeThreadListCursor({
                    updatedAt: last.updatedAt,
                    threadId: last.id,
                  })
                : null,
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readThread: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_read_thread",
      description:
        "Read durable Penkra transcript items. With threadId, start at the tail, inspect before.messages, then search relevant terms instead of blindly paging a long Thread. With query and no threadId, search the caller's current Space; optionally narrow with folderId. Results may include messages, tools, approvals, user input, tasks, compaction, and turn lifecycle. Always follow pageInfo.nextCursor when present; cursors are stable anchors and can continue inside one large item without clipping or changing its text.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description:
              "Exact Penkra thread id to read or search. Required unless query searches the current Space.",
          },
          spaceId: {
            type: "string",
            description: "Search only this Space; defaults to the caller's Space.",
          },
          folderId: {
            type: "string",
            description: "When searching, only Threads in this exact folder.",
          },
          cursor: {
            type: "string",
            description: "Opaque pageInfo.nextCursor from the preceding read.",
          },
          query: {
            type: "string",
            description:
              "Case-insensitive text to find. Without threadId, searches non-archived Threads in the selected Space.",
          },
          include: {
            type: "string",
            description:
              '"all" (default) or a comma-separated subset of messages, tools, approvals, user-input, tasks, compaction, turns.',
          },
          limit: {
            type: "number",
            description: "Items per page (default 20, max 100).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Read a Penkra thread",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId");
        const folderId = readStringArg(args, "folderId");
        const requestedSpaceId = readStringArg(args, "spaceId");
        const cursorValue = readStringArg(args, "cursor");
        const query = readStringArg(args, "query")?.toLocaleLowerCase();
        const include = readTranscriptIncludes(readStringArg(args, "include"));
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? READ_THREAD_DEFAULT_ITEM_LIMIT,
            READ_THREAD_MAX_ITEM_LIMIT,
          ),
        );
        if (!threadId && !query) {
          throw new ToolInputError('Argument "threadId" is required unless "query" is provided.');
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const callerSpaceId = yield* requireThreadSpaceId(snapshotQuery, caller);
        let requestedScopeSpaceId = requestedSpaceId
          ? SpaceId.makeUnsafe(requestedSpaceId)
          : callerSpaceId;
        const scopeSpace = yield* snapshotQuery.getSpaceShellById(requestedScopeSpaceId);
        if (Option.isNone(scopeSpace)) {
          throw new ToolInputError(`Space "${requestedScopeSpaceId}" was not found.`);
        }
        const shell = threadId
          ? yield* snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
                  onSome: Effect.succeed,
                }),
              ),
            )
          : undefined;
        if (shell) {
          const targetSpaceId = yield* requireThreadSpaceId(snapshotQuery, shell);
          if (!requestedSpaceId) requestedScopeSpaceId = targetSpaceId;
          if (requestedSpaceId && requestedScopeSpaceId !== targetSpaceId) {
            throw new ToolInputError(
              `Thread "${threadId}" was not found in Space "${requestedScopeSpaceId}".`,
            );
          }
          if (folderId && shell.folderId !== folderId) {
            throw new ToolInputError(`Thread "${threadId}" is not in folder "${folderId}".`);
          }
        }
        if (query !== undefined) {
          if (!query.trim()) throw new ToolInputError('Argument "query" must not be blank.');
          const snapshot = yield* snapshotQuery.getShellSnapshot();
          const folderById = new Map(snapshot.folders.map((folder) => [folder.id, folder]));
          const candidates = (shell ? [shell] : snapshot.threads)
            .filter(
              (candidate) => folderById.get(candidate.folderId)?.spaceId === requestedScopeSpaceId,
            )
            .filter((candidate) => (folderId ? candidate.folderId === folderId : true))
            .filter((candidate) => (shell ? true : (candidate.archivedAt ?? null) === null));
          const searchScope = {
            query,
            threadId: threadId ?? null,
            folderId: folderId ?? null,
            spaceId: requestedScopeSpaceId as string,
          };
          const searchCursor = decodeThreadSearchCursor(cursorValue, searchScope);
          const matches: Array<{
            readonly type: "message";
            readonly threadId: string;
            readonly threadTitle: string;
            readonly messageId: string;
            readonly turnId: string | null;
            readonly role: string;
            readonly text: string;
            readonly textRange: {
              readonly start: number;
              readonly end: number;
              readonly total: number;
            };
            readonly matches: ReadonlyArray<{
              readonly start: number;
              readonly end: number;
            }>;
            readonly createdAt: string;
          }> = [];
          yield* Effect.forEach(
            candidates,
            (candidate) =>
              Effect.gen(function* () {
                let before: string | undefined;
                do {
                  const page = yield* snapshotQuery.getThreadTurnsPage({
                    threadId: candidate.id,
                    ...(before ? { before } : {}),
                  });
                  for (const message of page.messages) {
                    const haystack = message.text.toLocaleLowerCase();
                    const matchStart = haystack.indexOf(query);
                    if (matchStart < 0) continue;
                    const start = Math.max(0, matchStart - 600);
                    const end = Math.min(message.text.length, matchStart + query.length + 600);
                    matches.push({
                      type: "message",
                      threadId: candidate.id,
                      threadTitle: candidate.title,
                      messageId: message.id,
                      turnId: message.turnId ?? null,
                      role: message.role,
                      text: message.text.slice(start, end),
                      textRange: { start, end, total: message.text.length },
                      matches: [{ start: matchStart, end: matchStart + query.length }],
                      createdAt: message.createdAt,
                    });
                  }
                  if (!page.hasOlder || !page.nextCursor) break;
                  before = page.nextCursor;
                } while (true);
              }),
            { concurrency: 4, discard: true },
          );
          const ordered = matches
            .toSorted(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) ||
                right.threadId.localeCompare(left.threadId) ||
                right.messageId.localeCompare(left.messageId),
            )
            .filter((match) =>
              searchCursor ? isAfterSearchAnchor(match, searchCursor.anchor) : true,
            );
          const selected: typeof ordered = [];
          let remainingBudget = 20_000;
          for (const match of ordered) {
            if (selected.length >= limit) break;
            if (match.text.length > remainingBudget && selected.length > 0) break;
            selected.push(match);
            remainingBudget -= match.text.length;
          }
          const last = selected.at(-1);
          const nextCursor =
            last && ordered.length > selected.length
              ? encodeThreadSearchCursor({
                  version: 1,
                  mode: "search",
                  ...searchScope,
                  anchor: {
                    createdAt: last.createdAt,
                    threadId: last.threadId,
                    messageId: last.messageId,
                  },
                })
              : null;
          return mcpToolResultJson({
            scope: shell
              ? { kind: "thread", threadId: shell.id, title: shell.title }
              : {
                  kind: "space",
                  spaceId: requestedScopeSpaceId,
                  folderId: folderId ?? null,
                },
            query,
            items: selected,
            pageInfo: { nextCursor },
          });
        }

        if (!shell || !threadId) {
          throw new ToolInputError('Argument "threadId" is required when "query" is absent.');
        }
        const cursor = decodeThreadReadCursor(cursorValue, threadId);

        let pageBefore = cursor?.pageBefore ?? undefined;
        let page: OrchestrationGetThreadTurnsPageResult;
        let packed: ReturnType<typeof packAgentTranscriptPage>;
        // If a live Thread grew by more than one turn page since the prior read,
        // walk durable page anchors until the cursor's item is found. New output
        // can never make a cursor skip or duplicate older transcript content.
        while (true) {
          page = yield* snapshotQuery.getThreadTurnsPage({
            threadId: shell.id,
            ...(pageBefore ? { before: pageBefore } : {}),
          });
          packed = packAgentTranscriptPage({
            messages: page.messages,
            activities: page.activities,
            include,
            ...(cursor?.anchor ? { anchor: cursor.anchor } : {}),
            limit,
          });
          if (packed.items.length > 0 || !page.hasOlder || !page.nextCursor) {
            break;
          }
          pageBefore = page.nextCursor;
        }

        const nextCursor = packed.nextAnchor
          ? encodeThreadReadCursor({
              version: 1,
              threadId,
              pageBefore: pageBefore ?? null,
              anchor: packed.nextAnchor,
            })
          : page.hasOlder && page.nextCursor
            ? encodeThreadReadCursor({
                version: 1,
                threadId,
                pageBefore: page.nextCursor,
              })
            : null;
        const totalMessages = snapshotQuery.countThreadMessages
          ? yield* snapshotQuery.countThreadMessages(shell.id)
          : page.messages.length;
        return mcpToolResultJson({
          threadId: shell.id,
          folderId: shell.folderId,
          title: shell.title,
          provider: shell.modelSelection.provider,
          model: shell.modelSelection.model,
          status: deriveAgentThreadStatus(shell),
          sessionStatus: shell.session?.status ?? null,
          latestTurnState: shell.latestTurn?.state ?? null,
          parentThreadId: shell.parentThreadId ?? null,
          createdBy:
            shell.creationSource === "penkra_mcp"
              ? "penkra-mcp"
              : shell.creationSource === "provider_native"
                ? "provider-native"
                : "human",
          archived: (shell.archivedAt ?? null) !== null,
          lastError: shell.session?.lastError ?? null,
          createdAt: shell.createdAt,
          updatedAt: shell.updatedAt,
          items: packed.items,
          ...(cursor === undefined
            ? {
                before: {
                  messages: Math.max(0, totalMessages - page.messages.length),
                },
              }
            : {}),
          pageInfo: { nextCursor },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const waitForThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "penkra_wait_for_threads",
      description: `Use after creating or otherwise identifying background Penkra threads when you need all of their turn outcomes. Waits for 1–20 pinned turns and returns every result in input order. latestAssistantPreview is a clearly labelled, capped preview of the terminal assistant message (${WAIT_THREAD_SUMMARY_MAX_CHARS} characters), not a generated summary; use each result's readThread command for the complete transcript. A timeout reports progress only and never retries, replaces, cancels, or creates work.`,
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "array",
            minItems: 1,
            maxItems: PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: "string" },
            description:
              "Exact Penkra thread ids to wait for, in the desired result order. Repeat --thread-id for multiple Threads.",
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
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for Penkra threads",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const waitInput = decodeWaitForThreadsInput({
          threadIds: args.threadId,
          ...(args.runIds === undefined ? {} : { runIds: args.runIds }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        });
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
          Effect.gen(function* () {
            // A newly created Thread can be visible before its first turn is
            // projected. Null therefore means "not pinned yet", not "idle and
            // terminal". Discover and pin the first turn that appears while
            // this wait call is alive.
            yield* Effect.forEach(
              pinned.filter((pin) => pin.runId === null),
              (pin) =>
                snapshotQuery.getThreadShellById(pin.threadId).pipe(
                  Effect.mapError((error) => new ToolInputError(errorText(error))),
                  Effect.tap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (thread) =>
                        Effect.sync(() => {
                          if (thread.latestTurn) pin.runId = thread.latestTurn.turnId;
                        }),
                    }),
                  ),
                ),
              { discard: true },
            );
            return yield* projectionTurns
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
                          ? pin.shell.creationSource === "penkra_mcp"
                            ? ("pending" as const)
                            : ("idle" as const)
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
                        assistantMessageId:
                          pin.runId === null
                            ? null
                            : (turnsByKey.get(`${pin.threadId}\u0000${pin.runId}`)
                                ?.assistantMessageId ?? null),
                        state,
                        terminal,
                        timedOut: false,
                        latestAssistantPreview: null as string | null,
                        previewTruncated: false,
                        error: null as string | null,
                        readThread: {
                          command: `penkra threads read --thread-id ${pin.threadId}`,
                        },
                      };
                    }),
                  );
                }),
              );
          });

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
            const { assistantMessageId, ...publicResult } = result;
            if (!result.terminal || result.runId === null) {
              return {
                ...publicResult,
                timedOut: !result.terminal && timedOut,
              };
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
            const assistantMessage =
              assistantMessageId !== null
                ? detail.messages.findLast(
                    (message) => message.role === "assistant" && message.id === assistantMessageId,
                  )
                : detail.messages.findLast(
                    (message) => message.role === "assistant" && message.turnId === result.runId,
                  );
            const preview = summarizeWaitThreadText(assistantMessage?.text);
            return {
              ...publicResult,
              timedOut: false,
              latestAssistantPreview: preview.summary,
              previewTruncated: preview.truncated,
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
