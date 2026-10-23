import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { ThreadId } from "@penkra/contracts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { seedThreadFolderFixture } from "../cleanCore/threadFixtures.ts";
import { createThread, makeThreadPublisher } from "../cleanCore/threadStore.ts";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import { resolveLocalPreviewFile } from "../localImageFiles.ts";
import { presentFile, resolvePresentFileCwd } from "./presentFile.ts";

describe("penkra show file", () => {
  it("uses the same durable fallback workspace as the provider when Thread cwd is unset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-show-cwd-test-"));
    try {
      const cwd = resolvePresentFileCwd({
        threadId: ThreadId.makeUnsafe("thread-show-fallback"),
        projectCwd: null,
        stateDir: root,
      });
      const imagePath = path.join(cwd, "circle.png");
      await fs.writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await expect(
        resolveLocalPreviewFile({
          requestedPath: imagePath,
          cwd,
          allowAnyFile: true,
        }),
      ).resolves.toMatchObject({ path: await fs.realpath(imagePath) });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["png", "pdf", "mp4"])(
    "stores a durable external %s and appends one current-turn media activity",
    async (extension) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-show-test-"));
      try {
        const sourcePath = path.join(root, `logo.${extension}`);
        const cwd = path.join(root, "workspace");
        await fs.mkdir(cwd);
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
        await fs.writeFile(sourcePath, bytes);
        let blob: ManagedAttachmentBlob | undefined;
        const threadId = `thread-${randomUUID()}`;
        const repository = {
          reserve: (input: Parameters<ManagedAttachmentRepositoryShape["reserve"]>[0]) =>
            Effect.sync(() => {
              blob = {
                ...input,
                sizeBytes: null,
                sha256: null,
                state: "uploading",
                stagingExpiresAt: null,
                claimCommandId: null,
                claimMessageId: null,
                claimedAt: null,
                deleteReason: null,
                deleteRequestedAt: null,
                deletedAt: null,
                createdAt: input.now,
                updatedAt: input.now,
              };
              return { status: "reserved" as const, attachment: blob };
            }),
          finalizeStaged: (
            input: Parameters<ManagedAttachmentRepositoryShape["finalizeStaged"]>[0],
          ) =>
            Effect.sync(() => {
              blob = {
                ...blob!,
                state: "staged",
                sizeBytes: input.sizeBytes,
                sha256: input.sha256,
              };
              return { status: "staged" as const, attachment: blob };
            }),
          claimForAcceptedTurn: () =>
            Effect.sync(() => {
              blob = { ...blob!, state: "claimed" };
              return { status: "claimed" as const, attachments: [blob!] };
            }),
        } as unknown as ManagedAttachmentRepositoryShape;
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* runMigrations();
            yield* seedThreadFolderFixture("folder", "space");
            yield* createThread({
              id: threadId,
              folderId: "folder",
              spaceId: "space",
              title: "Show",
              provider: "codex",
              model: "model",
              runtimeMode: "full-access",
              createdBy: "user",
              createdAt: new Date().toISOString(),
            });
            const result = yield* presentFile({
              requestedPath: `../logo.${extension}`,
              cwd,
              threadId,
              turnId: "turn-active",
              attachmentsDir: path.join(root, "attachments"),
              repository,
              publisher: makeThreadPublisher(),
              assertActive: () => Effect.void,
              presentationId: "gallery-1",
              presentationIndex: 2,
            });
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              data: string;
              turnId: string;
            }>`SELECT data,turn_id AS "turnId" FROM thread_items WHERE thread_id=${threadId}`;
            expect(row!.turnId).toBe("turn-active");
            expect(JSON.parse(row!.data)).toMatchObject({
              kind: "media.presented",
              payload: {
                attachmentId: result.attachment.id,
                name: `logo.${extension}`,
                type: extension === "png" ? "image" : "file",
                presentationId: "gallery-1",
                presentationIndex: 2,
              },
            });
            return result;
          }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
        );
        expect(result.attachment.type).toBe(extension === "png" ? "image" : "file");
        if (extension === "mp4") expect(result.attachment.mimeType).toBe("video/mp4");
        expect(blob?.state).toBe("claimed");
        await fs.unlink(sourcePath);
        expect(await fs.readFile(path.join(root, "attachments", blob!.relativePath))).toEqual(
          bytes,
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
