// FILE: voiceTranscriptionAudio.test.ts
// Purpose: Verifies shared server/desktop WAV chunk validation without an audio-duration ceiling.

import type { ServerVoiceTranscriptionInput } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { decodeVoiceTranscriptionAudio } from "./voiceTranscriptionAudio";

const WAV_BASE64 = Buffer.from("RIFF0000WAVE", "ascii").toString("base64");

function request(
  overrides: Partial<ServerVoiceTranscriptionInput> = {},
): ServerVoiceTranscriptionInput {
  return {
    provider: "codex",
    cwd: "/tmp/project",
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 1_000,
    audioBase64: WAV_BASE64,
    ...overrides,
  };
}

describe("decodeVoiceTranscriptionAudio", () => {
  it("accepts duration metadata beyond the former 120-second ceiling", () => {
    expect(decodeVoiceTranscriptionAudio(request({ durationMs: 10 * 60_000 }))).toEqual(
      Buffer.from("RIFF0000WAVE", "ascii"),
    );
  });

  it("still rejects invalid transport chunks", () => {
    expect(() => decodeVoiceTranscriptionAudio(request({ durationMs: 0 }))).toThrow(
      /positive duration/u,
    );
    expect(() => decodeVoiceTranscriptionAudio(request({ sampleRateHz: 48_000 }))).toThrow(
      /24 kHz/u,
    );
    expect(() => decodeVoiceTranscriptionAudio(request({ audioBase64: "bm90LXdhdg==" }))).toThrow(
      /valid WAV/u,
    );
  });
});
