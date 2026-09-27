// FILE: desktopThreadRoute.ts
// Purpose: Private loopback endpoint for window-independent App Thread commands.

import * as FS from "node:fs/promises";

import { ThreadId, type DesktopThreadApiRequest } from "@penkra/contracts";
import { Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "./config";
import { DesktopThreadCommands } from "./desktopThreadCommands";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "./managedAttachmentStore";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderThreadSwitchCoordinator } from "./orchestration/Services/ProviderThreadSwitchCoordinator";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ManagedAttachmentRepository } from "./persistence/Services/ManagedAttachments";
import { ThreadProviderBindingRepository } from "./persistence/Services/ThreadProviderBindings";
import { authorizeDesktopShutdown } from "./serverShutdown";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";

export const DESKTOP_THREAD_ROUTE_PATH = "/api/desktop/thread-command";
let commands: DesktopThreadCommands | null = null;

export const desktopThreadRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_THREAD_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const auth = authorizeDesktopShutdown({
      config,
      remoteAddress: request.remoteAddress,
      authorization: request.headers.authorization,
    });
    if (!auth.authorized)
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: auth.reason },
        { status: auth.status },
      );
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const switchCoordinator = yield* ProviderThreadSwitchCoordinator;
    const attachments = yield* ManagedAttachmentRepository;
    const runtimeStartup = yield* ServerRuntimeStartup;
    const providerBindings = yield* ThreadProviderBindingRepository;
    commands ??= new DesktopThreadCommands({
      snapshot: () => Effect.runPromise(snapshotQuery.getShellSnapshot()),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      bindingRevision: async (threadId) => {
        const binding = await Effect.runPromise(
          providerBindings.getRuntimeBinding(ThreadId.makeUnsafe(threadId)),
        );
        return Option.match(binding, { onNone: () => 0, onSome: (value) => value.revision });
      },
      dispatch: (command) =>
        Effect.runPromise(runtimeStartup.enqueueCommand(engine.dispatch(command))),
      dispatchTurn: (command, ownerId) =>
        Effect.runPromise(
          runtimeStartup.enqueueCommand(
            switchCoordinator.dispatchTurnStart({
              command,
              attachmentPrincipal: { ownerKind: "session", ownerId },
            }),
          ),
        ),
      stageAttachment: async ({ threadId, ownerId, type, attachment }) => {
        const path = attachment.path;
        if (typeof path !== "string" || !path.startsWith("/"))
          throw new Error("Composer attachment path is invalid.");
        const bytes = await FS.readFile(path);
        const principal = { ownerKind: "session" as const, ownerId };
        const now = new Date().toISOString();
        const reservation = await Effect.runPromise(
          reserveManagedAttachmentUpload({
            type,
            threadId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            reservedBytes: bytes.byteLength,
            now,
            principal,
            repository: attachments,
          }),
        );
        return Effect.runPromise(
          persistReservedManagedAttachment({
            reservation,
            bytes,
            attachmentsDir: config.attachmentsDir,
            now,
            principal,
            repository: attachments,
          }),
        );
      },
    });
    const payload = yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(1024 * 1024)),
      Effect.mapError(() => new Error("Invalid Thread command body.")),
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof (payload as { method?: unknown }).method !== "string"
    ) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, code: "BAD_REQUEST", message: "Invalid Thread command." },
        { status: 400 },
      );
    }
    const result = yield* Effect.tryPromise(() =>
      commands!.execute(payload as DesktopThreadApiRequest),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({
          ok: false as const,
          code:
            "code" in error && typeof error.code === "string"
              ? error.code
              : "THREAD_COMMAND_FAILED",
          message: error.message,
        }),
        onSuccess: (value) => ({ ok: true as const, result: value }),
      }),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 });
  }),
);
