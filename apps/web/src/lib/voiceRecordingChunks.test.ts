// FILE: voiceRecordingChunks.test.ts
// Purpose: Verifies sample-accurate rolling chunk boundaries, overlap, and WAV normalization.

import { describe, expect, it } from "vitest";

import {
  captureVoiceRecordingFromFloat32Bytes,
  encodeVoiceChunkWav,
  RollingVoiceChunker,
  VOICE_TARGET_SAMPLE_RATE_HZ,
} from "./voiceRecordingChunks";

function numberedSamples(length: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => index);
}

describe("RollingVoiceChunker", () => {
  it("covers arbitrarily sized input without gaps and repeats only the configured overlap", () => {
    const chunker = new RollingVoiceChunker(10, {
      chunkDurationSeconds: 4,
      overlapSeconds: 1,
    });
    const completed = [
      ...chunker.push(numberedSamples(17)),
      ...chunker.push(Float32Array.from({ length: 44 }, (_, index) => index + 17)),
      ...chunker.push(Float32Array.from({ length: 34 }, (_, index) => index + 61)),
    ];
    const finalChunk = chunker.finish();
    if (finalChunk) {
      completed.push(finalChunk);
    }

    expect(completed.map((chunk) => Array.from(chunk.samples))).toEqual([
      Array.from({ length: 40 }, (_, index) => index),
      Array.from({ length: 40 }, (_, index) => index + 30),
      Array.from({ length: 35 }, (_, index) => index + 60),
    ]);
    expect(chunker.totalDurationMs).toBe(9_500);
  });

  it("does not emit an overlap-only tail when recording stops on a boundary", () => {
    const chunker = new RollingVoiceChunker(10, {
      chunkDurationSeconds: 4,
      overlapSeconds: 1,
    });

    const completed = chunker.push(numberedSamples(70));

    expect(completed).toHaveLength(2);
    expect(chunker.finish()).toBeNull();
    expect(chunker.totalDurationMs).toBe(7_000);
  });

  it("encodes 24 kHz mono 16-bit PCM WAV data", () => {
    const wav = encodeVoiceChunkWav({
      samples: new Float32Array(48_000),
      sampleRateHz: 48_000,
      durationMs: 1_000,
    });
    const view = new DataView(wav);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(VOICE_TARGET_SAMPLE_RATE_HZ);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(VOICE_TARGET_SAMPLE_RATE_HZ * 2);
  });

  it("reconstructs an interrupted recording from only complete float samples", () => {
    const bytes = new Uint8Array(10 * 4 + 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 10; index += 1) {
      view.setFloat32(index * 4, index / 10, true);
    }
    bytes.set([255, 255], 40);

    const recovered = captureVoiceRecordingFromFloat32Bytes({
      bytes,
      sampleRateHz: 10,
      durableVoiceDraftId: "voice-recovered",
    });

    expect(recovered?.durationMs).toBe(1_000);
    expect(recovered?.durableVoiceDraftId).toBe("voice-recovered");
    expect(recovered?.chunks).toHaveLength(1);
  });
});
