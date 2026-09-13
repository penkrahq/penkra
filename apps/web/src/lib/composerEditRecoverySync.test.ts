import { describe, expect, it, vi } from "vitest";

import type { DesktopComposerEditRecovery, ProviderKind, ThreadId } from "@penkra/contracts";
import type { QueuedComposerTurn } from "../composerDraftStore";
import { createComposerEditRecoverySync } from "./composerEditRecoverySync";

function queuedTurn(provider: ProviderKind = "codex"): QueuedComposerTurn {
  return {
    id: "queued-steer",
    kind: "chat",
    createdAt: "2026-09-12T19:00:00.000Z",
    serverAcceptedAt: "2026-09-12T19:00:01.000Z",
    previewText: "edit this steering message",
    prompt: "edit this steering message",
    images: [],
    files: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    selectedProvider: provider,
    selectedModel: "provider-model",
    selectedPromptEffort: "medium",
    modelSelection: { provider, model: "provider-model" },
    connectionId: null,
    runtimeMode: "full-access",
  };
}

function transportHarness() {
  let receive: ((recovery: DesktopComposerEditRecovery) => void) | undefined;
  const publish = vi.fn<(recovery: DesktopComposerEditRecovery) => void>();
  return {
    publish,
    emit: (recovery: DesktopComposerEditRecovery) => receive?.(recovery),
    transport: {
      publish,
      subscribe: (listener: (recovery: DesktopComposerEditRecovery) => void) => {
        receive = listener;
        return () => {
          receive = undefined;
        };
      },
    },
  };
}

describe("composer edit recovery window sync", () => {
  it.each(["codex", "claudeAgent", "opencode"] satisfies ProviderKind[])(
    "restores one %s queued-message edit in a second window exactly once",
    (provider) => {
      const harness = transportHarness();
      const recover = vi.fn(() => true);
      const sync = createComposerEditRecoverySync({
        transport: harness.transport,
        recover,
        createRecoveryId: () => "recovery-1",
      });
      const threadId = "thread-shared-by-two-windows" as ThreadId;
      const turn = queuedTurn(provider);

      expect(sync.publish(threadId, turn)).toBe(true);
      const recovery = harness.publish.mock.calls[0]?.[0];
      expect(recovery).toMatchObject({
        recoveryId: "recovery-1",
        threadId,
        queuedTurnId: turn.id,
      });

      harness.emit(recovery!);
      harness.emit(recovery!);

      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledWith(
        threadId,
        expect.objectContaining({
          id: turn.id,
          prompt: turn.prompt,
          selectedProvider: provider,
        }),
      );
      sync.dispose();
    },
  );

  it("rejects malformed and mismatched recovery deliveries", () => {
    const harness = transportHarness();
    const recover = vi.fn(() => true);
    const sync = createComposerEditRecoverySync({ transport: harness.transport, recover });
    const turn = queuedTurn();
    const threadId = "thread-two" as ThreadId;
    const validJson = JSON.stringify({ ...turn, images: [], files: [] });

    harness.emit({
      recoveryId: "bad-json",
      threadId,
      queuedTurnId: turn.id,
      queuedTurnJson: "{",
    });
    harness.emit({
      recoveryId: "wrong-turn",
      threadId,
      queuedTurnId: "different",
      queuedTurnJson: validJson,
    });

    expect(recover).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("preserves durable file and pasted-text metadata", () => {
    const harness = transportHarness();
    const recover = vi.fn(() => true);
    const sync = createComposerEditRecoverySync({
      transport: harness.transport,
      recover,
      createRecoveryId: () => "recovery-media",
    });
    const threadId = "thread-media" as ThreadId;
    const turn: QueuedComposerTurn = {
      ...queuedTurn(),
      files: [
        {
          type: "file",
          id: "file-one",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          assetKey: "asset-one",
          file: new File(["notes"], "notes.txt", { type: "text/plain" }),
        },
      ],
      pastedTexts: [
        {
          id: "paste-one",
          createdAt: "2026-09-12T19:00:00.000Z",
          text: "pasted context",
          lineCount: 1,
          charCount: 14,
        },
      ],
    };

    expect(sync.publish(threadId, turn)).toBe(true);
    harness.emit(harness.publish.mock.calls[0]![0]);

    expect(recover).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        files: [expect.objectContaining({ assetKey: "asset-one", name: "notes.txt" })],
        pastedTexts: [expect.objectContaining({ text: "pasted context" })],
      }),
    );
    sync.dispose();
  });

  it("does not publish a file recovery until the attachment has durable bytes", () => {
    const harness = transportHarness();
    const sync = createComposerEditRecoverySync({
      transport: harness.transport,
      recover: vi.fn(() => true),
      createRecoveryId: () => "recovery-not-durable",
    });
    const turn: QueuedComposerTurn = {
      ...queuedTurn(),
      files: [
        {
          type: "file",
          id: "file-pending",
          name: "pending.txt",
          mimeType: "text/plain",
          sizeBytes: 7,
          file: new File(["pending"], "pending.txt", { type: "text/plain" }),
        },
      ],
    };

    expect(sync.publish("thread-pending-file" as ThreadId, turn)).toBe(false);
    expect(harness.publish).not.toHaveBeenCalled();
    sync.dispose();
  });
});
