import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { ThreadId, type OrchestrationCommand } from "@penkra/contracts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import { resolveAllowedLocalPreviewFile } from "../localImageFiles.ts";
import { presentFile, resolvePresentFileWorkingDirectory } from "./presentFile.ts";

describe("penkra show file", () => {
  it("uses the same durable fallback workspace as the provider when Thread cwd is unset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-show-cwd-test-"));
    try {
      const cwd = resolvePresentFileWorkingDirectory({
        threadId: ThreadId.makeUnsafe("thread-show-fallback"),
        workingDirectory: null,
        projectCwd: null,
        stateDir: root,
      });
      const imagePath = path.join(cwd, "circle.png");
      await fs.writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await expect(
        resolveAllowedLocalPreviewFile({
          requestedPath: imagePath,
          cwd,
          stateDir: root,
          allowAnyWorkspaceFile: true,
        }),
      ).resolves.toMatchObject({ path: await fs.realpath(imagePath) });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("stores a durable image and appends one current-turn media activity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-show-test-"));
    try {
      const sourcePath = path.join(root, "logo.png");
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
      await fs.writeFile(sourcePath, bytes);
      let blob: ManagedAttachmentBlob | undefined;
      let command: OrchestrationCommand | undefined;
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
            blob = { ...blob!, state: "staged", sizeBytes: input.sizeBytes, sha256: input.sha256 };
            return { status: "staged" as const, attachment: blob };
          }),
        claimForAcceptedTurn: () =>
          Effect.sync(() => {
            blob = { ...blob!, state: "claimed" };
            return { status: "claimed" as const, attachments: [blob!] };
          }),
      } as unknown as ManagedAttachmentRepositoryShape;
      const engine = {
        dispatch: (input: OrchestrationCommand) =>
          Effect.sync(() => {
            command = input;
            return {};
          }),
      } as unknown as OrchestrationEngineShape;
      const result = await Effect.runPromise(
        presentFile({
          requestedPath: "./logo.png",
          workingDirectory: root,
          threadId: `thread-${randomUUID()}`,
          turnId: "turn-active",
          attachmentsDir: path.join(root, "attachments"),
          stateDir: root,
          repository,
          engine,
          assertActive: () => Effect.void,
          presentationId: "gallery-1",
          presentationIndex: 2,
        }),
      );
      expect(result.attachment.type).toBe("image");
      expect(blob?.state).toBe("claimed");
      expect(command).toMatchObject({
        type: "thread.activity.append",
        activity: {
          kind: "media.presented",
          turnId: "turn-active",
          payload: {
            attachmentId: result.attachment.id,
            name: "logo.png",
            type: "image",
            presentationId: "gallery-1",
            presentationIndex: 2,
          },
        },
      });
      await fs.unlink(sourcePath);
      expect(await fs.readFile(path.join(root, "attachments", blob!.relativePath))).toEqual(bytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
