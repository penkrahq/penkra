import { describe, expect, it } from "vitest";

import { classifyComputerUseCapability } from "./computerUseCapability";

describe("classifyComputerUseCapability", () => {
  it("prefers node_repl when both routes expose tools", () => {
    const health = classifyComputerUseCapability({
      checkedAt: "2026-08-13T00:00:00.000Z",
      inventory: [
        { name: "node_repl", toolNames: ["js", "js_reset"] },
        { name: "computer-use", toolNames: ["get_app_state", "click"] },
      ],
    });

    expect(health).toMatchObject({
      state: "available",
      preferredRoute: "node-repl",
      checkedAt: "2026-08-13T00:00:00.000Z",
    });
  });

  it("uses raw MCP as a degraded fallback", () => {
    const health = classifyComputerUseCapability({
      inventory: [{ name: "plugin-computer-use", toolNames: ["click"] }],
      startupStatuses: [{ name: "node_repl", state: "failed", error: "pipe unavailable" }],
    });

    expect(health.state).toBe("degraded");
    expect(health.preferredRoute).toBe("raw-mcp");
    expect(health.routes[0]).toMatchObject({ state: "failed", error: "pipe unavailable" });
    expect(health.routes[1]).toMatchObject({ state: "ready", toolCount: 1 });
  });

  it("reports unavailable without inventing configured routes", () => {
    const health = classifyComputerUseCapability({ inventory: [] });

    expect(health.state).toBe("unavailable");
    expect(health.preferredRoute).toBeNull();
    expect(health.routes.map((route) => route.state)).toEqual(["missing", "missing"]);
  });
});
