// FILE: appInstallationStore.ts
// Purpose: Shares trusted local App installation state across Settings and App launch surfaces.
// Layer: Desktop renderer state adapter

import { useSyncExternalStore } from "react";
import type { DesktopAppInstallationSnapshot, DesktopAppSetting } from "@penkra/contracts";

let snapshot: DesktopAppInstallationSnapshot | null = null;
let started = false;
let removeBridgeListener: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: DesktopAppInstallationSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) return;
  removeBridgeListener = bridge.onState(publish);
  void bridge
    .getState()
    .then(publish)
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && removeBridgeListener) {
      removeBridgeListener();
      removeBridgeListener = null;
      started = false;
    }
  };
}

export function useAppInstallationSnapshot(): DesktopAppInstallationSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}

export async function setInstalledAppEnabled(input: {
  appId: string;
  spaceId: string;
  enabled: boolean;
}): Promise<void> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App installation settings are unavailable.");
  publish(await bridge.setEnabled(input));
}

export async function setInstalledAppPermission(input: {
  appId: string;
  spaceId: string;
  permission: string;
  grant: "denied" | "granted";
}): Promise<void> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App permission settings are unavailable.");
  publish(await bridge.setPermission(input));
}

export async function getInstalledAppSettings(input: {
  appId: string;
  spaceId: string;
}): Promise<ReadonlyArray<DesktopAppSetting>> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App settings are unavailable.");
  return bridge.getSettings(input);
}

export async function setInstalledAppSetting(input: {
  appId: string;
  spaceId: string;
  key: string;
  value: boolean | number | string;
}): Promise<ReadonlyArray<DesktopAppSetting>> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App settings are unavailable.");
  return bridge.setSetting(input);
}

export async function resetInstalledAppSetting(input: {
  appId: string;
  spaceId: string;
  key: string;
}): Promise<ReadonlyArray<DesktopAppSetting>> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App settings are unavailable.");
  return bridge.resetSetting(input);
}

export async function setInstalledAppSkillEnabled(input: {
  appId: string;
  spaceId: string;
  path: string;
  enabled: boolean;
}): Promise<void> {
  const bridge = window.desktopBridge?.appInstallations;
  if (!bridge) throw new Error("App skill settings are unavailable.");
  publish(await bridge.setSkillEnabled(input));
}
