import { describe, expect, it, vi } from "vitest";

const ipcMain = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain }));

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { registerDesktopVoiceTranscriptionHandler } from "./voiceTranscription";

describe("desktop voice transcription bridge", () => {
  it("registers only the native capability and Apple transcription boundaries", () => {
    registerDesktopVoiceTranscriptionHandler();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.voice.capabilities);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.voice.transcribeWithApple,
    );
    expect(ipcMain.handle).toHaveBeenCalledTimes(2);
  });
});
