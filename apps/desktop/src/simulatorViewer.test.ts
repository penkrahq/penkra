import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
  WebContentsView: class {},
}));

import type { SimulatorOwner } from "./simulatorManager";
import { invokeSimulatorViewerInput, simulatorViewerDataUrl } from "./simulatorViewer";

const owner: SimulatorOwner = {
  appId: "com.penkra.simulator",
  spaceId: "space-1",
  tabId: "tab-1",
};

function manager() {
  return {
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
  };
}

describe("Simulator viewer", () => {
  it("uses a static local document with a restrictive content security policy", () => {
    const url = simulatorViewerDataUrl();
    expect(url).toMatch(/^data:text\/html;charset=utf-8,/);
    const html = decodeURIComponent(url.split(",", 2)[1] ?? "");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data:");
    expect(html).toContain("window.penkraSimulatorViewer");
    expect(html).toContain("frame.src = dataUrl");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("routes normalized pointer and keyboard input to the owned session", async () => {
    const target = manager();
    await invokeSimulatorViewerInput(target, owner, {
      method: "tap",
      value: { x: 0.25, y: 0.75 },
    });
    await invokeSimulatorViewerInput(target, owner, {
      method: "swipe",
      value: {
        from: { x: 0.1, y: 0.9 },
        to: { x: 0.9, y: 0.1 },
        durationMs: 350,
      },
    });
    await invokeSimulatorViewerInput(target, owner, {
      method: "type",
      value: "hello",
    });

    expect(target.tap).toHaveBeenCalledWith(owner, { x: 0.25, y: 0.75 });
    expect(target.swipe).toHaveBeenCalledWith(owner, {
      from: { x: 0.1, y: 0.9 },
      to: { x: 0.9, y: 0.1 },
      durationMs: 350,
    });
    expect(target.type).toHaveBeenCalledWith(owner, "hello");
  });

  it("rejects invalid coordinates, durations, text, and methods", async () => {
    const target = manager();
    await expect(
      invokeSimulatorViewerInput(target, owner, {
        method: "tap",
        value: { x: -1, y: 0 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      invokeSimulatorViewerInput(target, owner, {
        method: "swipe",
        value: {
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          durationMs: Infinity,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      invokeSimulatorViewerInput(target, owner, {
        method: "type",
        value: "x".repeat(10_001),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      invokeSimulatorViewerInput(target, owner, {
        method: "press",
        value: "home",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
