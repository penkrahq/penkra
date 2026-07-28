// FILE: voiceTranscriptionAudio.ts
// Purpose: Validates and decodes one bounded WAV transport chunk for voice transcription.
// Layer: Shared Node/Electron runtime utility

import { Buffer } from "node:buffer";

import {
  SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type ServerVoiceTranscriptionInput,
} from "@synara/contracts";

export function decodeVoiceTranscriptionAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice transcription chunks must include a positive duration.");
  }

  const normalizedBase64 = normalizeBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("A voice transcription chunk exceeds the 10 MB transport limit.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

function normalizeBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}
