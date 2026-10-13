import { observePublisher } from "./cleanCore/threadPublisherTestHelpers.ts";
import http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CleanCoreFolderAppTabsResult } from "@penkra/contracts";
import { HttpRouter } from "effect/unstable/http";
import { ServerConfig, type ServerConfigShape } from "./config";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";
import { runMigrations } from "./persistence/Migrations.ts";
import { seedThreadFolderFixture } from "./cleanCore/threadFixtures.ts";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import { makeThreadPublisher } from "./cleanCore/threadStore.ts";
import { desktopFolderAppTabsRouteLayer } from "./desktopFolderAppTabsRoute.ts";

it.effect(
  "authenticates window-independent folder reads and writes and broadcasts the committed row",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedThreadFolderFixture("folder", "space");
        const publisher = yield* ThreadPublisher;
        const changes: unknown[] = [];
        const unsubscribe = yield* observePublisher(publisher.sidebarChanges, (change) =>
          changes.push(change),
        );
        let nodeServer!: http.Server;
        const server = yield* NodeHttpServer.make(() => (nodeServer = http.createServer()), {
          port: 0,
          host: "127.0.0.1",
        });
        yield* server.serve(yield* HttpRouter.toHttpEffect(desktopFolderAppTabsRouteLayer));
        const address = nodeServer.address();
        if (!address || typeof address !== "object")
          throw new Error("Expected a bound test server");
        const url = `http://127.0.0.1:${address.port}/api/desktop/folder-app-tabs`;
        const send = (token: string, body: unknown) =>
          Effect.tryPromise(async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
          });
        assert.equal((yield* send("wrong", { action: "get", folderId: "folder" })).status, 401);
        const read = yield* send("private", { action: "get", folderId: "folder" });
        assert.equal(read.status, 200);
        assert.deepInclude(read.body, { ok: true });
        assert.equal(
          Schema.decodeUnknownSync(
            Schema.Struct({ result: Schema.Struct({ folderTitle: Schema.String }) }),
          )(read.body).result.folderTitle,
          "Fixture folder",
        );
        const update = {
          action: "update",
          folderId: "folder",
          updatedAt: "2026-10-11T00:00:00.000Z",
          update: {
            action: "open",
            pane: {
              id: "tab",
              kind: "app" as const,
              appId: "app",
              appSpaceId: "space",
              appSlug: "app",
              appName: "App",
              appRoute: "/",
            },
          },
        };
        const written = yield* send("private", update);
        assert.equal(written.status, 200);
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(Schema.Struct({ result: CleanCoreFolderAppTabsResult }))(
            written.body,
          ).result.tabs,
          {
            panes: [update.update.pane],
          },
        );
        assert.equal(changes.length, 1);
        yield* send("private", update);
        assert.equal(changes.length, 1);
        unsubscribe();
      }),
    ).pipe(
      Effect.provideService(ServerConfig, {
        mode: "desktop",
        host: "127.0.0.1",
        publicUrl: undefined,
        desktopShutdownToken: "private",
      } as ServerConfigShape),
      Effect.provideService(ThreadPublisher, makeThreadPublisher()),
      Effect.provide(NodeSqliteClient.layerMemory()),
      Effect.provide(NodeServices.layer),
    ),
);
