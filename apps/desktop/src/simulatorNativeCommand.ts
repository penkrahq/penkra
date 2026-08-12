// FILE: simulatorNativeCommand.ts
// Purpose: Runs bounded native simulator tooling without a shell or ambient output streams.
// Layer: Trusted desktop platform boundary

import ChildProcess from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SimulatorNativeCommandInput {
  executable: string;
  args: ReadonlyArray<string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface SimulatorNativeCommandResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface SimulatorNativeCommandRunner {
  run(input: SimulatorNativeCommandInput): Promise<SimulatorNativeCommandResult>;
}

export class NativeSimulatorCommandError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(input: {
    code: string;
    message: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
  }) {
    super(input.message);
    this.name = "NativeSimulatorCommandError";
    this.code = input.code;
    this.exitCode = input.exitCode ?? null;
    this.signal = input.signal ?? null;
    this.stderr = input.stderr ?? "";
  }
}

export class DefaultSimulatorNativeCommandRunner implements SimulatorNativeCommandRunner {
  run(input: SimulatorNativeCommandInput): Promise<SimulatorNativeCommandResult> {
    const timeoutMs = boundedPositiveInteger(
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Simulator command timeout",
      10 * 60_000,
    );
    const maxOutputBytes = boundedPositiveInteger(
      input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Simulator command output limit",
      64 * 1024 * 1024,
    );
    if (!input.executable || input.executable.includes("\0")) {
      throw new NativeSimulatorCommandError({
        code: "INVALID_COMMAND",
        message: "Simulator executable is invalid.",
      });
    }
    if (input.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      throw new NativeSimulatorCommandError({
        code: "INVALID_COMMAND",
        message: "Simulator command arguments are invalid.",
      });
    }

    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(abortedError());
        return;
      }
      const child = ChildProcess.spawn(input.executable, [...input.args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        callback();
      };
      const fail = (error: Error) => finish(() => reject(error));
      const abort = () => {
        child.kill();
        fail(abortedError());
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          child.kill();
          fail(
            new NativeSimulatorCommandError({
              code: "OUTPUT_LIMIT_EXCEEDED",
              message: `Simulator command output exceeded ${maxOutputBytes} bytes.`,
            }),
          );
          return;
        }
        target.push(Buffer.from(chunk));
      };
      const timer = setTimeout(() => {
        child.kill();
        fail(
          new NativeSimulatorCommandError({
            code: "COMMAND_TIMEOUT",
            message: `Simulator command exceeded ${timeoutMs}ms.`,
          }),
        );
      }, timeoutMs);
      timer.unref();

      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => fail(error));
      child.once("close", (exitCode, signal) => {
        const stderrBytes = Buffer.concat(stderr);
        if (exitCode !== 0) {
          fail(
            new NativeSimulatorCommandError({
              code: "COMMAND_FAILED",
              message: `Simulator command failed with exit code ${exitCode ?? "unknown"}.`,
              exitCode,
              signal,
              stderr: stderrBytes.toString("utf8"),
            }),
          );
          return;
        }
        finish(() =>
          resolve({ stdout: Buffer.concat(stdout), stderr: new Uint8Array(stderrBytes) }),
        );
      });
      if (input.stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(input.stdin);
      }
    });
  }
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new NativeSimulatorCommandError({
      code: "INVALID_COMMAND",
      message: `${label} must be between 1 and ${maximum}.`,
    });
  }
  return value;
}

function abortedError(): NativeSimulatorCommandError {
  return new NativeSimulatorCommandError({
    code: "COMMAND_ABORTED",
    message: "Simulator command was cancelled.",
  });
}
