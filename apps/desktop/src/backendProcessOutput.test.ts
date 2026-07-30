import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { captureBackendProcessOutput } from "./backendProcessOutput";

describe("captureBackendProcessOutput", () => {
  it("tees output to development stdio and detectors", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const forwardedStdout: Buffer[] = [];
    const forwardedStderr: Buffer[] = [];
    const detected: Buffer[] = [];
    const capture = captureBackendProcessOutput({
      stdout,
      stderr,
      writeStdout: (chunk) => forwardedStdout.push(chunk),
      writeStderr: (chunk) => forwardedStderr.push(chunk),
      detectors: [{ push: (chunk) => detected.push(chunk) }],
    });

    stdout.end("Server listening");
    stderr.end("DatabaseLifecycleLockedError:");
    await capture.drained;

    expect(Buffer.concat(forwardedStdout).toString("utf8")).toBe("Server listening");
    expect(Buffer.concat(forwardedStderr).toString("utf8")).toBe("DatabaseLifecycleLockedError:");
    expect(Buffer.concat(detected).toString("utf8")).toBe(
      "Server listeningDatabaseLifecycleLockedError:",
    );
  });
});
