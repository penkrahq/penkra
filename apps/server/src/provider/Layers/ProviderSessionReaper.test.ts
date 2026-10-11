import { ThreadId, TurnId } from "@penkra/contracts";
import { Effect, Exit, Layer, Scope, ServiceMap, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createThread } from "../../cleanCore/threadStore.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeLayer(input: {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | null;
  readonly directory: ProviderSessionDirectoryShape;
  readonly providerService: ProviderServiceShape;
}) {
  const database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThreadFolderFixture("reaper-folder", "reaper-space");
      yield* createThread({
        id: input.threadId,
        spaceId: "reaper-space",
        folderId: "reaper-folder",
        title: "Reaper fixture",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* sql`UPDATE threads SET active_turn_id=${input.activeTurnId},
        state=${input.activeTurnId === null ? "idle" : "running"}
        WHERE id=${input.threadId}`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
  return makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provide(Layer.succeed(ProviderSessionDirectory, input.directory)),
    Layer.provide(Layer.succeed(ProviderService, input.providerService)),
    Layer.provide(database),
  );
}

describe("ProviderSessionReaperLive", () => {
  it("stops stale sessions without active turns", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-stale");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      interruptTurn: () => unsupported(),
      stopTask: () => unsupported(),
      backgroundTask: () => unsupported(),

      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => unsupported(),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.empty,
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const services = yield* Layer.buildWithScope(
            makeLayer({
              threadId,
              activeTurnId: null,
              directory,
              providerService,
            }),
            scope,
          );
          const reaper = ServiceMap.get(services, ProviderSessionReaper);
          yield* Scope.provide(reaper.start(), scope);
        }),
      );
      await waitFor(() => stopSession.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).toHaveBeenCalledWith({ threadId });
  });

  it("skips stale sessions with active turns", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-active");
    const turnId = TurnId.makeUnsafe("turn-reaper-active");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      interruptTurn: () => unsupported(),
      stopTask: () => unsupported(),
      backgroundTask: () => unsupported(),

      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => unsupported(),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.empty,
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const services = yield* Layer.buildWithScope(
            makeLayer({
              threadId,
              activeTurnId: turnId,
              directory,
              providerService,
            }),
            scope,
          );
          const reaper = ServiceMap.get(services, ProviderSessionReaper);
          yield* Scope.provide(reaper.start(), scope);
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).not.toHaveBeenCalled();
  });
});
