import { describe, expect, it } from "vitest";

import {
  COVERAGE_ROOTS,
  scanFailureSites,
  uncoveredFailureSites,
  validateCoverageBoundaries,
  type CoverageException,
} from "./diagnostics-coverage";

describe("diagnostics failure inventory", () => {
  it("visits all four production roots", () => {
    expect(COVERAGE_ROOTS).toEqual([
      "apps/server/src",
      "apps/web/src",
      "apps/desktop/src",
      "packages/shared/src",
    ]);
  });

  it("finds catches, throws, rejected effects and timeouts by syntax", () => {
    const source = `
      try { throw new Error("failed") } catch (cause) { Effect.catch(handle) }
      Effect.fail("failed"); Effect.die("failed"); Promise.reject("failed");
      Effect.timeout(task, 1000); setTimeout(done, 1000);
      const text = "throw new Error and setTimeout(";
    `;
    expect(scanFailureSites("apps/server/src/example.ts", source).map((site) => site.kind)).toEqual(
      ["throw", "catch", "catch", "rejection", "rejection", "rejection", "timeout", "timeout"],
    );
  });

  it("requires an exact marker or a reviewed site exception", () => {
    const file = "apps/server/src/example.ts";
    const source = `// diagnostics-covered: COMMAND_REJECTED server.command
throw new Error("one");
// diagnostics-propagates: APP_OPERATION_FAILED server.command
throw new Error("two");
throw new Error("three");`;
    const sites = scanFailureSites(file, source);
    const boundaries = new Map([
      ["COMMAND_REJECTED:server.command", file],
      ["APP_OPERATION_FAILED:server.command", "apps/server/src/commandBoundary.ts"],
    ]);
    expect(uncoveredFailureSites(sites, () => source, [], boundaries)).toEqual([sites[2]]);
    expect(
      uncoveredFailureSites(
        sites,
        () => source,
        [],
        new Map([["COMMAND_REJECTED:server.command", "apps/server/src/other.ts"]]),
      ),
    ).toContainEqual(sites[0]);
    const exception: CoverageException = {
      ...sites[2]!,
      disposition: "validation",
      reason: "Input validation is recorded at the command boundary.",
      reviewer: "reviewer@example.com",
      issue: "https://example.com/issue/1",
    };
    expect(uncoveredFailureSites(sites, () => source, [exception], boundaries)).toEqual([]);
    expect(() =>
      uncoveredFailureSites(sites, () => source, [{ ...exception, line: 99 }], boundaries),
    ).toThrow("stale");
  });

  it("rejects unregistered markers and boundaries without the named recording call", () => {
    const file = "apps/server/src/example.ts";
    const source = `// diagnostics-propagates: COMMAND_REJECTED server.command\nthrow new Error("one");`;
    const sites = scanFailureSites(file, source);
    expect(uncoveredFailureSites(sites, () => source, [])).toEqual(sites);
    expect(() =>
      validateCoverageBoundaries(
        [{ code: "COMMAND_REJECTED", where: "server.command", file }],
        () => source,
      ),
    ).toThrow("does not record");
    const splitRecording = `recordDiagnosticIncident({ code: "COMMAND_REJECTED", where: "server.ws_rpc" });
      recordDiagnosticIncident({ code: "APP_OPERATION_FAILED", where: "server.command" });`;
    expect(() =>
      validateCoverageBoundaries(
        [{ code: "COMMAND_REJECTED", where: "server.command", file }],
        () => splitRecording,
      ),
    ).toThrow("does not record");
    const recordingSource = `recordDiagnosticIncident({ code: "COMMAND_REJECTED", where: "server.command" });`;
    const boundaries = validateCoverageBoundaries(
      [{ code: "COMMAND_REJECTED", where: "server.command", file }],
      () => recordingSource,
    );
    expect(uncoveredFailureSites(sites, () => source, [], boundaries)).toEqual([]);
  });

  it("does not let one marker cover two decisions on the same line", () => {
    const source =
      "throw new Error('one'); throw new Error('two'); // diagnostics-covered: COMMAND_REJECTED";
    const sites = scanFailureSites("apps/web/src/example.ts", source);
    expect(uncoveredFailureSites(sites, () => source, [])).toHaveLength(2);
  });
});
