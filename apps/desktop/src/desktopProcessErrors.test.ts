import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isBrokenPipeError, recordDesktopFatalError } from "./desktopProcessErrors";

describe("fatal exception evidence", () => {
  it("saves the original stack before a throwing exception handler exits the process", () => {
    const root = mkdtempSync(join(tmpdir(), "penkra-fatal-evidence-"));
    const log = join(root, "fatal.log");
    try {
      const source = `
        import { appendFileSync } from 'node:fs';
        import { recordDesktopFatalError } from ${JSON.stringify(new URL("./desktopProcessErrors.ts", import.meta.url).href)};
        process.on('uncaughtExceptionMonitor', (error, origin) => {
          recordDesktopFatalError(error, origin, text => appendFileSync(${JSON.stringify(log)}, text));
        });
        process.on('uncaughtException', error => { throw error; });
        setImmediate(function triggerFatalEvidence() { throw new Error('original desktop failure'); });
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      const evidence = readFileSync(log, "utf8");
      expect(evidence).toContain("origin=uncaughtException");
      expect(evidence).toContain("Error: original desktop failure");
      expect(evidence).toContain("triggerFatalEvidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace the fatal error when its diagnostic sink fails", () => {
    expect(() =>
      recordDesktopFatalError(new Error("original"), "uncaughtException", () => {
        throw new Error("diagnostic sink unavailable");
      }),
    ).not.toThrow();
  });
});

describe("isBrokenPipeError", () => {
  it("recognizes stderr broken pipe errors", () => {
    const error = new Error("write EPIPE") as NodeJS.ErrnoException;
    error.code = "EPIPE";

    expect(isBrokenPipeError(error)).toBe(true);
  });

  it("ignores other process errors", () => {
    const error = new Error("connection reset") as NodeJS.ErrnoException;
    error.code = "ECONNRESET";

    expect(isBrokenPipeError(error)).toBe(false);
  });

  it("ignores non-error values", () => {
    expect(isBrokenPipeError("EPIPE")).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
  });
});
