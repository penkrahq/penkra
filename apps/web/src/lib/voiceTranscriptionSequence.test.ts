// FILE: voiceTranscriptionSequence.test.ts
// Purpose: Verifies ordered chunk transcription, retry isolation, cancellation, and overlap merging.

import { describe, expect, it, vi } from "vitest";

import type { VoiceRecordingChunkPayload, VoiceRecordingPayload } from "./voiceRecordingChunks";
import { mergeVoiceTranscripts, transcribeVoiceRecording } from "./voiceTranscriptionSequence";

function chunk(audioBase64: string): VoiceRecordingChunkPayload {
  return {
    audioBase64,
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 75_000,
  };
}

const RECORDING: VoiceRecordingPayload = {
  chunks: [chunk("one"), chunk("two"), chunk("three")],
  durationMs: 220_000,
};

describe("voice transcription sequencing", () => {
  it("transcribes chunks serially and removes normalized overlap", async () => {
    const inFlight: string[] = [];
    const transcribeChunk = vi.fn(async (input: VoiceRecordingChunkPayload) => {
      expect(inFlight).toEqual([]);
      inFlight.push(input.audioBase64);
      await Promise.resolve();
      inFlight.pop();
      return {
        text:
          input.audioBase64 === "one"
            ? "First sentence crosses the boundary."
            : input.audioBase64 === "two"
              ? "crosses the boundary, then continues."
              : "then continues. Final thought.",
      };
    });

    const transcript = await transcribeVoiceRecording({
      recording: RECORDING,
      transcribeChunk,
      isCurrent: () => true,
    });

    expect(transcribeChunk.mock.calls.map(([input]) => input.audioBase64)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(transcript).toBe("First sentence crosses the boundary. then continues. Final thought.");
  });

  it("retries only the failed chunk before continuing", async () => {
    const attempts = new Map<string, number>();
    const transcribeChunk = vi.fn(async (input: VoiceRecordingChunkPayload) => {
      const attempt = (attempts.get(input.audioBase64) ?? 0) + 1;
      attempts.set(input.audioBase64, attempt);
      if (input.audioBase64 === "two" && attempt === 1) {
        throw new Error("temporary failure");
      }
      return { text: input.audioBase64 };
    });

    await expect(
      transcribeVoiceRecording({
        recording: RECORDING,
        transcribeChunk,
        isCurrent: () => true,
      }),
    ).resolves.toBe("one two three");
    expect(transcribeChunk.mock.calls.map(([input]) => input.audioBase64)).toEqual([
      "one",
      "two",
      "two",
      "three",
    ]);
  });

  it("stops before sending another chunk after cancellation", async () => {
    let current = true;
    const transcribeChunk = vi.fn(async () => {
      current = false;
      return { text: "first" };
    });

    await expect(
      transcribeVoiceRecording({
        recording: RECORDING,
        transcribeChunk,
        isCurrent: () => current,
      }),
    ).resolves.toBeNull();
    expect(transcribeChunk).toHaveBeenCalledTimes(1);
  });
});

describe("mergeVoiceTranscripts", () => {
  it("preserves unrelated text and ignores empty provider results", () => {
    expect(mergeVoiceTranscripts(["Alpha ends.", "Different beginning.", "  "])).toBe(
      "Alpha ends. Different beginning.",
    );
  });

  it("deduplicates a single distinctive boundary word", () => {
    expect(
      mergeVoiceTranscripts([
        "The unusual marker is boundaryelephant.",
        "BoundaryElephant continues after the split.",
      ]),
    ).toBe("The unusual marker is boundaryelephant. continues after the split.");
  });

  it("recovers when the next transcription begins inside an overlapped word", () => {
    expect(
      mergeVoiceTranscripts([
        "He set off on an expedition to Oxford.",
        "ition to Oxford, to inquire for other varieties.",
      ]),
    ).toBe("He set off on an expedition to Oxford. to inquire for other varieties.");
  });

  it("removes provider continuation ellipses at chunk joins", () => {
    expect(
      mergeVoiceTranscripts([
        "It appeared, to the surprise...",
        "of every one, that all four agreed.",
        "They continued…",
        "without interruption.",
      ]),
    ).toBe(
      "It appeared, to the surprise of every one, that all four agreed. They continued without interruption.",
    );
  });
});
