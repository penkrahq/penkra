import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderKind } from "@penkra/contracts";
import { createLogger } from "../logger.ts";

const STDERR_TAIL_BYTES = 4096; // P15: one bounded 4 KB tail per provider process.
const exec = promisify(execFile);
const log = createLogger("provider-process");

export function redactProviderProcessOutput(value: string): string {
  return value
    .replace(
      /((?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:sk|sess|eyJ)[A-Za-z0-9._-]{16,}\b/g, "[redacted]");
}

async function readRss(pid: number): Promise<number> {
  const windows = process.platform === "win32";
  const { stdout } = windows
    ? await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
      ])
    : await exec("ps", ["-p", String(pid), "-o", "rss="]);
  const value = Number(stdout.trim());
  if (!stdout.trim() || !Number.isFinite(value) || value < 0)
    throw new Error("Process RSS was unavailable.");
  return value * (windows ? 1 : 1024);
}

export function makeProviderProcessDiagnostics(input: {
  provider: ProviderKind;
  pid: number | undefined;
  context?: () => Readonly<Record<string, unknown>>;
  readMemory?: (pid: number) => Promise<number>;
  write?: (event: Readonly<Record<string, unknown>>) => void;
}) {
  const started = performance.now();
  let tail = Buffer.alloc(0);
  let lastRssBytes: number | null = null;
  let lastRssAt: number | null = null;
  let memoryError: string | null = null;
  let memoryRead: Promise<void> | undefined;
  let endedAt: number | null = null;
  const write = input.write ?? ((event) => log.info("provider.process.lifecycle", event));
  return {
    appendStderr(chunk: Buffer | string) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tail =
        bytes.length >= STDERR_TAIL_BYTES
          ? Buffer.from(bytes.subarray(-STDERR_TAIL_BYTES))
          : Buffer.from(Buffer.concat([tail, bytes]).subarray(-STDERR_TAIL_BYTES));
    },
    // Sample on lifecycle/turn events, never on a timer or on every streamed delta.
    sampleMemory(): Promise<void> {
      if (memoryRead) return memoryRead;
      if (endedAt !== null || input.pid === undefined) return Promise.resolve();
      memoryRead = Promise.resolve()
        .then(() => (input.readMemory ?? readRss)(input.pid!))
        .then(
          (bytes) => {
            if (endedAt !== null) return;
            lastRssBytes = bytes;
            lastRssAt = performance.now();
            memoryError = null;
          },
          (cause) => {
            memoryError = cause instanceof Error ? cause.message : String(cause);
          },
        )
        .finally(() => {
          memoryRead = undefined;
        });
      return memoryRead;
    },
    recordExit(code: number | null, signal: string | null, phase: "exit" | "closed" = "exit") {
      endedAt ??= performance.now();
      write({
        provider: input.provider,
        pid: input.pid ?? null,
        phase,
        code,
        signal,
        uptimeMs: endedAt - started,
        lastRssBytes,
        rssSampleAgeMs: lastRssAt === null ? null : endedAt - lastRssAt,
        memoryError,
        stderr: redactProviderProcessOutput(tail.toString()),
        ...input.context?.(),
      });
    },
  };
}

export type ProviderProcessDiagnostics = ReturnType<typeof makeProviderProcessDiagnostics>;

export function observeProviderProcess(
  child: ChildProcess,
  input: Omit<Parameters<typeof makeProviderProcessDiagnostics>[0], "pid">,
): ProviderProcessDiagnostics {
  const diagnostics = makeProviderProcessDiagnostics({ ...input, pid: child.pid });
  const append = (chunk: Buffer) => diagnostics.appendStderr(chunk);
  child.stderr?.on("data", append);
  child.once("exit", (code, signal) => diagnostics.recordExit(code, signal));
  child.once("close", (code, signal) => {
    diagnostics.recordExit(code, signal, "closed");
    child.stderr?.off("data", append);
  });
  void diagnostics.sampleMemory();
  return diagnostics;
}
