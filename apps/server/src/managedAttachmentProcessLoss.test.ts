import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { runManagedAttachmentCleanupBatch } from "./managedAttachmentCleanup";
import { resolveAttachmentRelativePath } from "./attachmentPaths";
import { makeManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import { ManagedAttachmentRepository } from "./persistence/Services/ManagedAttachments";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function makeRuntime(root: string) {
  const persistence = makeSqlitePersistenceLive(path.join(root, "state.sqlite"));
  const repository = makeManagedAttachmentRepositoryLive().pipe(Layer.provideMerge(persistence));
  return ManagedRuntime.make(
    Layer.mergeAll(
      persistence,
      repository,
      Layer.succeed(ServerConfig, {
        attachmentsDir: path.join(root, "attachments"),
      } as ServerConfigShape),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  );
}

const ids = {
  reserved: "att_v2_00000000000000000000000000000001",
  writing: "att_v2_00000000000000000000000000000002",
  renamed: "att_v2_00000000000000000000000000000003",
  staged: "att_v2_00000000000000000000000000000004",
  claimed: "att_v2_00000000000000000000000000000005",
} as const;

function relativePath(attachmentId: string) {
  return `objects/${attachmentId.slice("att_v2_".length, "att_v2_".length + 2)}/${attachmentId}.bin`;
}

describe("managed attachment process-loss recovery", () => {
  it("keeps presented media during message pruning and deletes it with its Thread", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-presented-media-cleanup-"));
    temporaryRoots.push(root);
    const runtime = makeRuntime(root);
    try {
      const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
      const attachmentId = "att_v2_00000000000000000000000000000099";
      const now = new Date().toISOString();
      const reserved = await runtime.runPromise(
        repository.reserve({
          attachmentId,
          ownerThreadId: "thread-media",
          ownerKind: "presented-media",
          ownerId: "thread-media",
          kind: "image",
          originalName: "logo.png",
          mimeType: "image/png",
          reservedBytes: 4,
          relativePath: `objects/00/${attachmentId}.png`,
          now,
        }),
      );
      expect(reserved.status).toBe("reserved");
      await runtime.runPromise(
        repository.finalizeStaged({
          attachmentId,
          ownerThreadId: "thread-media",
          ownerKind: "presented-media",
          ownerId: "thread-media",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          stagingExpiresAt: "2099-01-01T00:00:00.000Z",
          now,
        }),
      );
      const claim = await runtime.runPromise(
        repository.claimForAcceptedTurn({
          attachmentIds: [attachmentId],
          ownerThreadId: "thread-media",
          ownerKind: "presented-media",
          ownerId: "thread-media",
          commandId: "show-command",
          messageId: "media-activity",
          now,
        }),
      );
      expect(claim.status).toBe("claimed");
      expect(
        await runtime.runPromise(
          repository.markUnreferencedClaimedForCleanup({
            ownerThreadId: "thread-media",
            retainedAttachmentIds: [],
            reason: "message-pruned",
            requestedAt: now,
          }),
        ),
      ).toEqual([]);
      expect((await runtime.runPromise(repository.findClaimedById({ attachmentId })))._tag).toBe(
        "Some",
      );
      expect(
        await runtime.runPromise(
          repository.markCleanupByThread({
            ownerThreadId: "thread-media",
            reason: "thread-deleted",
            requestedAt: now,
          }),
        ),
      ).toEqual([attachmentId]);
    } finally {
      await runtime.dispose();
    }
  });
  it("converges reserve/write/rename/finalize windows while preserving a claimed blob", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-attachment-recovery-"));
    temporaryRoots.push(root);
    const attachmentsDir = path.join(root, "attachments");
    const old = "2020-01-01T00:00:00.000Z";

    const firstRuntime = makeRuntime(root);
    const repository = await firstRuntime.runPromise(Effect.service(ManagedAttachmentRepository));
    for (const attachmentId of Object.values(ids)) {
      const reserved = await firstRuntime.runPromise(
        repository.reserve({
          attachmentId,
          ownerThreadId: "thread-recovery",
          ownerKind: "session",
          ownerId: "session-recovery",
          kind: "file",
          originalName: `${attachmentId}.bin`,
          mimeType: "application/octet-stream",
          reservedBytes: 4,
          relativePath: relativePath(attachmentId),
          now: old,
        }),
      );
      expect(reserved.status).toBe("reserved");
    }

    const stagingDir = path.join(attachmentsDir, ".staging");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, `${ids.writing}.part`), "part");

    for (const attachmentId of [ids.renamed, ids.staged, ids.claimed]) {
      const finalPath = resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: relativePath(attachmentId),
      });
      expect(finalPath).not.toBeNull();
      await fs.mkdir(path.dirname(finalPath!), { recursive: true });
      await fs.writeFile(finalPath!, "blob");
    }

    for (const attachmentId of [ids.staged, ids.claimed]) {
      const finalized = await firstRuntime.runPromise(
        repository.finalizeStaged({
          attachmentId,
          ownerThreadId: "thread-recovery",
          ownerKind: "session",
          ownerId: "session-recovery",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          stagingExpiresAt:
            attachmentId === ids.staged ? "2020-01-01T00:01:00.000Z" : "2099-01-01T00:00:00.000Z",
          now: old,
        }),
      );
      expect(finalized.status).toBe("staged");
    }
    const claim = await firstRuntime.runPromise(
      repository.claimForAcceptedTurn({
        attachmentIds: [ids.claimed],
        ownerThreadId: "thread-recovery",
        ownerKind: "session",
        ownerId: "session-recovery",
        commandId: "command-recovery",
        messageId: "message-recovery",
        now: "2020-01-01T00:00:01.000Z",
      }),
    );
    expect(claim.status).toBe("claimed");
    await firstRuntime.dispose();

    const recoveredRuntime = makeRuntime(root);
    await recoveredRuntime.runPromise(runManagedAttachmentCleanupBatch);

    for (const attachmentId of [ids.reserved, ids.writing, ids.renamed, ids.staged]) {
      const finalPath = resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: relativePath(attachmentId),
      });
      await expect(fs.stat(finalPath!)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(stagingDir, `${attachmentId}.part`))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const claimedPath = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: relativePath(ids.claimed),
    });
    await expect(fs.readFile(claimedPath!, "utf8")).resolves.toBe("blob");

    const recoveredRepository = await recoveredRuntime.runPromise(
      Effect.service(ManagedAttachmentRepository),
    );
    const usage = await recoveredRuntime.runPromise(
      recoveredRepository.getUsage({ ownerKind: "session", ownerId: "session-recovery" }),
    );
    expect(usage).toEqual({
      homeBytes: 4,
      homeCount: 1,
      principalStagingBytes: 0,
      principalStagingCount: 0,
    });
    const sql = await recoveredRuntime.runPromise(Effect.service(SqlClient.SqlClient));
    const rows = await recoveredRuntime.runPromise(sql<{ state: string; count: number }>`
      SELECT state, COUNT(*) AS count
      FROM managed_attachment_blobs
      GROUP BY state
      ORDER BY state
    `);
    expect(rows).toEqual([
      { state: "claimed", count: 1 },
      { state: "deleted", count: 4 },
    ]);
    const jobs = await recoveredRuntime.runPromise(sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM managed_attachment_cleanup_jobs
    `);
    expect(jobs[0]?.count).toBe(0);
    await recoveredRuntime.dispose();
  });
});
