import { Effect, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { closeServerRuntimePipeline } from "./effectServer.ts";

describe("server runtime pipeline shutdown", () => {
  it("persists accepted provider terminal work before the engine stops", async () => {
    const order: string[] = [];
    let terminalAccepted = false;
    let providerCommandsSettled = false;
    let queuePromotionsQuiesced = false;
    let terminalPersisted = false;
    let attachmentsDrained = false;
    let workspaceWatcherClosed = false;
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        subscriptionsScope,
        Effect.sync(() => {
          expect(terminalAccepted).toBe(true);
          terminalPersisted = true;
          order.push("reactors-drained-and-persisted");
        }),
      ),
    );

    await Effect.runPromise(
      closeServerRuntimePipeline({
        orchestrationEngine: {
          quiesce: Effect.sync(() => order.push("engine-quiesced")),
          drain: Effect.sync(() => order.push("admitted-commands-drained")),
          stop: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(attachmentsDrained).toBe(true);
            expect(workspaceWatcherClosed).toBe(true);
            order.push("engine-stopped");
          }),
        },
        providerCommandReactor: {
          drain: Effect.sync(() => {
            expect(terminalAccepted).toBe(false);
            providerCommandsSettled = true;
            order.push("provider-commands-settled");
          }),
          quiesceQueuePromotions: Effect.sync(() => {
            expect(providerCommandsSettled).toBe(true);
            queuePromotionsQuiesced = true;
            order.push("queue-promotions-quiesced");
          }),
        },
        providerService: {
          closeRuntimeEvents: Effect.sync(() => {
            expect(providerCommandsSettled).toBe(true);
            expect(queuePromotionsQuiesced).toBe(true);
            terminalAccepted = true;
            order.push("provider-terminal-events-fenced");
          }),
        },
        managedAttachmentCleanup: {
          drain: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(workspaceWatcherClosed).toBe(true);
            attachmentsDrained = true;
            order.push("managed-attachments-drained");
          }),
        },
        workspaceWatcher: {
          close: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            workspaceWatcherClosed = true;
            order.push("workspace-watcher-closed");
          }),
        },
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "engine-quiesced",
      "admitted-commands-drained",
      "provider-commands-settled",
      "queue-promotions-quiesced",
      "provider-terminal-events-fenced",
      "reactors-drained-and-persisted",
      "workspace-watcher-closed",
      "managed-attachments-drained",
      "engine-stopped",
    ]);
  });
});
