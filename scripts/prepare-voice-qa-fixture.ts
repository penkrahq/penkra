// FILE: prepare-voice-qa-fixture.ts
// Purpose: Verifies and converts the retained public-domain voice QA source into fake-mic WAV.
// Layer: On-demand QA tooling

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as ChildProcess from "node:child_process";

const REPOSITORY_ROOT = Path.resolve(import.meta.dirname, "..");
const SOURCE_PATH = Path.join(
  REPOSITORY_ROOT,
  "qa",
  "voice",
  "fixtures",
  "headlong-hall-chapter-1.mp3",
);
const EXPECTED_SOURCE_SHA256 = "ce64f3ab23bf435ca97a22c8ad9565603c1890cf950b92a3a426c9df0c0f3e54";
const PENKRA_VOICE_QA_WAV_ENV = "PENKRA_VOICE_QA_WAV";
const OUTPUT_DIRECTORY = Path.join(REPOSITORY_ROOT, ".qa-artifacts", "voice");
const OUTPUT_PATH = Path.join(OUTPUT_DIRECTORY, "headlong-hall-chapter-1-24khz-mono.wav");

function sha256(path: string): string {
  const digest = Crypto.createHash("sha256");
  digest.update(FS.readFileSync(path));
  return digest.digest("hex");
}

function requireSuccessfulCommand(command: string, args: readonly string[]): void {
  const result = ChildProcess.spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${command} is required for voice QA: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status ?? "unknown"}: ${result.stderr.trim()}`,
    );
  }
}

const sourceDigest = sha256(SOURCE_PATH);
if (sourceDigest !== EXPECTED_SOURCE_SHA256) {
  throw new Error(
    `Voice QA source checksum mismatch. Expected ${EXPECTED_SOURCE_SHA256}, received ${sourceDigest}.`,
  );
}

FS.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
requireSuccessfulCommand("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  SOURCE_PATH,
  "-vn",
  "-ac",
  "1",
  "-ar",
  "24000",
  "-c:a",
  "pcm_s16le",
  OUTPUT_PATH,
]);
requireSuccessfulCommand("ffprobe", [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=codec_name,channels,sample_rate:format=duration",
  "-of",
  "json",
  OUTPUT_PATH,
]);

process.stdout.write(
  `${JSON.stringify(
    {
      source: Path.relative(REPOSITORY_ROOT, SOURCE_PATH),
      sourceSha256: sourceDigest,
      wav: OUTPUT_PATH,
      launch: `${PENKRA_VOICE_QA_WAV_ENV}=${JSON.stringify(OUTPUT_PATH)} bun run electron:dev`,
    },
    null,
    2,
  )}\n`,
);
