import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@penkra/contracts";
import { Effect } from "effect";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { upsertThreadItem, type ThreadPublisher } from "../cleanCore/threadStore.ts";
import { threadItemActivityData } from "../cleanCore/threadItemData.ts";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { resolveLocalPreviewFile } from "../localImageFiles.ts";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";

export function resolvePresentFileCwd(input: {
  readonly threadId: ThreadId;
  readonly projectCwd: string | null;
  readonly stateDir: string;
}): string {
  return input.projectCwd ?? ensureDurableThreadWorkspace(input.threadId, input.stateDir);
}

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function isMatchingImage(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png")
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === "image/gif")
    return (
      Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF87a" ||
      Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF89a"
    );
  if (mimeType === "image/webp")
    return (
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
    );
  return false;
}

export function presentFile(input: {
  readonly requestedPath: string;
  readonly cwd: string | null;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly attachmentsDir: string;
  readonly repository: ManagedAttachmentRepositoryShape;
  readonly publisher: ThreadPublisher;
  readonly assertActive: () => Effect.Effect<void, Error>;
  readonly presentationId?: string;
  readonly presentationIndex?: number;
}) {
  return Effect.gen(function* () {
    const file = yield* Effect.promise(() =>
      resolveLocalPreviewFile({
        requestedPath: input.requestedPath,
        cwd: input.cwd,
        allowAnyFile: true,
      }),
    );
    if (!file) {
      return yield* Effect.fail(
        new ToolInputError("File not found, unreadable, or not a regular file."),
      );
    }
    const source = yield* Effect.tryPromise({
      try: async () => {
        const info = await fs.stat(file.path);
        if (!info.isFile() || info.size === 0 || info.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ToolInputError("Choose a nonempty regular file within the file size limit.");
        }
        const bytes = await fs.readFile(file.path);
        if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ToolInputError("File size changed while it was being read.");
        }
        return { bytes, name: path.basename(file.path) };
      },
      catch: (error) => new ToolInputError(`Cannot show file: ${errorText(error)}`),
    });
    const imageMimeType = IMAGE_TYPES.get(path.extname(source.name).toLowerCase());
    const image =
      imageMimeType !== undefined &&
      source.bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES &&
      isMatchingImage(source.bytes, imageMimeType);
    const type = image ? "image" : "file";
    const mimeType = image ? imageMimeType! : "application/octet-stream";
    const principal = { ownerKind: "presented-media" as const, ownerId: input.threadId };
    const now = new Date().toISOString();
    yield* input.assertActive();
    const reservation = yield* reserveManagedAttachmentUpload({
      type,
      threadId: input.threadId,
      name: source.name,
      mimeType,
      reservedBytes: source.bytes.byteLength,
      now,
      principal,
      repository: input.repository,
    });
    const attachment = yield* persistReservedManagedAttachment({
      reservation,
      bytes: source.bytes,
      attachmentsDir: input.attachmentsDir,
      now,
      principal,
      repository: input.repository,
    });
    const artifactId = randomUUID();
    const commandId = CommandId.makeUnsafe(`agent:show:${artifactId}`);
    const claim = yield* input.repository.claimForAcceptedTurn({
      attachmentIds: [attachment.id],
      ownerThreadId: input.threadId,
      ownerKind: principal.ownerKind,
      ownerId: principal.ownerId,
      commandId,
      messageId: MessageId.makeUnsafe(`media:${artifactId}`),
      now: new Date().toISOString(),
    });
    if (claim.status !== "claimed") {
      yield* input.repository.cancelStaged({
        attachmentId: attachment.id,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        reason: "show-claim-failed",
        requestedAt: new Date().toISOString(),
      });
      return yield* Effect.fail(new ToolInputError(`Could not present file: ${claim.reason}.`));
    }
    const activity = {
      id: EventId.makeUnsafe(`media:${artifactId}`),
      tone: "info" as const,
      kind: "media.presented",
      summary: `Showed ${source.name}`,
      payload: {
        attachmentId: attachment.id,
        name: source.name,
        mimeType,
        sizeBytes: source.bytes.byteLength,
        type,
        ...(input.presentationId === undefined
          ? {}
          : {
              presentationId: input.presentationId,
              presentationIndex: input.presentationIndex,
            }),
      },
      turnId: input.turnId === null ? null : TurnId.makeUnsafe(input.turnId),
      createdAt: new Date().toISOString(),
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .withTransaction(
        upsertThreadItem({
          threadId: input.threadId,
          sourceId: activity.id,
          turnId: activity.turnId,
          kind: "notice",
          status: "done",
          text: activity.summary,
          data: threadItemActivityData(activity),
          createdAt: activity.createdAt,
          updatedAt: activity.createdAt,
        }),
      )
      .pipe(
        Effect.tapError(() =>
          input.repository.markCleanupByIds({
            attachmentIds: [attachment.id],
            ownerThreadId: input.threadId,
            reason: "show-activity-failed",
            requestedAt: new Date().toISOString(),
          }),
        ),
      );
    input.publisher.publish({ threadId: input.threadId });
    return { attachment, activityId: activity.id, turnId: input.turnId };
  });
}
