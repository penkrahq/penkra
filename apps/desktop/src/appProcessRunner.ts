// FILE: appProcessRunner.ts
// Purpose: Runs one user-selected executable without shell interpolation or ambient credentials.
// Layer: Trusted desktop App runtime

import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";

const MAX_IO_BYTES = 10 * 1024 * 1024;

export interface AppProcessRunRequest {
  executablePath: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AppProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export async function runAppProcess(input: AppProcessRunRequest): Promise<AppProcessRunResult> {
  await FS.access(
    input.executablePath,
    process.platform === "win32" ? FS.constants.F_OK : FS.constants.X_OK,
  );
  const args = input.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 8_192 || arg.includes("\0"))
  ) {
    throw new Error("Process arguments are invalid.");
  }
  const stdin =
    input.stdin === undefined
      ? null
      : typeof input.stdin === "string"
        ? Buffer.from(input.stdin)
        : Buffer.from(input.stdin);
  if (stdin && stdin.byteLength > MAX_IO_BYTES) throw new Error("Process stdin exceeds 10 MiB.");
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 1), 60_000);

  return new Promise((resolve, reject) => {
    const child = spawn(input.executablePath, [...args], {
      cwd: input.cwd,
      env: minimalEnvironment(),
      shell: false,
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const abort = () => child.kill("SIGKILL");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const finish = (error?: Error, result?: AppProcessRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_IO_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Process output exceeds 10 MiB."));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("exit", (exitCode, signal) => {
      if (input.signal?.aborted) return finish(new Error("Process run was cancelled."));
      if (Date.now() >= startedAt + timeoutMs && signal === "SIGKILL")
        return finish(new Error("Process run timed out."));
      finish(undefined, {
        exitCode,
        signal,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr)),
      });
    });
    const startedAt = Date.now();
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR ?? OS.tmpdir(),
    SYSTEMROOT: process.platform === "win32" ? process.env.SYSTEMROOT : undefined,
  };
}
