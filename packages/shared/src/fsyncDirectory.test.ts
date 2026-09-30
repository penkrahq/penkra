import * as fs from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fsyncDirectory } from "./fsyncDirectory";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.clearAllMocks();
});

describe("fsyncDirectory", () => {
  it("does not open or fsync a directory on Windows", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    fsyncDirectory("C:\\state");
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it("opens, fsyncs, and closes the directory on POSIX", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    vi.mocked(fs.openSync).mockReturnValue(23);
    fsyncDirectory("/state");
    expect(fs.openSync).toHaveBeenCalledWith("/state", "r");
    expect(fs.fsyncSync).toHaveBeenCalledWith(23);
    expect(fs.closeSync).toHaveBeenCalledWith(23);
  });
});

it("keeps raw directory fsync calls out of diagnostics sources", () => {
  const root = join(import.meta.dirname, "diagnostics");
  for (const entry of readdirSync(root, { recursive: true })) {
    if (typeof entry !== "string") continue;
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const source = readFileSync(join(root, entry), "utf8");
    expect(source, entry).not.toMatch(
      /\b(?:fs|FS)\.openSync\([^\n]*\b(?:dir|directory)\b[^\n]*,\s*["']r["']\)/u,
    );
  }
});
