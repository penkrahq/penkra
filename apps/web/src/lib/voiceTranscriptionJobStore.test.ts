// FILE: voiceTranscriptionJobStore.test.ts
// Purpose: Verifies desktop voice journal reconciliation before transcription.

import { ThreadId } from "@penkra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listVoiceTranscriptionJobs } from "./voiceTranscriptionJobStore";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("voice transcription job storage", () => {
  it("promotes interrupted audio to ready and discards empty journals", async () => {
    const audioBytes = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
    const completeVoice = vi.fn().mockResolvedValue(undefined);
    const deleteVoice = vi.fn().mockResolvedValue(undefined);
    const readVoice = vi.fn(async (id: string) => (id === "audio-job" ? audioBytes : null));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          composerDrafts: {
            listVoices: vi.fn().mockResolvedValue([
              {
                id: "audio-job",
                threadId: "thread-a",
                cwd: "/workspace",
                sampleRateHz: 48_000,
                state: "recording",
                committedBytes: audioBytes.byteLength,
                lastSequence: 0,
                createdAt: "2026-08-13T00:00:00.000Z",
                updatedAt: "2026-08-13T00:00:00.000Z",
              },
              {
                id: "empty-job",
                threadId: "thread-a",
                cwd: "/workspace",
                sampleRateHz: 48_000,
                state: "recording",
                committedBytes: 0,
                lastSequence: -1,
                createdAt: "2026-08-13T00:00:00.000Z",
                updatedAt: "2026-08-13T00:00:00.000Z",
              },
            ]),
            completeVoice,
            deleteVoice,
            readVoice,
          },
        },
      },
    });

    await expect(listVoiceTranscriptionJobs()).resolves.toEqual([
      expect.objectContaining({ id: "audio-job", threadId: ThreadId.makeUnsafe("thread-a") }),
    ]);
    expect(completeVoice).toHaveBeenCalledWith("audio-job");
    expect(deleteVoice).toHaveBeenCalledWith("empty-job");
    expect(readVoice).toHaveBeenCalledTimes(1);
  });
});
