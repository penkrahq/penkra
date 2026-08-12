// FILE: hostedSurfaceRegistry.ts
// Purpose: Owns trusted native child surfaces inside isolated App-tab views.
// Layer: Desktop hosted-surface composition

import type { SimulatorOwner } from "./simulatorManager";
import type { SimulatorViewportBounds, SimulatorViewportController } from "./simulatorIpc";

export interface HostedSurfaceParent {
  addChildView(view: unknown): void;
  removeChildView(view: unknown): void;
}

export interface HostedSurfaceView {
  readonly nativeView: unknown;
  setBounds(bounds: SimulatorViewportBounds): void;
  setVisible?(visible: boolean): void;
  destroy(): void;
  observationTarget(): unknown;
}

export interface HostedSurfaceFactory {
  create(owner: SimulatorOwner): HostedSurfaceView;
}

interface HostedSurfaceRecord {
  owner: SimulatorOwner;
  view: HostedSurfaceView;
  parent: HostedSurfaceParent;
  bounds: SimulatorViewportBounds;
}

export class HostedSurfaceRegistry implements SimulatorViewportController {
  readonly #factory: HostedSurfaceFactory;
  readonly #resolveParent: (owner: SimulatorOwner) => HostedSurfaceParent | null;
  readonly #records = new Map<string, HostedSurfaceRecord>();

  constructor(input: {
    factory: HostedSurfaceFactory;
    resolveParent(owner: SimulatorOwner): HostedSurfaceParent | null;
  }) {
    this.#factory = input.factory;
    this.#resolveParent = input.resolveParent;
  }

  setViewport(owner: SimulatorOwner, bounds: SimulatorViewportBounds | null): void {
    const existing = this.#records.get(owner.tabId);
    if (existing && !sameOwner(existing.owner, owner)) {
      throw hostedSurfaceError("OWNER_MISMATCH", "Hosted surface ownership changed unexpectedly.");
    }
    if (bounds === null || bounds.width === 0 || bounds.height === 0) {
      if (existing) this.closeTab(owner.tabId);
      return;
    }

    const parent = this.#resolveParent(owner);
    if (!parent) {
      throw hostedSurfaceError(
        "HOSTED_VIEW_UNAVAILABLE",
        "The owning App tab view is unavailable.",
      );
    }
    const normalized = normalizeBounds(bounds);
    if (!existing) {
      const view = this.#factory.create(owner);
      const record = { owner: { ...owner }, view, parent, bounds: normalized };
      this.#records.set(owner.tabId, record);
      parent.addChildView(view.nativeView);
      view.setBounds(normalized);
      view.setVisible?.(true);
      return;
    }
    if (existing.parent !== parent) {
      detach(existing.parent, existing.view);
      parent.addChildView(existing.view.nativeView);
      existing.parent = parent;
    } else {
      // Re-adding an existing child is Electron's supported bring-to-front operation.
      detach(parent, existing.view);
      parent.addChildView(existing.view.nativeView);
    }
    existing.bounds = normalized;
    existing.view.setBounds(normalized);
    existing.view.setVisible?.(true);
  }

  closeTab(tabId: string): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    this.#records.delete(tabId);
    detach(record.parent, record.view);
    record.view.destroy();
  }

  observationTarget(tabId: string): unknown | null {
    return this.#records.get(tabId)?.view.observationTarget() ?? null;
  }

  dispose(): void {
    for (const tabId of [...this.#records.keys()]) this.closeTab(tabId);
  }

  diagnostics(): {
    surfaceCount: number;
    surfaces: ReadonlyArray<{
      appId: string;
      spaceId: string;
      tabId: string;
      bounds: SimulatorViewportBounds;
    }>;
  } {
    return {
      surfaceCount: this.#records.size,
      surfaces: [...this.#records.values()].map((record) => ({
        ...record.owner,
        bounds: { ...record.bounds },
      })),
    };
  }
}

function normalizeBounds(bounds: SimulatorViewportBounds): SimulatorViewportBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function sameOwner(left: SimulatorOwner, right: SimulatorOwner): boolean {
  return left.appId === right.appId && left.spaceId === right.spaceId && left.tabId === right.tabId;
}

function detach(parent: HostedSurfaceParent, view: HostedSurfaceView): void {
  try {
    parent.removeChildView(view.nativeView);
  } catch {
    // The parent may already have detached the child during tab/window teardown.
  }
}

function hostedSurfaceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
