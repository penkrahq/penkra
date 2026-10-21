import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Logger } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { RotatingFileSink } from "@penkra/shared/logging";

import { makeServerFileLogger } from "./serverLogger";
import { createLogger, setFileLogSink } from "./logger";
import { makeProviderProcessDiagnostics } from "./provider/providerProcessDiagnostics";

const directories: string[] = [];
afterEach(() => {
  setFileLogSink(undefined);
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("persists native provider exit diagnostics in the same server log", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  makeServerFileLogger(filePath);
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const diagnostics = makeProviderProcessDiagnostics({ provider: "codex", pid: 42 });
    diagnostics.appendStderr("native failure");
    diagnostics.recordExit(7, null);
    createLogger("codex").info("request sent", { method: "model/list" });
    const contents = fs.readFileSync(filePath, "utf8");
    expect(contents.match(/provider.process.lifecycle/g)).toHaveLength(1);
    expect(contents).toContain('stderr="native failure"');
    expect(contents).toContain('method="model/list"');
    expect(consoleLog).toHaveBeenCalledTimes(2);
  } finally {
    consoleLog.mockRestore();
  }
});

it("appends formatted server lines to server.log", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  fs.writeFileSync(filePath, "previous run\n", { mode: 0o600 });
  const logger = makeServerFileLogger(filePath);
  await Effect.runPromise(
    Effect.logInfo("current run").pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  const contents = fs.readFileSync(filePath, "utf8");
  expect(contents.startsWith("previous run\n")).toBe(true);
  expect(contents).toContain("current run");
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
});

it("ignores log directory failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const blocked = path.join(directory, "blocked");
  fs.writeFileSync(blocked, "not a directory");
  const logger = makeServerFileLogger(path.join(blocked, "server.log"));
  await expect(
    Effect.runPromise(
      Effect.logInfo("unwritable").pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ),
  ).resolves.toBeUndefined();
});

it("keeps the active log intact if an atomic rotation is interrupted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  const sink = new RotatingFileSink({ filePath, maxBytes: 8, maxFiles: 2 });
  sink.write("12345678");
  const originalRename = fs.renameSync;
  const rename = vi.spyOn(fsDefault, "renameSync").mockImplementation((from, to) => {
    if (to === filePath) throw new Error("interrupted replacement");
    return originalRename(from, to);
  });
  try {
    sink.write("abc");
  } finally {
    rename.mockRestore();
  }
  expect(fs.readFileSync(filePath, "utf8")).toBe("12345678");
  expect(fs.readdirSync(directory).some((name) => name.includes("penkra-tmp"))).toBe(false);
  sink.write("abc");
  expect(fs.readFileSync(filePath, "utf8")).toBe("abc");
  expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("12345678");
});

it("does not truncate an oversized log in place when replacement fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  fs.writeFileSync(filePath, "1234567890abcdef");
  const rename = vi.spyOn(fsDefault, "renameSync").mockImplementation(() => {
    throw new Error("interrupted clamp");
  });
  try {
    new RotatingFileSink({ filePath, maxBytes: 8, maxFiles: 2 });
  } finally {
    rename.mockRestore();
  }
  expect(fs.readFileSync(filePath, "utf8")).toBe("1234567890abcdef");
  new RotatingFileSink({ filePath, maxBytes: 8, maxFiles: 2 });
  expect(fs.readFileSync(filePath, "utf8")).toBe("90abcdef");
});
