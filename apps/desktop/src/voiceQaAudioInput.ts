// FILE: voiceQaAudioInput.ts
// Purpose: Resolves an explicit on-demand WAV fixture used as Chromium's fake microphone.
// Layer: Desktop QA bootstrap utility

import * as FS from "node:fs";
import * as Path from "node:path";

export const PENKRA_VOICE_QA_WAV_ENV = "PENKRA_VOICE_QA_WAV";

export function resolveVoiceQaAudioInput(value: string | undefined): string | null {
  const requestedPath = value?.trim();
  if (!requestedPath) {
    return null;
  }

  const absolutePath = Path.resolve(requestedPath);
  if (Path.extname(absolutePath).toLocaleLowerCase() !== ".wav") {
    throw new Error(`${PENKRA_VOICE_QA_WAV_ENV} must point to a WAV file.`);
  }
  if (!FS.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${PENKRA_VOICE_QA_WAV_ENV} does not exist: ${absolutePath}`);
  }
  return `${absolutePath}%noloop`;
}
