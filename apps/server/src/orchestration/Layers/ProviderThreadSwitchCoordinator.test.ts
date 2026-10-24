import { expect, it } from "vitest";
import { Effect, Option } from "effect";
import {
  FolderId,
  MessageId,
  ProviderConnectionId,
  ProviderInstallationId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { createThreadFixture, seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { ServerConfig } from "../../config.ts";
import { makeThreadPublisher } from "../../cleanCore/threadStore.ts";
import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import { ThreadLanesLive } from "../../cleanCore/ThreadLanes.ts";
import { TurnDispatch } from "../../cleanCore/turnDispatch.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import {
  ProviderTurnSelectionResolver,
  type ResolvedProviderTurnSelection,
} from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { ConnectionRateLimits } from "../../providerUsage/ConnectionRateLimits.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { makeProviderThreadSwitchCoordinator } from "./ProviderThreadSwitchCoordinator.ts";

for (const scenario of ["success", "copy-fails", "commit-fails", "shared-id"] as const) {
  it(`keeps native ownership correct when an OpenCode switch ${scenario}`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make("switch-thread");
          const oldConnection = ProviderConnectionId.make("old-connection");
          const newConnection = ProviderConnectionId.make("new-connection");
          const at = "2026-10-22T00:00:00.000Z";
          yield* seedThreadFolderFixture("folder", "space");
          const seed = (id: ThreadId) =>
            createThreadFixture(sql, {
              threadId: id,
              folderId: FolderId.make("folder"),
              title: "Switch",
              modelSelection: { provider: "opencode", model: "provider/model" },
              runtimeMode: "full-access",
              connection: { kind: "selected", connectionId: oldConnection },
              creator: { kind: "user" },
              createdAt: at,
            });
          yield* seed(threadId);
          yield* sql`UPDATE threads SET native_state_id='source-generation',provider_session_id='ses_owned' WHERE id=${threadId}`;
          if (scenario === "shared-id") {
            const peer = ThreadId.make("peer");
            yield* seed(peer);
            yield* sql`UPDATE threads SET provider_session_id='ses_owned' WHERE id=${peer}`;
          }
          if (scenario === "commit-fails")
            yield* sql.unsafe(
              "CREATE TRIGGER reject_switch BEFORE UPDATE OF connection_id ON threads BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END",
            );
          const order: string[] = [];
          const discarded: string[] = [];
          const selection: ResolvedProviderTurnSelection = {
            threadId,
            harness: "opencode",
            connectionId: newConnection,
            connectionLabel: "New",
            previousConnectionId: oldConnection,
            previousModelId: "provider/model",
            installationId: ProviderInstallationId.make("installation"),
            internalProviderId: "provider",
            modelId: "provider/model",
            modelLabel: "Model",
            nativeStateId: "source-generation",
            providerSessionId: "ses_owned",
            changed: true,
            requiresNativeStateMaterialization: true,
          };
          const coordinator = yield* makeProviderThreadSwitchCoordinator.pipe(
            Effect.provide(ThreadLanesLive),
            Effect.provideService(ThreadPublisher, makeThreadPublisher()),
            Effect.provideService(ServerConfig, {
              stateDir: "/unopened-fixture",
            } as typeof ServerConfig.Service),
            Effect.provideService(ProviderService, {
              stop: () =>
                Effect.sync(() => {
                  order.push("stop");
                }),
            } as unknown as typeof ProviderService.Service),
            Effect.provideService(ProviderSessionDirectory, {
              getBinding: () => Effect.succeed(Option.none()),
            } as unknown as typeof ProviderSessionDirectory.Service),
            Effect.provideService(ConnectionRateLimits, {
              refreshUsage: () => Effect.void,
            } as unknown as typeof ConnectionRateLimits.Service),
            Effect.provideService(ProviderTurnSelectionResolver, {
              resolveExisting: () => Effect.succeed(selection),
            } as unknown as typeof ProviderTurnSelectionResolver.Service),
            Effect.provideService(ProviderLaunchResolver, {
              resolveProfile: () =>
                Effect.succeed({
                  binaryPath: "/native",
                  profileRoot: "/target",
                  nativeStateRoot: "/unused",
                  isolationKey: "target",
                  connectionId: newConnection,
                  installationId: selection.installationId,
                  assertCurrentCredentials: Effect.void,
                  childEnvironment: () => ({}),
                }),
            } as unknown as typeof ProviderLaunchResolver.Service),
            Effect.provideService(ProviderAdapterRegistry, {
              getByProvider: () =>
                Effect.succeed({
                  copyNativeConversation: () =>
                    Effect.gen(function* () {
                      order.push("copy");
                      const [row] = yield* sql<{
                        connection_id: string;
                      }>`SELECT connection_id FROM threads WHERE id=${threadId}`;
                      expect(row!.connection_id).toBe(oldConnection);
                      if (scenario === "copy-fails")
                        return yield* new ProviderAdapterRequestError({
                          provider: "opencode",
                          method: "storage.copy",
                          detail: "fixture copy failure",
                        });
                      return "ses_owned";
                    }),
                }),
            } as unknown as typeof ProviderAdapterRegistry.Service),
            Effect.provideService(ProviderNativeStateMaterializer, {
              clone: () => Effect.die("OpenCode must not clone a database"),
              discard: (id: string) =>
                Effect.sync(() => {
                  discarded.push(id);
                }),
            } as typeof ProviderNativeStateMaterializer.Service),
            Effect.provideService(TurnDispatch, {
              dispatch: () =>
                Effect.gen(function* () {
                  order.push("dispatch");
                  const [row] = yield* sql<{
                    connection_id: string;
                  }>`SELECT connection_id FROM threads WHERE id=${threadId}`;
                  expect(row!.connection_id).toBe(newConnection);
                  return { threadId, turnId: TurnId.make("turn") };
                }),
            } as typeof TurnDispatch.Service),
          );
          const result = yield* Effect.exit(
            coordinator.dispatchTurnStart({
              command: {
                threadId,
                message: {
                  messageId: MessageId.make("message"),
                  text: "Continue",
                  attachments: [],
                },
                connectionId: newConnection,
                dispatchMode: "queue",
                runtimeMode: "full-access",
                createdAt: at,
              },
              attachmentPrincipal: { kind: "user" } as never,
            }),
          );
          const [row] = yield* sql<{
            connection_id: string;
            native_state_id: string;
          }>`SELECT connection_id,native_state_id FROM threads WHERE id=${threadId}`;
          expect(result._tag).toBe(scenario === "success" ? "Success" : "Failure");
          expect(row!.connection_id).toBe(scenario === "success" ? newConnection : oldConnection);
          expect(order).toEqual(
            scenario === "success"
              ? ["stop", "copy", "dispatch"]
              : scenario === "shared-id"
                ? ["stop"]
                : ["stop", "copy"],
          );
          if (scenario === "success") expect(discarded).toEqual(["source-generation"]);
          else if (scenario === "commit-fails") {
            expect(discarded).toHaveLength(1);
            expect(discarded[0]).not.toBe("source-generation");
          } else expect(discarded).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    );
  });
}
