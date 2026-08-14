// FILE: voiceTranscription.ts
// Purpose: Exposes supported OS-native transcription backends to the desktop renderer.
// Layer: Desktop native helper bridge

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ipcMain } from "electron";
import type {
  DesktopAppleVoiceTranscriptionInput,
  DesktopVoiceTranscriptionCapabilities,
  ServerVoiceTranscriptionResult,
} from "@penkra/contracts";
import { decodeVoiceTranscriptionAudio } from "@penkra/shared/voiceTranscriptionAudio";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const HELPER_FILE_NAME = "penkra-speech-transcriber";
const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;
const CAPABILITY_TIMEOUT_MS = 15_000;
const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000;

interface SpeechHelperCapabilities {
  readonly appleSpeech?: { readonly locale?: unknown } | null;
}

interface SpeechHelperTranscription {
  readonly text?: unknown;
}

let cachedCapabilities: Promise<DesktopVoiceTranscriptionCapabilities> | null = null;

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function resolveSpeechHelperPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidates = [
    Path.join(__dirname, "../resources/native", HELPER_FILE_NAME),
    Path.join(__dirname, "../prod-resources/native", HELPER_FILE_NAME),
    Path.join(process.resourcesPath, "native", HELPER_FILE_NAME),
  ];
  return candidates.find((candidate) => FS.existsSync(candidate)) ?? null;
}

function runSpeechHelper(
  helperPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(helperPath, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const appendBounded = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("Apple transcription returned too much data.")));
        return current;
      }
      return next;
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Apple on-device transcription timed out.")));
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const helperError = parseHelperError(stderr);
          reject(
            new Error(
              helperError ??
                `Apple transcription helper exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new Error("Apple transcription returned an invalid response."));
        }
      });
    });
  });
}

function parseHelperError(stderr: string): string | null {
  try {
    const payload = JSON.parse(stderr) as { error?: unknown };
    return readNonEmptyString(payload.error);
  } catch {
    return readNonEmptyString(stderr);
  }
}

async function readDesktopVoiceCapabilities(): Promise<DesktopVoiceTranscriptionCapabilities> {
  const helperPath = resolveSpeechHelperPath();
  if (!helperPath) return { appleSpeech: null };
  try {
    const payload = (await runSpeechHelper(
      helperPath,
      ["capabilities"],
      CAPABILITY_TIMEOUT_MS,
    )) as SpeechHelperCapabilities;
    const locale = readNonEmptyString(payload.appleSpeech?.locale);
    return { appleSpeech: locale ? { locale } : null };
  } catch (error) {
    console.warn("[voice-transcription] Apple capability discovery failed.", error);
    return { appleSpeech: null };
  }
}

async function transcribeVoiceWithApple(
  input: DesktopAppleVoiceTranscriptionInput,
): Promise<ServerVoiceTranscriptionResult> {
  const helperPath = resolveSpeechHelperPath();
  if (!helperPath) throw new Error("Apple on-device transcription is unavailable on this Mac.");
  const locale = readNonEmptyString(input.locale);
  if (!locale) throw new Error("Apple on-device transcription requires a locale.");
  const audioBuffer = decodeVoiceTranscriptionAudio(input);
  const temporaryDirectory = await FS.promises.mkdtemp(
    Path.join(OS.tmpdir(), "penkra-voice-transcription-"),
  );
  const audioPath = Path.join(temporaryDirectory, "recording.wav");
  try {
    await FS.promises.writeFile(audioPath, audioBuffer, { mode: 0o600 });
    const payload = (await runSpeechHelper(
      helperPath,
      ["transcribe", audioPath, locale],
      TRANSCRIPTION_TIMEOUT_MS,
    )) as SpeechHelperTranscription;
    const text = readNonEmptyString(payload.text);
    return { text: text ?? "" };
  } finally {
    await FS.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function registerDesktopVoiceTranscriptionHandler(): void {
  ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.voice.capabilities);
  ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.voice.transcribeWithApple);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.voice.capabilities, () => {
    cachedCapabilities ??= readDesktopVoiceCapabilities();
    return cachedCapabilities;
  });
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.voice.transcribeWithApple,
    (_event, input: DesktopAppleVoiceTranscriptionInput) => transcribeVoiceWithApple(input),
  );
}
