// FILE: voiceTranscription.ts
// Purpose: Validates Remodex-style WAV payloads and proxies them to ChatGPT transcription.
// Layer: Server utility
// Exports: transcribeVoiceWithChatGptSession
// Depends on: ChatGPT session auth supplied by Codex app-server callers.

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@penkra/contracts";
import { requestChatGptVoiceTranscription } from "@penkra/shared/chatGptVoiceTranscription";
import { decodeOutboundJson, type OutboundHttpResponse } from "@penkra/shared/outboundHttp";
import { decodeVoiceTranscriptionAudio } from "@penkra/shared/voiceTranscriptionAudio";

import { createLogger } from "./logger";

const log = createLogger("voice-transcription");

export interface ChatGptVoiceAuthContext {
  readonly token: string;
  readonly transcriptionUrl?: string;
}

// Validate the captured WAV clip and retry once if the ChatGPT session needs a refresh.
export async function transcribeVoiceWithChatGptSession(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly resolveAuth: (refreshToken: boolean) => Promise<ChatGptVoiceAuthContext>;
  readonly signal?: AbortSignal;
}): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeVoiceTranscriptionAudio(input.request);
  log.info("voice audio decoded", {
    audioBytes: audioBuffer.byteLength,
    durationMs: input.request.durationMs,
    sampleRateHz: input.request.sampleRateHz,
    mimeType: input.request.mimeType,
  });
  let auth = await input.resolveAuth(false);
  log.info("voice auth resolved", { refreshToken: false });
  let response: OutboundHttpResponse;
  try {
    response = await requestTranscription({
      audioBuffer,
      mimeType: input.request.mimeType,
      token: auth.token,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
    });
  } catch (error) {
    log.error("voice transcription request failed before response", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  log.info("voice transcription response received", { status: response.status, attempt: 1 });

  if (response.status === 401 || response.status === 403) {
    auth = await input.resolveAuth(true);
    log.info("voice auth resolved", { refreshToken: true });
    response = await requestTranscription({
      audioBuffer,
      mimeType: input.request.mimeType,
      token: auth.token,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
    });
    log.info("voice transcription response received", { status: response.status, attempt: 2 });
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(readTranscriptionErrorMessage(response));
  }

  let payload: { text?: unknown; transcript?: unknown } | null = null;
  try {
    payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      text?: unknown;
      transcript?: unknown;
    };
  } catch {
    payload = null;
  }
  const text = readString(payload?.text) ?? readString(payload?.transcript);
  log.info("voice transcript decoded", { textLength: text?.length ?? 0 });
  return { text: text ?? "" };
}

async function requestTranscription(input: {
  readonly audioBuffer: Uint8Array;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<OutboundHttpResponse> {
  return requestChatGptVoiceTranscription({
    audio: input.audioBuffer,
    mimeType: input.mimeType,
    token: input.token,
    ...(input.transcriptionUrl ? { transcriptionUrl: input.transcriptionUrl } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function readTranscriptionErrorMessage(response: OutboundHttpResponse): string {
  let errorMessage = `Transcription failed with status ${response.status}.`;
  try {
    const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      error?: { message?: unknown };
      message?: unknown;
    } | null;
    const providerMessage =
      readString(payload?.error?.message) ?? readString(payload?.message) ?? null;
    if (providerMessage) {
      errorMessage = providerMessage;
    }
  } catch {
    // Keep the generic status-based message when the provider body is empty or invalid.
  }

  if (response.status === 401 || response.status === 403) {
    return "Your ChatGPT Connection is unavailable.";
  }

  return errorMessage;
}

function readString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}
