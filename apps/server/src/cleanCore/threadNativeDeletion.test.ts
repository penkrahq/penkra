import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { Effect, Option } from "effect";
import { FolderId, ProviderConnectionId, ThreadId } from "@penkra/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderInstallationRepository } from "../persistence/Services/ProviderInstallations.ts";
import { ProviderConnectionRepository } from "../persistence/Services/ProviderConnections.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import {
  providerConnectionProfileRoot,
  providerNativeStateRoot,
} from "../provider/providerNativeStatePaths.ts";
import { ServerConfig } from "../config.ts";
import { makeThreadLifecycle } from "./threadLifecycle.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { ThreadSender } from "./ThreadSender.ts";
import { createThreadFixture, seedThreadFolderFixture } from "./threadFixtures.ts";

for (const scenario of ["success", "native-fails", "shared-id"] as const) {
  it(`deletes native OpenCode ownership safely: ${scenario}`, async () => {
    const scratch = path.resolve(import.meta.dirname, "../../../../.penkra/scratch");
    await mkdir(scratch, { recursive: true });
    const stateDir = await mkdtemp(path.join(scratch, "native-delete-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* runMigrations();
            const sql = yield* SqlClient.SqlClient;
            const threadId = ThreadId.makeUnsafe("native-delete");
            const oldConnection = ProviderConnectionId.makeUnsafe("old-connection");
            const otherConnection = ProviderConnectionId.makeUnsafe("other-connection");
            const at = "2026-10-22T00:00:00.000Z";
            yield* seedThreadFolderFixture("folder", "space");
            const seed = (id: ThreadId) =>
              createThreadFixture(sql, {
                threadId: id,
                folderId: FolderId.makeUnsafe("folder"),
                title: "Native delete",
                modelSelection: { provider: "opencode", model: "provider/model" },
                runtimeMode: "full-access",
                connection: { kind: "selected", connectionId: oldConnection },
                creator: { kind: "user" },
                createdAt: at,
              });
            yield* seed(threadId);
            yield* sql`UPDATE threads SET native_state_id='generation',provider_session_id='ses_owned' WHERE id=${threadId}`;
            if (scenario === "shared-id") {
              const peer = ThreadId.makeUnsafe("peer");
              yield* seed(peer);
              yield* sql`UPDATE threads SET provider_session_id='ses_owned' WHERE id=${peer}`;
            }
            const nativeRoot = providerNativeStateRoot(stateDir, "generation");
            yield* Effect.promise(async () => {
              await mkdir(nativeRoot, { recursive: true });
              await writeFile(path.join(nativeRoot, "owned"), "source");
            });
            const deleted: string[] = [];
            const lifecycle = yield* makeThreadLifecycle.pipe(
              Effect.provideService(ServerConfig, { stateDir } as typeof ServerConfig.Service),
              Effect.provideService(ThreadPublisher, makeThreadPublisher()),
              Effect.provideService(ThreadSender, {
                runExclusive: (_id, operation) => operation,
              } as typeof ThreadSender.Service),
              Effect.provideService(ProviderService, {
                stop: () => Effect.void,
              } as unknown as typeof ProviderService.Service),
              Effect.provideService(
                ProviderTurnSelectionResolver,
                {} as typeof ProviderTurnSelectionResolver.Service,
              ),
              Effect.provideService(ProviderInstallationRepository, {
                getActiveRecord: () =>
                  Effect.succeed(Option.some({ executablePath: "/managed/opencode" })),
              } as unknown as typeof ProviderInstallationRepository.Service),
              Effect.provideService(ProviderConnectionRepository, {
                list: () =>
                  Effect.succeed([
                    { id: oldConnection, harness: "opencode", lifecycle: "terminated" },
                    { id: otherConnection, harness: "opencode", lifecycle: "active" },
                  ]),
              } as unknown as typeof ProviderConnectionRepository.Service),
              Effect.provideService(ProviderAdapterRegistry, {
                getByProvider: () =>
                  Effect.succeed({
                    deleteNativeConversation: (input: {
                      profileRoot: string;
                      providerSessionId: string;
                    }) =>
                      Effect.gen(function* () {
                        deleted.push(input.profileRoot);
                        expect(input.providerSessionId).toBe("ses_owned");
                        const [row] = yield* sql<{
                          deleted_at: string | null;
                        }>`SELECT deleted_at FROM threads WHERE id=${threadId}`;
                        expect(row!.deleted_at).toBeNull();
                        if (scenario === "native-fails")
                          return yield* new ProviderAdapterRequestError({
                            provider: "opencode",
                            method: "storage.delete",
                            detail: "fixture failure",
                          });
                      }),
                  }),
              } as unknown as typeof ProviderAdapterRegistry.Service),
            );
            const result = yield* Effect.exit(
              lifecycle.update({ action: "delete", threadId, deletedAt: at, updatedAt: at }),
            );
            const [row] = yield* sql<{
              deleted_at: string | null;
            }>`SELECT deleted_at FROM threads WHERE id=${threadId}`;
            expect(result._tag).toBe(scenario === "success" ? "Success" : "Failure");
            expect(row!.deleted_at).toBe(scenario === "success" ? at : null);
            expect(
              yield* Effect.promise(() =>
                access(nativeRoot).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(scenario !== "success");
            const expected = ["anonymous:opencode", oldConnection, otherConnection].map((id) =>
              providerConnectionProfileRoot(stateDir, id),
            );
            expect(deleted).toEqual(
              scenario === "success"
                ? expected
                : scenario === "native-fails"
                  ? expected.slice(0, 1)
                  : [],
            );
          }),
        ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
