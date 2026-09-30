import { describe, expect, it } from "vitest";

import {
  installDesktopFailureCoverageReporter,
  recordDesktopConsumedFailure,
} from "./desktopFailureCoverage";

describe("desktop consumed failure incidents", () => {
  it("buffers early incidents and maps every fixed category to a content-free site", () => {
    recordDesktopConsumedFailure("registry");
    const incidents: unknown[] = [];
    const stop = installDesktopFailureCoverageReporter((incident) => incidents.push(incident));
    try {
      const categories = [
        ["app", "desktop.app_runtime"],
        ["tab", "desktop.tab_observer"],
        ["storage", "desktop.app_storage"],
        ["registry", "desktop.registry_client"],
        ["update", "desktop.update_runtime"],
        ["backend", "desktop.backend_runtime"],
        ["platform", "desktop.platform_runtime"],
        ["simulator", "desktop.simulator_runtime"],
      ] as const;
      for (const [category] of categories) recordDesktopConsumedFailure(category);
      expect(incidents).toEqual(
        ["desktop.registry_client", ...categories.map(([, where]) => where)].map((where) => ({
          kind: "command.failed",
          code: "APP_OPERATION_FAILED",
          where,
          severity: "error",
          actual: { outcome: "failed" },
        })),
      );
    } finally {
      stop();
    }
  });
});
