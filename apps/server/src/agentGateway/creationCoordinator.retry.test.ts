import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
const creationStateDir = mkdtempSync(join(tmpdir(), "penkra-create-cwd-"));
afterAll(() => rmSync(creationStateDir, { recursive: true, force: true }));
import {
  FolderId,
  ProviderConnectionId,
  ProviderInstallationId,
  SpaceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationFolderShell,
  type OrchestrationThreadShell,
  type PenkraCreateThreadInput,
  type ProviderListModelsInput,
  type CleanCoreThreadSummary,
  type CleanCoreSendAdmission,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ThreadReadsShape } from "../cleanCore/ThreadReads.ts";
import { makeCreateThreadHandler, type GatewayCreationContext } from "./creationCoordinator.ts";
import { makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import type { McpToolCallResult } from "./protocol.ts";
const NOW = "2026-09-06T08:00:00.000Z";
const CALLER_THREAD_ID = ThreadId.make("caller-retry");
const CALLER_TURN_ID = TurnId.make("caller-turn");
const FOLDER_ID = FolderId.make("folder-retry");
const SPACE_ID = SpaceId.make("space-retry");
const ACCOUNT_A = ProviderConnectionId.make("account-a");
const ACCOUNT_B = ProviderConnectionId.make("account-b");
const INSTALLATION_ID = ProviderInstallationId.make("installation-retry");
const TARGET: ModelSelection = { provider: "codex", model: "gpt-5.5" };
const INPUT: PenkraCreateThreadInput = {
  requestId: "retry-request",
  prompt: "synthetic retry task",
  target: TARGET,
};

const FOLDER: OrchestrationFolderShell = {
  id: FOLDER_ID,
  spaceId: SPACE_ID,
  title: "Synthetic folder",
  workspaceRoot: "/synthetic/retry",
  defaultModelSelection: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CALLER: OrchestrationThreadShell = {
  id: CALLER_THREAD_ID,
  folderId: FOLDER_ID,
  title: "Synthetic caller",
  modelSelection: TARGET,
  subagentAgentId: null,
  subagentNickname: null,
  subagentRole: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  session: null,
};

const CONTEXT: GatewayCreationContext = {
  kind: "provider-session",
  callerThreadId: CALLER_THREAD_ID,
  callerTurnId: CALLER_TURN_ID,
  assertAuthority: () => Effect.void,
  attachmentPrincipal: { ownerKind: "session", ownerId: "synthetic-session" },
};
const IDS = makeAgentCreationIds(
  `gateway:create:${stableGatewayDigest({ principalKind: CONTEXT.kind, principalId: CALLER_THREAD_ID, requestId: INPUT.requestId })}`,
);
function makeHarness() {
  const rows = new Map<string, CleanCoreThreadSummary>();
  const confirmations = new Map<string, CleanCoreSendAdmission>();
  const sends: Array<
    Parameters<Parameters<typeof makeCreateThreadHandler>[0]["sender"]["send"]>[0]
  > = [];
  const modelDiscoveryCalls: ProviderListModelsInput[] = [];
  let discoveryFailure = false;
  let launchFailure = false;
  let defaultConnection = ACCOUNT_A;
  let selectionCalls = 0;
  let deliveries = 0;
  let caller = CALLER;
  let callerRuntimeMode: CleanCoreThreadSummary["runtimeMode"] = "full-access";
  const snapshotQuery: ThreadReadsShape = {
    queueLength: () => Effect.die("unused"),
    countThreadMessages: () => Effect.die("unused"),
    getTurnPage: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused snapshot method"),
    searchThreadMessages: () => Effect.die("unused snapshot method"),
    getThreadMessageContext: () => Effect.die("unused snapshot method"),
    listFolderShellPage: () => Effect.die("unused page method"),
    listThreadShellPage: () => Effect.die("unused page method"),
    hasActiveProviderThread: () => Effect.die("unused provider admission method"),
    getActiveFolderByWorkspaceRoot: () => Effect.die("unused snapshot method"),
    getFolderShellsByIds: () => Effect.die("unused"),
    getFolderShellById: () => Effect.succeed(Option.some(FOLDER)),
    getSpaceShellById: () => Effect.die("unused snapshot method"),
    getFirstActiveThreadIdByFolderId: () => Effect.die("unused snapshot method"),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.die("unused snapshot method"),
    getThreadDetailForExportById: () => Effect.die("unused snapshot method"),
    getThreadTurnsPage: () => Effect.die("unused snapshot method"),
  };

  const providerDiscovery: ProviderDiscoveryServiceShape = {
    probeConnection: () => Effect.die("unused discovery method"),
    getComposerCapabilities: () => Effect.die("unused discovery method"),
    getCapabilityHealth: () => Effect.die("unused discovery method"),
    listModels: (input) => {
      modelDiscoveryCalls.push(input);
      if (discoveryFailure) {
        return Effect.fail(
          new ProviderValidationError({
            operation: "listModels",
            issue: "synthetic discovery failure",
          }),
        );
      }
      return Effect.succeed({
        models: [{ slug: TARGET.model, name: "Synthetic model" }],
        source: "synthetic",
      });
    },
  };

  const dependencies: Parameters<typeof makeCreateThreadHandler>[0] = {
    stateDir: creationStateDir,
    lifecycle: {
      archiveInactive: () => Effect.die("unused retention archive"),
      deleteExpired: () => Effect.die("unused retention delete"),
      get: (id) =>
        Effect.sync(() => {
          if (id === CALLER_THREAD_ID)
            return {
              id: caller.id,
              folderId: caller.folderId,
              spaceId: SPACE_ID,
              title: caller.title,
              provider: caller.modelSelection.provider,
              model: caller.modelSelection.model,
              modelOptions: null,
              connectionId: null,
              runtimeMode: callerRuntimeMode,
              state: "idle",
              activeTurnId: null,
              latestTurn: null,
              lastError: null,
              queue: "[]",
              saved: "[]",
              createdBy: "user",
              createdByThreadId: null,
              sidebarSortOrder: null,
              lastActivityAt: null,
              lastMessagePreview: null,
              lastUserMessageAt: null,
              lastVisitedAt: null,
              openQuestionCount: 0,
              latestOpenQuestion: null,
              archivedAt: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            };
          const row = rows.get(id);
          return row === undefined ? null : row;
        }),
      create: (input) =>
        Effect.sync(() => {
          const existing = rows.get(input.threadId);
          if (existing !== undefined) return { thread: existing, created: false };
          if (input.connection.kind !== "selected")
            throw new Error("Gateway must resolve its connection before creation");
          const thread: CleanCoreThreadSummary = {
            id: input.threadId,
            folderId: input.folderId,
            spaceId: SPACE_ID,
            title: input.title,
            provider: input.modelSelection.provider,
            model: input.modelSelection.model,
            modelOptions:
              input.modelSelection.options === undefined
                ? null
                : JSON.stringify(input.modelSelection.options),
            connectionId: input.connection.connectionId,
            runtimeMode: input.runtimeMode,
            state: "idle",
            activeTurnId: null,
            latestTurn: null,
            lastError: null,
            queue: "[]",
            saved: "[]",
            createdBy: "agent",
            createdByThreadId: CALLER_THREAD_ID,
            sidebarSortOrder: null,
            lastActivityAt: null,
            lastMessagePreview: null,
            lastUserMessageAt: null,
            lastVisitedAt: null,
            openQuestionCount: 0,
            latestOpenQuestion: null,
            archivedAt: null,
            deletedAt: null,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          };
          rows.set(thread.id, thread);
          return { thread, created: true };
        }),
      update: () => Effect.die("unused lifecycle update"),
    },
    sender: {
      savePrompt: () => Effect.die("Gateway cannot save operator drafts"),
      restoreSavedPrompt: () => Effect.die("Gateway cannot restore operator drafts"),
      deleteSavedPrompt: () => Effect.die("Gateway cannot delete operator drafts"),
      resumeQueuedForConnection: () => Effect.void,
      steerQueued: () => Effect.die("unused queued steer"),
      runExclusive: (_threadId, action) => action,
      send: (input) =>
        Effect.gen(function* () {
          sends.push(input);
          const previous = confirmations.get(input.message.messageId);
          if (previous !== undefined) return previous;
          if (launchFailure) return yield* Effect.fail(new Error("controlled launch failure"));
          deliveries++;
          const result: CleanCoreSendAdmission = {
            plan: "deliver",
            threadId: input.threadId,
            messageId: input.message.messageId,
            seq: 1,
          };
          confirmations.set(input.message.messageId, result);
          return result;
        }),
      editQueued: () => Effect.die("unused edit"),
      queuedThread: () => Effect.die("unused queue lookup"),
      cancelQueued: () => Effect.die("unused cancel"),
      getRuntime: () => Effect.die("unused runtime"),
      interrupt: () => Effect.die("unused interrupt"),
    },
    snapshotQuery,
    providerDiscovery,
    providerTurnSelectionResolver: {
      authorizeConnection: () => Effect.die("not used in creation"),
      resolveNewThreadConnection: () =>
        Effect.sync(() => {
          selectionCalls++;
          return defaultConnection;
        }),
      resolveExisting: () => Effect.die("unused selection"),
    },
    loadProviderAvailabilities: Effect.succeed(
      new Map([["codex", { enabled: true, available: true, authStatus: "authenticated" }]]),
    ),
  };
  return {
    dependencies,
    rows,
    sends,
    modelDiscoveryCalls,
    get deliveries() {
      return deliveries;
    },
    get selectionCalls() {
      return selectionCalls;
    },
    setDefault: (id: ProviderConnectionId) => {
      defaultConnection = id;
    },
    failDiscovery: () => {
      discoveryFailure = true;
    },
    failLaunch: (value: boolean) => {
      launchFailure = value;
    },
    moveCaller: (folderId: FolderId) => {
      caller = { ...caller, folderId };
    },
    downgrade: () => {
      callerRuntimeMode = "approval-required";
    },
  };
}
async function invoke(harness: ReturnType<typeof makeHarness>, input = INPUT) {
  const handler = await Effect.runPromise(makeCreateThreadHandler(harness.dependencies));
  return Effect.runPromise(handler(input, CONTEXT));
}
function resultText(result: McpToolCallResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text MCP result");
  return block.text;
}
describe("clean-core agent creation retries", () => {
  it("creates one child and returns the same admission on retry", async () => {
    const h = makeHarness();
    const first = await invoke(h);
    const retry = await invoke(h);
    expect(first.isError, resultText(first)).not.toBe(true);
    expect(resultText(retry)).toBe(resultText(first));
    expect(h.rows.size).toBe(1);
    expect(h.deliveries).toBe(1);
    expect(h.sends.map((input) => input.message.messageId)).toEqual([IDS.messageId, IDS.messageId]);
    expect(
      h.sends.every(
        (input) =>
          input.message.origin._tag === "agent" &&
          input.message.origin.senderThreadId === CALLER_THREAD_ID,
      ),
    ).toBe(true);
    expect(JSON.parse(resultText(first)).sendAdmission).toEqual({
      threadId: IDS.threadId,
      messageId: IDS.messageId,
      plan: "deliver",
      seq: 1,
    });
    expect(JSON.parse(resultText(first))).not.toHaveProperty("turnId");
    expect(h.selectionCalls).toBe(1);
    expect(h.rows.get(IDS.threadId)?.createdByThreadId).toBe(CALLER_THREAD_ID);
    expect(IDS.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("retains the child after launch failure and retries its stored connection", async () => {
    const h = makeHarness();
    h.failLaunch(true);
    expect(resultText(await invoke(h))).toContain("controlled launch failure");
    expect(h.rows.size).toBe(1);
    h.setDefault(ACCOUNT_B);
    h.failLaunch(false);
    const retry = await invoke(h);
    expect(retry.isError, resultText(retry)).not.toBe(true);
    expect(resultText(retry)).toContain(ACCOUNT_A);
    expect(h.selectionCalls).toBe(1);
    expect(h.rows.size).toBe(1);
  });
  it("rejects rerouting a retained child before model discovery or delivery", async () => {
    const h = makeHarness();
    await invoke(h);
    const discoveries = h.modelDiscoveryCalls.length;
    const retry = await invoke(h, { ...INPUT, connectionId: ACCOUNT_B });
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("different Connection");
    expect(h.modelDiscoveryCalls).toHaveLength(discoveries);
    expect(h.deliveries).toBe(1);
  });
  it("does not substitute the new default when stored connection discovery fails", async () => {
    const h = makeHarness();
    await invoke(h);
    h.setDefault(ACCOUNT_B);
    h.failDiscovery();
    expect((await invoke(h)).isError).toBe(true);
    expect(h.rows.size).toBe(1);
    expect(h.deliveries).toBe(1);
    expect(h.modelDiscoveryCalls.at(-1)?.connectionId).toBe(ACCOUNT_A);
    expect(h.selectionCalls).toBe(1);
  });
  it("rejects driving a retained full-access child after caller downgrade", async () => {
    const h = makeHarness();
    await invoke(h);
    h.downgrade();
    const retry = await invoke(h);
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("cannot drive");
    expect(h.deliveries).toBe(1);
  });
  it("rejects a child moved to another space before resolving or dispatching", async () => {
    const h = makeHarness();
    await invoke(h);
    const child = h.rows.get(IDS.threadId)!;
    h.rows.set(child.id, { ...child, spaceId: SpaceId.make("another-space") });
    const retry = await invoke(h);
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("another Space");
    expect(h.deliveries).toBe(1);
    expect(h.selectionCalls).toBe(1);
  });
  it("keeps creation successful if home-window inheritance fails", async () => {
    const h = makeHarness();
    const handler = await Effect.runPromise(
      makeCreateThreadHandler({
        ...h.dependencies,
        onThreadCreated: () => Effect.fail(new Error("window unavailable")),
      }),
    );
    const result = await Effect.runPromise(handler(INPUT, CONTEXT));
    expect(result.isError, resultText(result)).not.toBe(true);
    expect(h.deliveries).toBe(1);
  });
  it("revalidates the destination after the caller moves to another Space", async () => {
    const h = makeHarness();
    await invoke(h);
    const movedFolder = FolderId.make("caller-moved");
    h.moveCaller(movedFolder);
    const selectionCalls = h.selectionCalls;
    const discoveryCalls = h.modelDiscoveryCalls.length;
    const sendCalls = h.sends.length;
    const handler = await Effect.runPromise(
      makeCreateThreadHandler({
        ...h.dependencies,
        snapshotQuery: {
          ...h.dependencies.snapshotQuery,
          getFolderShellById: (id) =>
            Effect.succeed(
              Option.some(
                id === movedFolder
                  ? { ...FOLDER, id, spaceId: SpaceId.make("other-space") }
                  : FOLDER,
              ),
            ),
        },
      }),
    );
    const result = await Effect.runPromise(handler(INPUT, CONTEXT));
    expect(result.isError).toBe(true);
    expect(h.sends).toHaveLength(sendCalls);
    expect(h.selectionCalls).toBe(selectionCalls);
    expect(h.modelDiscoveryCalls).toHaveLength(discoveryCalls);
    expect(h.rows.size).toBe(1);
  });
  it("keeps the stored creation and message identity across clock advancement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = makeHarness();
      vi.setSystemTime(new Date("2026-09-07T05:00:00Z"));
      const first = await invoke(h);
      const createdAt = h.rows.get(IDS.threadId)!.createdAt;
      vi.setSystemTime(new Date("2026-09-07T05:00:01Z"));
      expect(resultText(await invoke(h))).toBe(resultText(first));
      expect(h.rows.get(IDS.threadId)!.createdAt).toBe(createdAt);
      expect(h.sends.map((input) => input.message.messageId)).toEqual([
        IDS.messageId,
        IDS.messageId,
      ]);
      expect(h.deliveries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
