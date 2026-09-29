import { describe, expect, it } from "vitest";

import {
  installDesktopFailureCoverageReporter,
  recordDesktopConsumedFailure,
} from "./desktopFailureCoverage";

describe("desktop consumed failure incidents", () => {
  it("buffers early incidents and reports only fixed categories", () => {
    recordDesktopConsumedFailure("registry");
    const incidents: unknown[] = [];
    const stop = installDesktopFailureCoverageReporter((incident) => incidents.push(incident));
    try {
      recordDesktopConsumedFailure("tab");
      expect(incidents).toEqual([
        {
          kind: "command.failed",
          code: "APP_OPERATION_FAILED",
          where: "desktop.registry_client",
          severity: "error",
          actual: { outcome: "failed" },
        },
        {
          kind: "command.failed",
          code: "APP_OPERATION_FAILED",
          where: "desktop.tab_observer",
          severity: "error",
          actual: { outcome: "failed" },
        },
      ]);
    } finally {
      stop();
    }
  });
});
