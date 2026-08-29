import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMain = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain }));

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { registerDesktopVoiceTranscriptionHandler } from "./voiceTranscription";

describe("desktop voice transcription bridge", () => {
  beforeEach(() => {
    ipcMain.handle.mockClear();
    ipcMain.removeHandler.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers native and server transcription boundaries", () => {
    registerDesktopVoiceTranscriptionHandler({ getBackendWsUrl: () => null });

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.voice.capabilities);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.voice.transcribeWithApple,
    );
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.voice.transcribeWithServer,
    );
    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
  });

  it("uploads server transcription bytes through the authenticated desktop backend URL", async () => {
    const wavBytes = Buffer.from("RIFF0000WAVE", "ascii");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: "desktop transcript" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    registerDesktopVoiceTranscriptionHandler({
      getBackendWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret",
    });
    const registration = ipcMain.handle.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.voice.transcribeWithServer,
    );
    const handler = registration?.[1];
    expect(handler).toBeTypeOf("function");

    const result = await handler?.(
      {},
      {
        provider: "codex",
        connectionId: "connection-codex",
        cwd: "/repo",
        threadId: "thread-1",
        audioBase64: wavBytes.toString("base64"),
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1_000,
      },
    );

    expect(result).toEqual({ text: "desktop transcript" });
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/voice/transcribe?");
    expect(String(url)).toContain("token=desktop-secret");
    expect(String(url)).toContain("threadId=thread-1");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBytes,
    });
  });
});
