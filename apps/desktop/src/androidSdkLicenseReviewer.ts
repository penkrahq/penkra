// FILE: androidSdkLicenseReviewer.ts
// Purpose: Runs the official interactive Android SDK license review without auto-acceptance.
// Layer: Trusted desktop simulator infrastructure

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { spawnSimulatorSetupProcess, stopSimulatorSetupProcess } from "./simulatorRuntimeInstaller";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_PROMPT = /Review licenses that have not been accepted\s*\(y\/N\)\?\s*/i;
const LICENSE_PROMPT = /Accept\?\s*\(y\/N\):\s*/i;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface AndroidSdkLicensePrompt {
  text: string;
  ordinal: number;
}

export interface AndroidSdkLicenseReviewer {
  review(input: {
    executable: string;
    signal: AbortSignal;
    prompt(prompt: AndroidSdkLicensePrompt, signal: AbortSignal): Promise<boolean>;
  }): Promise<void>;
}

export class DefaultAndroidSdkLicenseReviewer implements AndroidSdkLicenseReviewer {
  readonly #spawn: (
    executable: string,
    args: ReadonlyArray<string>,
  ) => ChildProcessWithoutNullStreams;
  readonly #stop: (child: ChildProcessWithoutNullStreams) => Promise<void>;

  constructor(
    input: {
      spawn?: (executable: string, args: ReadonlyArray<string>) => ChildProcessWithoutNullStreams;
      stop?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
    } = {},
  ) {
    this.#spawn = input.spawn ?? spawnSimulatorSetupProcess;
    this.#stop = input.stop ?? stopSimulatorSetupProcess;
  }

  review(input: {
    executable: string;
    signal: AbortSignal;
    prompt(prompt: AndroidSdkLicensePrompt, signal: AbortSignal): Promise<boolean>;
  }): Promise<void> {
    if (!input.executable || input.executable.includes("\0")) {
      throw reviewError("INVALID_COMMAND", "Android SDK Manager executable is invalid.");
    }
    if (input.signal.aborted) {
      throw reviewError("SETUP_CANCELLED", "Runtime setup was cancelled.");
    }

    const child = this.#spawn(input.executable, ["--licenses"]);
    return new Promise((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let reviewedThrough = 0;
      let ordinal = 0;
      let reviewing = false;
      let settled = false;
      let stopping: Promise<void> | null = null;
      const promptController = new AbortController();

      const cleanup = () => {
        input.signal.removeEventListener("abort", abort);
        if (!promptController.signal.aborted) promptController.abort();
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const stopAndReject = async (error: Error) => {
        stopping ??= this.#stop(child);
        try {
          await stopping;
        } catch (stopError) {
          error = new AggregateError([error, stopError], "Android license review cleanup failed.");
          Object.assign(error, { code: "SETUP_CLEANUP_FAILED" });
        }
        finish(() => reject(error));
      };
      const abort = () => {
        void stopAndReject(reviewError("SETUP_CANCELLED", "Runtime setup was cancelled."));
      };
      const inspect = () => {
        if (settled || reviewing) return;
        const remainder = output.slice(reviewedThrough);
        const reviewMatch = REVIEW_PROMPT.exec(remainder);
        if (reviewMatch) {
          reviewedThrough += reviewMatch.index + reviewMatch[0].length;
          if (child.stdin.destroyed) {
            void stopAndReject(
              reviewError("LICENSE_REVIEW_FAILED", "Android SDK Manager stopped accepting input."),
            );
            return;
          }
          // This only asks sdkmanager to display the outstanding licenses. Each actual license
          // remains gated by the trusted per-license prompt below.
          child.stdin.write("y\n");
          return;
        }
        const match = LICENSE_PROMPT.exec(remainder);
        if (!match) return;
        const promptEnd = reviewedThrough + match.index + match[0].length;
        const text = stripTerminalControl(output.slice(reviewedThrough, promptEnd)).trim();
        reviewedThrough = promptEnd;
        reviewing = true;
        child.stdout.pause();
        child.stderr.pause();
        const currentOrdinal = ++ordinal;
        void input
          .prompt({ text, ordinal: currentOrdinal }, promptController.signal)
          .then(async (accepted) => {
            if (settled) return;
            if (input.signal.aborted) {
              await stopAndReject(reviewError("SETUP_CANCELLED", "Runtime setup was cancelled."));
              return;
            }
            if (!accepted) {
              if (!child.stdin.destroyed) child.stdin.write("n\n");
              await stopAndReject(reviewError("SETUP_CANCELLED", "Runtime setup was cancelled."));
              return;
            }
            if (child.stdin.destroyed) {
              await stopAndReject(
                reviewError(
                  "LICENSE_REVIEW_FAILED",
                  "Android SDK Manager stopped accepting input.",
                ),
              );
              return;
            }
            child.stdin.write("y\n");
            reviewing = false;
            child.stdout.resume();
            child.stderr.resume();
            inspect();
          })
          .catch((error) => {
            void stopAndReject(error instanceof Error ? error : new Error(String(error)));
          });
      };
      const collect = (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          void stopAndReject(
            reviewError(
              "OUTPUT_LIMIT_EXCEEDED",
              "Android SDK license output exceeded the trusted host limit.",
            ),
          );
          return;
        }
        output += chunk.toString("utf8");
        inspect();
      };

      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, signal) => {
        if (settled || stopping) return;
        if (exitCode !== 0) {
          const detail = stripTerminalControl(output).trim();
          finish(() =>
            reject(
              Object.assign(
                reviewError(
                  "LICENSE_REVIEW_FAILED",
                  detail || `Android SDK license review exited with code ${exitCode ?? "unknown"}.`,
                ),
                { exitCode, signal },
              ),
            ),
          );
          return;
        }
        finish(resolve);
      });
    });
  }
}

function stripTerminalControl(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/\r/g, "");
}

function reviewError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
