import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { MessageId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createThread, makeThreadPublisher } from "./threadStore.ts";
import {
  deliverMessage,
  sendMessage,
  STOPPED_BEFORE_DELIVERED,
  type SendDriver,
} from "./sendMessage.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const at = "2026-11-26T09:19:27.854Z";

// A stop while the provider is still starting interrupts that start; the interrupt
// reaches the delivery. The message must not stay in `sending` forever.
it.effect("a stop during provider start settles the message as failed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreadFolderFixture("core-test-folder", "space-1");
    yield* createThread({
      id: "thread-1",
      spaceId: "space-1",
      folderId: "core-test-folder",
      title: "Hello",
      provider: "opencode",
      model: "m",
      runtimeMode: "full-access",
      createdBy: "user" as const,
      createdAt: at,
    } as never);
    const publisher = makeThreadPublisher();
    const driver: SendDriver = {
      isRunning: () => Effect.succeed(false),
      claimAttachments: () => Effect.void,
      dispatch: () => Effect.interrupt,
    };
    const input = {
      threadId: "thread-1",
      supportsSteer: true,
      message: {
        messageId: MessageId.make("m-continue"),
        text: "Continue",
        attachments: [],
        origin: { _tag: "user" },
        queuedAt: at,
      },
    } as never;
    const admitted = yield* sendMessage(publisher, driver, input);
    assert.strictEqual(admitted.delivery?.plan, "deliver");
    const [before] = yield* sql<{ status: string }>`SELECT status FROM thread_items
      WHERE thread_id='thread-1' AND source_id='m-continue'`;
    assert.strictEqual(before?.status, "sending");

    const exit = yield* Effect.exit(
      deliverMessage(publisher, driver, admitted.delivery!.input, admitted.delivery!.plan),
    );
    // The interrupt still propagates to the fiber that was delivering...
    assert.isTrue(Exit.isFailure(exit));
    // ...but the message is settled, so it joins the next send instead of blocking it.
    const [after] = yield* sql<{ status: string }>`SELECT status FROM thread_items
      WHERE thread_id='thread-1' AND source_id='m-continue'`;
    assert.strictEqual(after?.status, "failed");
    const [thread] = yield* sql<{ lastError: string | null }>`SELECT last_error AS "lastError"
      FROM threads WHERE id='thread-1'`;
    assert.strictEqual(thread?.lastError, STOPPED_BEFORE_DELIVERED);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
