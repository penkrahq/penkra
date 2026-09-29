import { randomBytes } from "node:crypto";

/** Read the OS product version once before diagnostics can enter a hot path. */
export function resolveDesktopOsMajor(getSystemVersion: () => string): number | "unknown" {
  try {
    const major = Number.parseInt(getSystemVersion(), 10);
    return Number.isSafeInteger(major) && major > 0 ? major : "unknown";
  } catch {
    return "unknown";
  }
}

export function recordDesktopOsLookupFailure(
  osMajor: number | "unknown",
  writer: {
    incident: (input: {
      traceId: string;
      spanId: string;
      kind: "external.failed";
      code: "EXTERNAL_CALL_FAILED";
      where: "desktop.os_lookup";
      severity: "warn";
      actual: { errorCode: "OTHER"; reason: "unknown" };
    }) => void;
  },
): void {
  if (osMajor !== "unknown") return;
  writer.incident({
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "desktop.os_lookup",
    severity: "warn",
    actual: { errorCode: "OTHER", reason: "unknown" },
  });
}
