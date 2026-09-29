import { describe, expect, it } from "vitest";
import type { IncidentInput } from "@penkra/shared/diagnostics/store";
import { validateDiagnosticFields } from "@penkra/shared/diagnostics/privacy";

import { recordDesktopMainIncident } from "./desktopMainIncident";

describe("desktop main incident delivery", () => {
  it.each([
    ["APP_OPERATION_FAILED", "desktop.app_cleanup"],
    ["UPDATE_CHECK_FAILED", "desktop.update_check"],
    ["UNCLEAN_SHUTDOWN", "desktop.shutdown"],
  ] as const)("queues a content-free %s incident", (code, where) => {
    const writes: Array<{ kind: string; input: IncidentInput }> = [];
    recordDesktopMainIncident((kind, input) => writes.push({ kind, input }), {
      kind: "command.failed",
      code,
      where,
      severity: "error",
      actual: { outcome: "failed" },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("incident");
    expect(writes[0]?.input).toMatchObject({
      code,
      where,
      actual: { outcome: "failed" },
      traceId: expect.any(String),
      spanId: expect.any(String),
    });
    expect(validateDiagnosticFields(writes[0]!.input.actual ?? {})).toEqual({ outcome: "failed" });
    expect(JSON.stringify(writes[0]?.input)).not.toContain("Error:");
  });
});
