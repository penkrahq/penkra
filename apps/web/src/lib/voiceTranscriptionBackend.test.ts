import { ProviderConnectionId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { resolveVoiceTranscriptionBackend } from "./voiceTranscriptionBackend";

describe("resolveVoiceTranscriptionBackend", () => {
  const codexConnectionId = ProviderConnectionId.makeUnsafe("connection-codex");

  it("prefers Codex over supported Apple speech", () => {
    expect(
      resolveVoiceTranscriptionBackend({
        appleSpeechLocale: "en-US",
        codexConnectionId,
      }),
    ).toEqual({ kind: "codex-chatgpt", connectionId: codexConnectionId });
  });

  it("uses Codex when native speech is unavailable", () => {
    expect(
      resolveVoiceTranscriptionBackend({
        appleSpeechLocale: null,
        codexConnectionId,
      }),
    ).toEqual({ kind: "codex-chatgpt", connectionId: codexConnectionId });
  });

  it("uses Apple speech when Codex is unavailable", () => {
    expect(
      resolveVoiceTranscriptionBackend({
        appleSpeechLocale: "en-US",
        codexConnectionId: undefined,
      }),
    ).toEqual({ kind: "apple-speech", locale: "en-US" });
  });

  it("returns no backend when neither option is available", () => {
    expect(
      resolveVoiceTranscriptionBackend({
        appleSpeechLocale: null,
        codexConnectionId: undefined,
      }),
    ).toBeNull();
  });
});
