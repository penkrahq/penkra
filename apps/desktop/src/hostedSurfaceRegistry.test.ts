import { describe, expect, it, vi } from "vitest";

import {
  HostedSurfaceRegistry,
  type HostedSurfaceParent,
  type HostedSurfaceView,
} from "./hostedSurfaceRegistry";

const owner = { appId: "com.penkra.simulator", spaceId: "space-a", tabId: "tab-a" };

function fixture() {
  const view: HostedSurfaceView = {
    nativeView: { id: "native-view" },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    observationTarget: vi.fn(() => ({ id: "viewer" })),
  };
  const parent: HostedSurfaceParent = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  };
  const factory = { create: vi.fn(() => view) };
  const registry = new HostedSurfaceRegistry({ factory, resolveParent: () => parent });
  return { registry, factory, parent, view };
}

describe("HostedSurfaceRegistry", () => {
  it("creates one clipped child view in App-local coordinates", () => {
    const { registry, factory, parent, view } = fixture();
    registry.setViewport(owner, { x: 10.4, y: 20.6, width: 300.2, height: 600.8 });

    expect(factory.create).toHaveBeenCalledWith(owner);
    expect(parent.addChildView).toHaveBeenCalledWith(view.nativeView);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 21, width: 300, height: 601 });
    expect(registry.diagnostics()).toMatchObject({ surfaceCount: 1 });
  });

  it("reuses and brings the same view forward on viewport changes", () => {
    const { registry, factory, parent, view } = fixture();
    registry.setViewport(owner, { x: 0, y: 0, width: 100, height: 200 });
    registry.setViewport(owner, { x: 5, y: 6, width: 120, height: 220 });

    expect(factory.create).toHaveBeenCalledOnce();
    expect(parent.removeChildView).toHaveBeenCalledWith(view.nativeView);
    expect(parent.addChildView).toHaveBeenCalledTimes(2);
  });

  it("destroys and detaches a surface when its viewport is relinquished", () => {
    const { registry, parent, view } = fixture();
    registry.setViewport(owner, { x: 0, y: 0, width: 100, height: 200 });
    registry.setViewport(owner, null);

    expect(parent.removeChildView).toHaveBeenCalledWith(view.nativeView);
    expect(view.destroy).toHaveBeenCalledOnce();
    expect(registry.observationTarget(owner.tabId)).toBeNull();
  });

  it("destroys exactly the tab-owned view on tab close", () => {
    const { registry, parent, view } = fixture();
    registry.setViewport(owner, { x: 0, y: 0, width: 100, height: 200 });
    registry.closeTab(owner.tabId);
    registry.closeTab(owner.tabId);

    expect(parent.removeChildView).toHaveBeenCalledWith(view.nativeView);
    expect(view.destroy).toHaveBeenCalledOnce();
    expect(registry.observationTarget(owner.tabId)).toBeNull();
  });

  it("rejects cross-owner reuse of a tab ID", () => {
    const { registry } = fixture();
    registry.setViewport(owner, { x: 0, y: 0, width: 100, height: 200 });
    expect(() =>
      registry.setViewport(
        { ...owner, appId: "evil" },
        {
          x: 0,
          y: 0,
          width: 100,
          height: 200,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
  });
});
