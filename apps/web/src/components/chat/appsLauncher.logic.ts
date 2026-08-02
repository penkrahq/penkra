// FILE: appsLauncher.logic.ts
// Purpose: Resolves the fixed Apps launcher's open/switch/collapse behavior.

export type AppsLauncherAction =
  | { kind: "open" }
  | { kind: "switch"; paneId: string }
  | { kind: "collapse" };

export function resolveAppsLauncherAction(input: {
  dockOpen: boolean;
  activePaneId: string | null;
  appsPaneId: string | null;
}): AppsLauncherAction {
  if (!input.appsPaneId) return { kind: "open" };
  if (input.dockOpen && input.activePaneId === input.appsPaneId) return { kind: "collapse" };
  return { kind: "switch", paneId: input.appsPaneId };
}
