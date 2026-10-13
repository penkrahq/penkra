// FILE: failedSendPayload.test.ts
// Purpose: Proves failed native inputs retain full context and attachment ownership across explicit retries.
import { assert, it } from "@effect/vitest";
import { MessageId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread, makeThreadPublisher } from "./threadStore.ts";
import {
  sendMessage,
  settleMessage,
  deliverMessage,
  type SendDriver,
  type SendMessageInput,
} from "./sendMessage.ts";

it.effect(
  "rebinds old and new files to one native message, then returns their claims on failure",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("folder", "space");
      const at = "2026-10-13T00:00:00.000Z";
      yield* createThread({
        id: "thread",
        folderId: "folder",
        spaceId: "space",
        title: "Thread",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: at,
      });
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      for (const [id, ownerId] of [
        ["file-a", "first-owner"],
        ["file-b", "second-owner"],
      ]) {
        yield* repository.reserve({
          attachmentId: id!,
          ownerThreadId: "thread",
          ownerKind: "session" as const,
          ownerId: ownerId!,
          kind: "image",
          originalName: id!,
          mimeType: "image/png",
          reservedBytes: 4,
          relativePath: id!,
          now: at,
        });
        yield* repository.finalizeStaged({
          attachmentId: id!,
          ownerThreadId: "thread",
          ownerKind: "session" as const,
          ownerId: ownerId!,
          sizeBytes: 4,
          sha256: "a".repeat(64),
          stagingExpiresAt: "9999-01-01T00:00:00.000Z",
          now: at,
        });
      }
      const publisher = makeThreadPublisher();
      const request = (id: string, attachment: string): SendMessageInput => ({
        threadId: "thread",
        dispatchMode: "queue",
        supportsSteer: true,
        message: {
          messageId: MessageId.makeUnsafe(id),
          text: id,
          attachments: [
            {
              type: "image",
              id: attachment,
              name: attachment,
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
          senderThreadId: null,
          dispatchOrigin: "user",
          queuedAt: at,
        },
        skills: [{ name: id, path: `/${id}/SKILL.md` }],
        mentions: [{ name: id, path: `/${id}/plugin` }],
      });
      const driver: SendDriver = {
        claimAttachments: (input) =>
          Effect.gen(function* () {
            const owner = yield* CurrentManagedAttachmentPrincipal;
            const claim = yield* repository.claimForAcceptedTurn({
              attachmentIds: input.message.attachments
                .filter((a) => a.type !== "assistant-selection")
                .map((a) => a.id),
              ownerThreadId: "thread",
              ...owner,
              commandId: input.message.messageId,
              messageId: input.message.messageId,
              now: at,
            });
            assert.equal(claim.status, "claimed");
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
        dispatch: () => Effect.void,
      };
      yield* sendMessage(publisher, driver, request("a", "file-a")).pipe(
        Effect.provideService(CurrentManagedAttachmentPrincipal, {
          ownerKind: "session" as const,
          ownerId: "first-owner",
        }),
      );
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "a", error: "refused" },
        at,
      );
      yield* sendMessage(publisher, driver, request("b", "file-b")).pipe(
        Effect.provideService(CurrentManagedAttachmentPrincipal, {
          ownerKind: "session" as const,
          ownerId: "second-owner",
        }),
      );
      yield* deliverMessage(
        publisher,
        {
          ...driver,
          dispatch: (combined) =>
            Effect.gen(function* () {
              assert.equal(combined.message.text, "a\n\nb");
              assert.deepStrictEqual(
                combined.message.attachments.map((a) => a.id),
                ["file-a", "file-b"],
              );
              assert.deepStrictEqual(
                combined.skills?.map((a) => a.name),
                ["a", "b"],
              );
              assert.deepStrictEqual(
                combined.mentions?.map((a) => a.name),
                ["a", "b"],
              );
              // Exact claim validation used by the real turn-admission owner, without a bypass.
              const claim = yield* repository.claimForAcceptedTurn({
                attachmentIds: ["file-a", "file-b"],
                ownerThreadId: "thread",
                ownerKind: "session" as const,
                ownerId: "second-owner",
                commandId: "native-command",
                messageId: "b",
                now: at,
              });
              assert.equal(claim.status, "claimed");
              return yield* Effect.fail(new Error("combined refused"));
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        },
        request("b", "file-b"),
        "deliver",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT attachment_id,claim_message_id FROM managed_attachment_blobs ORDER BY attachment_id`,
        [
          { attachment_id: "file-a", claim_message_id: "a" },
          { attachment_id: "file-b", claim_message_id: "b" },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM thread_items WHERE kind='user' ORDER BY seq`,
        [{ status: "failed" }, { status: "failed" }],
      );
    }).pipe(
      Effect.provide(ManagedAttachmentRepositoryLive),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);
