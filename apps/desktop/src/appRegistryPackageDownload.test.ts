import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  downloadRegistryPackage,
  shouldReportRegistryPackageDownloadProgress,
  type RegistryPackageDownloadDiagnostic,
} from "./appRegistryPackageDownload";

describe("registry App package download", () => {
  it("allows a transfer to exceed the timeout duration while bytes keep arriving", async () => {
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (chunk === 4) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(++chunk));
      },
    });
    const diagnostics: RegistryPackageDownloadDiagnostic[] = [];
    const downloaded = await downloadRegistryPackage({
      fetch: vi.fn().mockResolvedValue(new Response(body, { headers: { "content-length": "4" } })),
      url: "https://downloads.example.test/canvas.penkra",
      appSlug: "canvas",
      version: "1.0.0",
      expectedBytes: 4,
      maximumBytes: 100,
      stallTimeoutMs: 30,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      await expect(readFile(downloaded.archivePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
      expect(diagnostics.map((diagnostic) => diagnostic.event)).toEqual([
        "started",
        "response",
        "completed",
      ]);
      expect(diagnostics.at(-1)).toMatchObject({ receivedBytes: 4, expectedBytes: 4 });
    } finally {
      await downloaded.dispose();
    }
  });

  it("reports progress by elapsed time even below the byte interval", () => {
    expect(
      shouldReportRegistryPackageDownloadProgress({
        receivedBytes: 1,
        nextProgressBytes: 16 * 1024 * 1024,
        now: 7_000,
        lastDiagnosticAt: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldReportRegistryPackageDownloadProgress({
        receivedBytes: 1,
        nextProgressBytes: 16 * 1024 * 1024,
        now: 4_000,
        lastDiagnosticAt: 1_000,
      }),
    ).toBe(false);
  });

  it("reports the stage and byte counts when network progress stalls", async () => {
    const diagnostics: RegistryPackageDownloadDiagnostic[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
    });
    await expect(
      downloadRegistryPackage({
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(body, { headers: { "content-length": "10" } })),
        url: "https://downloads.example.test/canvas.penkra",
        appSlug: "canvas",
        version: "1.0.0",
        expectedBytes: 10,
        maximumBytes: 100,
        stallTimeoutMs: 20,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).rejects.toThrow("stalled for 1 seconds after 0 of 10 bytes");
    expect(diagnostics.at(-1)).toMatchObject({
      event: "failed",
      appSlug: "canvas",
      version: "1.0.0",
      host: "downloads.example.test",
      expectedBytes: 10,
      receivedBytes: 0,
    });
  });

  it("does not treat empty stream chunks as download progress", async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.enqueue(new Uint8Array());
      },
    });
    await expect(
      downloadRegistryPackage({
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(body, { headers: { "content-length": "1" } })),
        url: "https://downloads.example.test/canvas.penkra",
        appSlug: "canvas",
        version: "1.0.0",
        expectedBytes: 1,
        maximumBytes: 100,
        stallTimeoutMs: 25,
      }),
    ).rejects.toThrow("stalled for 1 seconds after 0 of 1 bytes");
  });

  it("rejects release metadata and response sizes before retaining an archive", async () => {
    await expect(
      downloadRegistryPackage({
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(Uint8Array.of(1), { headers: { "content-length": "2" } }),
          ),
        url: "https://downloads.example.test/canvas.penkra",
        appSlug: "canvas",
        version: "1.0.0",
        expectedBytes: 1,
        maximumBytes: 100,
      }),
    ).rejects.toThrow("Content-Length does not match");

    await expect(
      downloadRegistryPackage({
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(Uint8Array.of(1), { headers: { "content-length": "1" } }),
          ),
        url: "https://downloads.example.test/canvas.penkra",
        appSlug: "canvas",
        version: "1.0.0",
        expectedBytes: 1,
        maximumBytes: 0,
      }),
    ).rejects.toThrow("archive size limit");
  });

  it("rejects a body that ends before its release metadata size", async () => {
    await expect(
      downloadRegistryPackage({
        fetch: vi.fn().mockResolvedValue(new Response(Uint8Array.of(1), { headers: {} })),
        url: "https://downloads.example.test/canvas.penkra",
        appSlug: "canvas",
        version: "1.0.0",
        expectedBytes: 2,
        maximumBytes: 100,
      }),
    ).rejects.toThrow("ended before its declared size");
  });
});
