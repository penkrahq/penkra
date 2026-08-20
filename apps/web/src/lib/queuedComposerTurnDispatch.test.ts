import { ThreadId, type NativeApi } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import type { QueuedComposerChatTurn } from "../composerDraftDomain";
import {
  dispatchQueuedComposerTurn,
  getQueuedComposerTurnDispatchInFlight,
  isQueuedComposerBindingRevisionError,
  queuedComposerTurnCommandId,
} from "./queuedComposerTurnDispatch";

function makeQueuedTurn(): QueuedComposerChatTurn {
  return {
    id: "queued-follow-up-1",
    kind: "chat",
    createdAt: "2026-08-09T00:00:00.000Z",
    previewText: "continue",
    prompt: "continue",
    images: [],
    files: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: { provider: "codex", model: "gpt-5" },
    connectionId: null,
    runtimeMode: "full-access",
  };
}

describe("dispatchQueuedComposerTurn", () => {
  it("uses stable ids and the server queue command so retries are idempotent", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 12 });
    const getThreadBinding = vi.fn().mockResolvedValue({ binding: { revision: 5 } });
    const api = {
      orchestration: { dispatchCommand },
      provider: { getThreadBinding },
    } as unknown as NativeApi;
    const queuedTurn = makeQueuedTurn();
    const persistDispatchAdmission = vi.fn();

    await dispatchQueuedComposerTurn({
      api,
      threadId: ThreadId.makeUnsafe("thread-offscreen-queue"),
      queuedTurn,
      assistantDeliveryMode: "streaming",
      persistDispatchAdmission,
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        commandId: "composer-queue:queued-follow-up-1",
        threadId: "thread-offscreen-queue",
        dispatchMode: "queue",
        bindingRevision: 5,
        assistantDeliveryMode: "streaming",
        message: expect.objectContaining({
          messageId: "composer-queue:queued-follow-up-1",
          role: "user",
          text: "continue",
        }),
      }),
    );
    expect(getThreadBinding).toHaveBeenCalledWith({ threadId: "thread-offscreen-queue" });
    expect(persistDispatchAdmission).toHaveBeenCalledWith(0, 5);
  });

  it("shares an in-flight dispatch so queue actions can await server admission", async () => {
    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const api = {
      orchestration: { dispatchCommand },
      provider: {
        getThreadBinding: vi.fn().mockResolvedValue({ binding: { revision: 9 } }),
      },
    } as unknown as NativeApi;
    const threadId = ThreadId.makeUnsafe("thread-offscreen-queue-in-flight");
    const queuedTurn = makeQueuedTurn();
    const input = {
      api,
      threadId,
      queuedTurn,
      assistantDeliveryMode: "streaming" as const,
      persistDispatchAdmission: vi.fn(),
    };

    const first = dispatchQueuedComposerTurn(input);
    const second = dispatchQueuedComposerTurn(input);

    expect(second).toBe(first);
    expect(getQueuedComposerTurnDispatchInFlight(threadId, queuedTurn.id)).toBe(first);
    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));

    resolveDispatch({ sequence: 13 });
    await first;
    await Promise.resolve();

    expect(getQueuedComposerTurnDispatchInFlight(threadId, queuedTurn.id)).toBeUndefined();
  });

  it("replays a persisted admission attempt without resolving mutable binding state", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 14 });
    const getThreadBinding = vi.fn();
    const persistDispatchAdmission = vi.fn();
    const api = {
      orchestration: { dispatchCommand },
      provider: { getThreadBinding },
    } as unknown as NativeApi;
    const queuedTurn = {
      ...makeQueuedTurn(),
      dispatchAttempt: 2,
      dispatchBindingRevision: 12,
    };

    await dispatchQueuedComposerTurn({
      api,
      threadId: ThreadId.makeUnsafe("thread-offscreen-persisted-attempt"),
      queuedTurn,
      assistantDeliveryMode: "streaming",
      persistDispatchAdmission,
    });

    expect(getThreadBinding).not.toHaveBeenCalled();
    expect(persistDispatchAdmission).not.toHaveBeenCalled();
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "composer-queue:queued-follow-up-1:2",
        bindingRevision: 12,
      }),
    );
  });

  it("rotates command identity only for a new semantic binding attempt", () => {
    expect(queuedComposerTurnCommandId({ id: "queued-1" })).toBe("composer-queue:queued-1");
    expect(queuedComposerTurnCommandId({ id: "queued-1", dispatchAttempt: 1 })).toBe(
      "composer-queue:queued-1:1",
    );
    expect(isQueuedComposerBindingRevisionError({ code: "THREAD_BINDING_REVISION_STALE" })).toBe(
      true,
    );
    expect(isQueuedComposerBindingRevisionError({ code: "SOMETHING_ELSE" })).toBe(false);
  });
});
