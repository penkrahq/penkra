import type { DesktopUpdateState } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { subscribeToDesktopUpdateState } from "./desktopUpdate.subscription";

const state = (status: DesktopUpdateState["status"]): DesktopUpdateState => ({
  enabled: true,
  status,
  currentVersion: "0.1.14",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: status === "idle" ? null : "0.1.15",
  downloadedVersion: status === "downloaded" ? "0.1.15" : null,
  message: null,
  checkedAt: null,
  downloadPercent: status === "downloading" ? 90 : status === "downloaded" ? 100 : null,
  releaseUrl: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
});

describe("subscribeToDesktopUpdateState", () => {
  it("reconciles a queued event with the later authoritative snapshot", async () => {
    let resolveSnapshot!: (value: DesktopUpdateState) => void;
    let emitState!: (value: DesktopUpdateState) => void;
    const getUpdateState = vi.fn(
      () =>
        new Promise<DesktopUpdateState>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const unsubscribe = vi.fn();
    const onUpdateState = vi.fn((listener: (value: DesktopUpdateState) => void) => {
      emitState = listener;
      return unsubscribe;
    });
    const observed: DesktopUpdateState[] = [];

    const dispose = subscribeToDesktopUpdateState({ getUpdateState, onUpdateState }, (nextState) =>
      observed.push(nextState),
    );
    emitState(state("downloading"));
    resolveSnapshot(state("downloaded"));
    await Promise.resolve();

    expect(observed.map(({ status }) => status)).toEqual(["downloading", "downloaded"]);

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores events and snapshots after disposal", async () => {
    let resolveSnapshot!: (value: DesktopUpdateState) => void;
    let emitState!: (value: DesktopUpdateState) => void;
    const getUpdateState = () =>
      new Promise<DesktopUpdateState>((resolve) => {
        resolveSnapshot = resolve;
      });
    const onUpdateState = (listener: (value: DesktopUpdateState) => void) => {
      emitState = listener;
      return vi.fn();
    };
    const observed: DesktopUpdateState[] = [];

    const dispose = subscribeToDesktopUpdateState({ getUpdateState, onUpdateState }, (nextState) =>
      observed.push(nextState),
    );
    dispose();
    emitState(state("downloading"));
    resolveSnapshot(state("downloaded"));
    await Promise.resolve();

    expect(observed).toEqual([]);
  });
});
