// FILE: appRegistryPackageDownload.ts
// Purpose: Streams registry App archives to disk with progress-based timeout and diagnostics.
// Layer: Trusted Electron main process

import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REGISTRY_PACKAGE_DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

export interface RegistryPackageDownloadDiagnostic {
  event: "started" | "response" | "progress" | "completed" | "failed";
  appSlug: string;
  version: string;
  host: string;
  elapsedMs: number;
  expectedBytes: number;
  receivedBytes: number;
  status?: number;
  declaredBytes?: number | null;
  sha256?: string;
  error?: string;
}

export interface DownloadedRegistryPackage {
  archivePath: string;
  byteLength: number;
  sha256: string;
  dispose(): Promise<void>;
}

export function shouldReportRegistryPackageDownloadProgress(input: {
  receivedBytes: number;
  nextProgressBytes: number;
  now: number;
  lastDiagnosticAt: number;
}): boolean {
  return (
    input.receivedBytes >= input.nextProgressBytes || input.now - input.lastDiagnosticAt >= 5_000
  );
}

export async function downloadRegistryPackage(input: {
  fetch: typeof fetch;
  url: string;
  appSlug: string;
  version: string;
  expectedBytes: number;
  maximumBytes: number;
  stallTimeoutMs?: number;
  onDiagnostic?: (diagnostic: RegistryPackageDownloadDiagnostic) => void;
}): Promise<DownloadedRegistryPackage> {
  const startedAt = Date.now();
  const host = new URL(input.url).host;
  const stallTimeoutMs = input.stallTimeoutMs ?? REGISTRY_PACKAGE_DOWNLOAD_STALL_TIMEOUT_MS;
  const report = (
    event: RegistryPackageDownloadDiagnostic["event"],
    receivedBytes: number,
    details: Partial<RegistryPackageDownloadDiagnostic> = {},
  ): void => {
    input.onDiagnostic?.({
      event,
      appSlug: input.appSlug,
      version: input.version,
      host,
      elapsedMs: Date.now() - startedAt,
      expectedBytes: input.expectedBytes,
      receivedBytes,
      ...details,
    });
  };

  report("started", 0);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "penkra-app-download-"));
  const archivePath = join(temporaryRoot, "package.penkra");
  const controller = new AbortController();
  let stalled = false;
  const waitForNetwork = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            stalled = true;
            controller.abort();
            reject(new Error("Registry package download stalled."));
          }, stallTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let receivedBytes = 0;
  try {
    const response = await waitForNetwork(input.fetch(input.url, { signal: controller.signal }));
    if (!response.ok) throw new Error(`The registry package returned HTTP ${response.status}.`);
    if (!response.body) throw new Error("The registry package response has no body.");
    const contentLengthHeader = response.headers.get("content-length");
    const declaredBytes = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new Error("The registry package has an invalid Content-Length header.");
    }
    if (declaredBytes !== null && declaredBytes > input.maximumBytes) {
      throw new Error("The registry package exceeds the archive size limit.");
    }
    if (declaredBytes !== null && declaredBytes !== input.expectedBytes) {
      throw new Error("The registry package Content-Length does not match its release metadata.");
    }
    report("response", 0, { status: response.status, declaredBytes });

    const file = await open(archivePath, "wx", 0o600);
    const digest = createHash("sha256");
    const reader = response.body.getReader();
    let nextProgressBytes = 16 * 1024 * 1024;
    let lastProgressAt = Date.now();
    let lastDiagnosticAt = lastProgressAt;
    let bodyCompleted = false;
    const readWithProgressDeadline = async (): ReturnType<typeof reader.read> => {
      const remainingMs = lastProgressAt + stallTimeoutMs - Date.now();
      if (remainingMs <= 0) {
        stalled = true;
        controller.abort();
        throw new Error("Registry package download stalled.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              stalled = true;
              controller.abort();
              reject(new Error("Registry package download stalled."));
            }, remainingMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      while (true) {
        const chunk = await readWithProgressDeadline();
        if (chunk.done) {
          bodyCompleted = true;
          break;
        }
        if (chunk.value.byteLength === 0) continue;
        receivedBytes += chunk.value.byteLength;
        const now = Date.now();
        lastProgressAt = now;
        if (receivedBytes > input.maximumBytes || receivedBytes > input.expectedBytes) {
          await reader.cancel();
          throw new Error("The registry package exceeds its declared size.");
        }
        digest.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await file.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          if (bytesWritten === 0) throw new Error("The registry package could not be written.");
          offset += bytesWritten;
        }
        if (
          shouldReportRegistryPackageDownloadProgress({
            receivedBytes,
            nextProgressBytes,
            now,
            lastDiagnosticAt,
          })
        ) {
          report("progress", receivedBytes);
          nextProgressBytes = receivedBytes + 16 * 1024 * 1024;
          lastDiagnosticAt = now;
        }
      }
    } finally {
      if (!bodyCompleted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await file.close();
    }
    if (receivedBytes !== input.expectedBytes) {
      throw new Error("The registry package ended before its declared size was received.");
    }
    const sha256 = digest.digest("hex");
    report("completed", receivedBytes, { sha256 });
    return {
      archivePath,
      byteLength: receivedBytes,
      sha256,
      dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    const cause = stalled
      ? new Error(
          `App package download stalled for ${Math.max(1, Math.round(stallTimeoutMs / 1_000))} seconds after ${receivedBytes} of ${input.expectedBytes} bytes.`,
        )
      : error instanceof Error
        ? error
        : new Error(String(error));
    report("failed", receivedBytes, { error: cause.message });
    await rm(temporaryRoot, { recursive: true, force: true });
    throw cause;
  }
}
