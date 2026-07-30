import { describe, expect, it } from "vitest";

import { BackendStartupBlockDetector } from "./backendStartupBlock";

describe("BackendStartupBlockDetector", () => {
  it("recognizes a live database owner across output chunks", () => {
    const detector = new BackendStartupBlockDetector();
    detector.push("DatabaseLifecycle");
    detector.push("LockedError: owner pid 21610 is live (state.sqlite.lifecycle-lock)\n");
    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: 21610 });
  });

  it("classifies a database lock without owner metadata", () => {
    const detector = new BackendStartupBlockDetector();
    detector.push("DatabaseLifecycleLockedError: refusing concurrent database access\n");
    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: null });
  });

  it("ignores unrelated failures", () => {
    const detector = new BackendStartupBlockDetector();
    detector.push("Error: address already in use");
    expect(detector.read()).toBeNull();
  });
});
