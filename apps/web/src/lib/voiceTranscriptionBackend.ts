// FILE: voiceTranscriptionBackend.ts
// Purpose: Selects and freezes the best transcription backend available at recording start.
// Layer: Voice domain policy

import type { ProviderConnectionId, VoiceTranscriptionBackend } from "@penkra/contracts";

export function resolveVoiceTranscriptionBackend(input: {
  readonly appleSpeechLocale: string | null;
  readonly codexConnectionId: ProviderConnectionId | undefined;
}): VoiceTranscriptionBackend | null {
  if (input.codexConnectionId) {
    return { kind: "codex-chatgpt", connectionId: input.codexConnectionId };
  }
  if (input.appleSpeechLocale) {
    return { kind: "apple-speech", locale: input.appleSpeechLocale };
  }
  return null;
}
