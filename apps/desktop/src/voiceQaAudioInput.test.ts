// FILE: voiceQaAudioInput.test.ts
// Purpose: Verifies the explicit fake-microphone fixture gate used by desktop QA.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveVoiceQaAudioInput } from "./voiceQaAudioInput";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { force: true, recursive: true });
  }
});

describe("resolveVoiceQaAudioInput", () => {
  it("stays disabled without an explicit fixture", () => {
    expect(resolveVoiceQaAudioInput(undefined)).toBeNull();
    expect(resolveVoiceQaAudioInput("  ")).toBeNull();
  });

  it("requires an existing WAV and disables Chromium looping", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-voice-qa-"));
    temporaryDirectories.push(directory);
    const fixturePath = Path.join(directory, "fixture.wav");
    FS.writeFileSync(fixturePath, "fixture");

    expect(resolveVoiceQaAudioInput(fixturePath)).toBe(`${fixturePath}%noloop`);
    expect(() => resolveVoiceQaAudioInput(Path.join(directory, "missing.wav"))).toThrow(
      /does not exist/u,
    );
    expect(() => resolveVoiceQaAudioInput(Path.join(directory, "fixture.mp3"))).toThrow(
      /WAV file/u,
    );
  });
});
