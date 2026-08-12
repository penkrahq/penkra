import { ThreadId, type NativeApi } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import type { QueuedComposerChatTurn } from "../composerDraftDomain";
import {
  dispatchQueuedComposerTurn,
  getQueuedComposerTurnDispatchInFlight,
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
    envMode: "local",
  };
}

describe("dispatchQueuedComposerTurn", () => {
  it("uses stable ids and the server queue command so retries are idempotent", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 12 });
    const api = {
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
    const queuedTurn = makeQueuedTurn();

    await dispatchQueuedComposerTurn({
      api,
      threadId: ThreadId.makeUnsafe("thread-offscreen-queue"),
      queuedTurn,
      assistantDeliveryMode: "streaming",
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        commandId: "composer-queue:queued-follow-up-1",
        threadId: "thread-offscreen-queue",
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
        message: expect.objectContaining({
          messageId: "composer-queue:queued-follow-up-1",
          role: "user",
          text: "continue",
        }),
      }),
    );
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
    } as unknown as NativeApi;
    const threadId = ThreadId.makeUnsafe("thread-offscreen-queue-in-flight");
    const queuedTurn = makeQueuedTurn();
    const input = {
      api,
      threadId,
      queuedTurn,
      assistantDeliveryMode: "streaming" as const,
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
});
