import { describe, expect, it } from "vitest";

import { wrapDesktopIpcHandler } from "./desktopIpcCoverage";

describe("desktop IPC failure boundary", () => {
  it("records a content-free incident and preserves the original rejection", async () => {
    const failure = new Error("private account content");
    const incidents: unknown[] = [];
    const handler = wrapDesktopIpcHandler(
      async (_event: unknown, value: number) => {
        if (value < 0) throw failure;
        return value * 2;
      },
      (incident) => incidents.push(incident),
    );
    expect(await handler(null, 2)).toBe(4);
    await expect(handler(null, -1)).rejects.toBe(failure);
    expect(incidents).toEqual([
      {
        kind: "command.failed",
        code: "APP_OPERATION_FAILED",
        where: "desktop.ipc_dispatch",
        severity: "error",
        actual: { outcome: "failed" },
      },
    ]);
    expect(JSON.stringify(incidents)).not.toContain("private account content");
  });
});
