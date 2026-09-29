import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Logger } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { RotatingFileSink } from "@penkra/shared/logging";

import { makeRotatingServerFileLogger, shouldWriteServerFileLog } from "./serverLogger";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("uses the desktop child capture instead of duplicating server.log", () => {
  expect(shouldWriteServerFileLog({ PENKRA_SERVER_ENTRY: "/tmp/server.mjs" })).toBe(false);
  expect(shouldWriteServerFileLog({})).toBe(true);
});

it("rotates server.log at the configured byte and file limits", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  const logger = makeRotatingServerFileLogger(filePath, 240, 2);
  for (let i = 0; i < 20; i++) {
    await Effect.runPromise(
      Effect.logInfo(`rotation-entry-${i}`).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  }
  const names = fs.readdirSync(directory).sort();
  expect(names).toContain("server.log.1");
  expect(names).not.toContain("server.log.3");
  expect(names).not.toContain("server.log.2");
  expect(names.length).toBeLessThanOrEqual(2);
  expect(names.every((name) => fs.statSync(path.join(directory, name)).size <= 240)).toBe(true);
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  const retained = names
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("");
  expect(retained).toContain("rotation-entry-19");
});

it("bounds an existing oversized server.log and a single oversized entry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  fs.writeFileSync(filePath, "a".repeat(400));
  const logger = makeRotatingServerFileLogger(filePath, 240, 2);
  await Effect.runPromise(
    Effect.logInfo("x".repeat(400)).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  const names = fs.readdirSync(directory);
  expect(names).toContain("server.log");
  expect(names.length).toBeLessThanOrEqual(2);
  expect(names.every((name) => fs.statSync(path.join(directory, name)).size <= 240)).toBe(true);
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
