import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { PROCESS_LOG_ROTATION_BYTES, ProcessLogFile } from "./logging";

const directories: string[] = [];
function logPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-process-log-"));
  directories.push(directory);
  return path.join(directory, "process.log");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("appends through the threshold and rotates only at the next startup", () => {
  const filePath = logPath();
  fs.writeFileSync(filePath, "first run");
  fs.truncateSync(filePath, PROCESS_LOG_ROTATION_BYTES);
  const first = new ProcessLogFile(filePath);
  first.write("last line\n");
  expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  expect(fs.statSync(filePath).size).toBe(PROCESS_LOG_ROTATION_BYTES + 10);
  const second = new ProcessLogFile(filePath);
  second.write("second run\n");
  expect(fs.statSync(`${filePath}.1`).size).toBe(PROCESS_LOG_ROTATION_BYTES + 10);
  expect(fs.readFileSync(filePath, "utf8")).toBe("second run\n");
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
});

it("replaces the one previous log with the whole oversized file", () => {
  const filePath = logPath();
  fs.writeFileSync(filePath, "current");
  fs.truncateSync(filePath, PROCESS_LOG_ROTATION_BYTES + 1);
  fs.writeFileSync(`${filePath}.1`, "older");
  const sink = new ProcessLogFile(filePath);
  sink.write("next\n");
  expect(fs.statSync(`${filePath}.1`).size).toBe(PROCESS_LOG_ROTATION_BYTES + 1);
  expect(fs.readdirSync(path.dirname(filePath)).sort()).toEqual(["process.log", "process.log.1"]);
});

it("ignores rotation and append failures without truncating the current log", () => {
  const filePath = logPath();
  fs.writeFileSync(filePath, "current");
  fs.truncateSync(filePath, PROCESS_LOG_ROTATION_BYTES + 1);
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("rotation failed");
  });
  const sink = new ProcessLogFile(filePath);
  vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
    throw new Error("append failed");
  });
  expect(() => sink.write("next\n")).not.toThrow();
  expect(fs.statSync(filePath).size).toBe(PROCESS_LOG_ROTATION_BYTES + 1);
});
