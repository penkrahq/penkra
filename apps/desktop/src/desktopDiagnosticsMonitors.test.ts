import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsSpoolWriter } from "@penkra/shared/diagnostics/store";
import { DIAGNOSTIC_LIMITS } from "@penkra/shared/diagnostics/limits";

import { startDesktopDiagnosticsMonitors } from "./desktopDiagnosticsMonitors";

describe("desktop diagnostics monitors", () => {
  it("continues sampling and watching after bootstrap until shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-desktop-monitors-"));
    const writer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    const watchdog = vi.spyOn(writer, "checkProcessHealth");
    const spoolPath = path.join(stateDir, "diagnostics", `spool-${writer.bootId}.jsonl`);
    const healthCount = () =>
      fs
        .readFileSync(spoolPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"type":"health"')).length;
    try {
      const shutdown = startDesktopDiagnosticsMonitors(writer);
      const initialHealth = healthCount();
      await Promise.resolve(); // Bootstrap's asynchronous setup has completed.
      await vi.advanceTimersByTimeAsync(DIAGNOSTIC_LIMITS.healthSampleMs);
      expect(healthCount()).toBeGreaterThan(initialHealth);
      expect(watchdog).toHaveBeenCalledTimes(1);
      shutdown();
      shutdown();
      const stoppedHealth = healthCount();
      await vi.advanceTimersByTimeAsync(DIAGNOSTIC_LIMITS.healthSampleMs);
      expect(healthCount()).toBe(stoppedHealth);
      expect(watchdog).toHaveBeenCalledTimes(1);
    } finally {
      writer.close();
      vi.useRealTimers();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
