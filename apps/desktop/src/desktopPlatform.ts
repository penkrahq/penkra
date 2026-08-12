// FILE: desktopPlatform.ts
// Purpose: Defines the supported desktop operating-system contract in one explicit adapter.
// Layer: Desktop platform boundary

export type SupportedDesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopIconExtension = "icns" | "ico" | "png";

export interface DesktopPlatformAdapter {
  readonly platform: SupportedDesktopPlatform;
  readonly application: {
    readonly setWindowsAppUserModelId: boolean;
    readonly quitWhenAllWindowsClose: boolean;
    readonly activateBeforeFocus: boolean;
  };
  readonly paths: {
    readonly appData: "application-support" | "roaming-app-data" | "xdg-config";
    readonly pathSyntax: "posix" | "windows";
  };
  readonly processLifecycle: {
    readonly backendShutdown: "posix-signals" | "windows-control";
    readonly registerPosixShutdownSignals: boolean;
    readonly deferWindowCloseUntilShutdown: boolean;
    readonly syncDirectories: boolean;
  };
  readonly credentials: {
    readonly storage: "electron-safe-storage";
    readonly requiresEncryptionAvailability: true;
  };
  readonly deepLinks: {
    readonly primaryDelivery: "open-url-event" | "second-instance-argv";
    readonly inspectInitialArgv: boolean;
  };
  readonly fileHandlers: {
    readonly externalRegistration: "none";
    readonly unresolvedAppIntent: "operating-system";
  };
  readonly browserPermissions: {
    readonly microphone: "macos-system-prompt" | "chromium-grant";
  };
  readonly notifications: {
    readonly icon: "bundle" | "ico" | "png";
    readonly supportsDockOrTaskbarBadge: boolean;
  };
  readonly icons: {
    readonly window: DesktopIconExtension | null;
    readonly legacyDockOverride: boolean;
    readonly refreshBundleCacheAfterUpdate: boolean;
  };
  readonly window: {
    readonly material: "macos-vibrancy" | "opaque";
    readonly titleBar: "macos-hidden-inset" | "windows-frameless" | "native";
  };
  readonly installation: {
    readonly target: "dmg" | "nsis" | "appimage";
    readonly trust: "apple-developer-id" | "unsigned-manual" | "checksum-provenance";
  };
  readonly updater: {
    readonly mode: "automatic" | "appimage-automatic" | "manual-only";
    readonly disableDifferentialDownload: boolean;
    readonly disabledReason: string | null;
  };
}

const MACOS: DesktopPlatformAdapter = {
  platform: "darwin",
  application: {
    setWindowsAppUserModelId: false,
    quitWhenAllWindowsClose: false,
    activateBeforeFocus: true,
  },
  paths: { appData: "application-support", pathSyntax: "posix" },
  processLifecycle: {
    backendShutdown: "posix-signals",
    registerPosixShutdownSignals: true,
    deferWindowCloseUntilShutdown: false,
    syncDirectories: true,
  },
  credentials: {
    storage: "electron-safe-storage",
    requiresEncryptionAvailability: true,
  },
  deepLinks: { primaryDelivery: "open-url-event", inspectInitialArgv: false },
  fileHandlers: {
    externalRegistration: "none",
    unresolvedAppIntent: "operating-system",
  },
  browserPermissions: { microphone: "macos-system-prompt" },
  notifications: { icon: "bundle", supportsDockOrTaskbarBadge: true },
  icons: {
    window: null,
    legacyDockOverride: true,
    refreshBundleCacheAfterUpdate: true,
  },
  window: { material: "macos-vibrancy", titleBar: "macos-hidden-inset" },
  installation: { target: "dmg", trust: "apple-developer-id" },
  updater: {
    mode: "automatic",
    disableDifferentialDownload: true,
    disabledReason: null,
  },
};

const WINDOWS: DesktopPlatformAdapter = {
  platform: "win32",
  application: {
    setWindowsAppUserModelId: true,
    quitWhenAllWindowsClose: true,
    activateBeforeFocus: false,
  },
  paths: { appData: "roaming-app-data", pathSyntax: "windows" },
  processLifecycle: {
    backendShutdown: "windows-control",
    registerPosixShutdownSignals: false,
    deferWindowCloseUntilShutdown: true,
    syncDirectories: false,
  },
  credentials: {
    storage: "electron-safe-storage",
    requiresEncryptionAvailability: true,
  },
  deepLinks: {
    primaryDelivery: "second-instance-argv",
    inspectInitialArgv: true,
  },
  fileHandlers: {
    externalRegistration: "none",
    unresolvedAppIntent: "operating-system",
  },
  browserPermissions: { microphone: "chromium-grant" },
  notifications: { icon: "ico", supportsDockOrTaskbarBadge: true },
  icons: {
    window: "ico",
    legacyDockOverride: false,
    refreshBundleCacheAfterUpdate: false,
  },
  window: { material: "opaque", titleBar: "windows-frameless" },
  installation: { target: "nsis", trust: "unsigned-manual" },
  updater: {
    mode: "manual-only",
    disableDifferentialDownload: false,
    disabledReason:
      "Automatic updates on Windows remain disabled while the initial installer is unsigned and manual-only.",
  },
};

const LINUX: DesktopPlatformAdapter = {
  platform: "linux",
  application: {
    setWindowsAppUserModelId: false,
    quitWhenAllWindowsClose: true,
    activateBeforeFocus: false,
  },
  paths: { appData: "xdg-config", pathSyntax: "posix" },
  processLifecycle: {
    backendShutdown: "posix-signals",
    registerPosixShutdownSignals: true,
    deferWindowCloseUntilShutdown: false,
    syncDirectories: true,
  },
  credentials: {
    storage: "electron-safe-storage",
    requiresEncryptionAvailability: true,
  },
  deepLinks: {
    primaryDelivery: "second-instance-argv",
    inspectInitialArgv: true,
  },
  fileHandlers: {
    externalRegistration: "none",
    unresolvedAppIntent: "operating-system",
  },
  browserPermissions: { microphone: "chromium-grant" },
  notifications: { icon: "png", supportsDockOrTaskbarBadge: true },
  icons: {
    window: "png",
    legacyDockOverride: false,
    refreshBundleCacheAfterUpdate: false,
  },
  window: { material: "opaque", titleBar: "native" },
  installation: { target: "appimage", trust: "checksum-provenance" },
  updater: {
    mode: "appimage-automatic",
    disableDifferentialDownload: false,
    disabledReason: null,
  },
};

export function resolveDesktopPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
): DesktopPlatformAdapter {
  if (platform === "darwin") return MACOS;
  if (platform === "win32") return WINDOWS;
  if (platform === "linux") return LINUX;
  throw new Error(`Unsupported Penkra desktop platform: ${platform}.`);
}
