// FILE: main.ts
// Purpose: Starts the Electron shell, backend process, native menus, IPC bridges, and updater.
// Layer: Desktop main process
// Depends on: Electron, backend startup helpers, browser manager, and update runtime.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
// Electron-only builtin that sees app.asar as a real file instead of a virtual
// directory — required to stat the archive itself for swap detection.
import * as OriginalFS from "original-fs";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";
import type {
  BrowserWindowConstructorOptions,
  FileFilter,
  IpcMainEvent,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopSpacesMenuInput,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ThreadBrowserState,
  ThreadId,
} from "@penkra/contracts";
import {
  autoUpdater,
  BaseUpdater,
  CancellationToken,
  type UpdateDownloadedEvent,
} from "electron-updater";

import type { ContextMenuItem } from "@penkra/contracts";
import { isKeyboardShortcutsHelpChord } from "@penkra/shared/browserShortcuts";
import { getMacTrafficLightPosition } from "@penkra/shared/desktopChrome";
import {
  PENKRA_DESKTOP_UPDATE_CHANNEL,
  penkraDesktopIdentity,
  resolvePenkraDesktopFlavor,
  resolvePenkraDevInstance,
} from "@penkra/shared/desktopIdentity";
import { bindDesktopParentPid } from "@penkra/shared/desktopParentLifecycle";
import { NetService } from "@penkra/shared/Net";
import { applyShellEnvironmentHydrationMarker } from "@penkra/shared/shell";
import { RotatingFileSink } from "@penkra/shared/logging";
import { ensureStaticSnapshot, findAsarArchivePath } from "@penkra/shared/staticSnapshot";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness";
import { queryAppPermission } from "./appPermissionQuery";
import { resolveBackendNodeArgs } from "./backendNodeOptions";
import { ActiveWorkPowerBlocker } from "./activeWorkPowerBlocker";
import {
  retainLiveBackendAfterShutdownFailure,
  requireWindowsBackendExit,
  runAfterDesktopShutdown,
  shouldDeferDesktopWindowClose,
  stopPosixBackendAndWait,
  stopWindowsBackendAndWait,
} from "./backendShutdown";
import {
  bundleSignatureFromStats,
  isBundleStable,
  isBundleSwapped,
  isWatchableBundlePath,
  type BundleSignature,
} from "./bundleSwapDetection";
import { waitForBackendStartupReady } from "./backendStartupReadiness";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { normalizeDesktopSpacesMenuInput } from "./spacesMenu";
import {
  makeUpdateInstallPreparationCoordinator,
  type UpdateInstallPreparationAttempt,
} from "./updateInstallPreparation";
import {
  hasPendingDesktopMigrationRecovery,
  requiresDesktopMigrationRecovery,
  recoverDesktopMigrationIfRequired,
  resolveDesktopMigrationRecoveryPaths,
  restoreDesktopMigrationBackup,
  type DesktopMigrationRecoveryDecision,
  type DesktopMigrationRecoveryOutcome,
  type DesktopMigrationRecoveryPaths,
} from "./desktopMigrationRecovery";
import {
  LSREGISTER_PATH,
  parseLastLaunchVersion,
  resolveLaunchVersionRecordPath,
  resolveMacAppBundlePath,
  serializeLaunchVersionRecord,
  shouldRefreshIconCache,
} from "./macIconCacheRefresh";
import { collectMacUpdateDiagnostics } from "./macUpdateDiagnostics";
import { openInitialBackendWindow } from "./initialBackendWindowOpen";
import {
  isTrustedMediaPermissionRequest,
  resolveMicrophonePermissionRequest,
} from "./mediaPermissions";
import {
  installResumableUpdateDownloader,
  type ResumableDownloaderTarget,
} from "./resumableUpdateDownload";
import { hardenElectronUpdater } from "./electronUpdaterSecurity";
import { ServerListeningDetector } from "./serverListeningDetector";
import { BackendStartupBlockDetector, type BackendStartupBlock } from "./backendStartupBlock";
import {
  BACKEND_MAX_CONSECUTIVE_START_FAILURES,
  BackendOutputTailDetector,
  BackendSupervisionPolicy,
  summarizeBackendFailureOutput,
} from "./backendSupervisionPolicy";
import { captureBackendProcessOutput } from "./backendProcessOutput";
import { syncShellEnvironment } from "./syncShellEnvironment";
import { resolvePenkraAccountServiceEndpoints } from "./accountServiceEndpoints";
import { resolveDesktopPlatformAdapter } from "./desktopPlatform";
import {
  RENDERER_MAX_AUTOMATIC_RELOADS,
  RendererCrashPolicy,
  type RendererCrashResponse,
} from "./rendererCrashRecovery";
import {
  type DownloadProgressSample,
  getAutoUpdateDisabledReason,
  getDownloadStallTimeoutMessage,
  hasDownloadProgressAdvanced,
  isExpectedStalledDownloadCancellationError,
  isUpdateVersionNewer,
  shouldBroadcastDownloadProgress,
  shouldCheckForUpdatesOnForeground,
} from "./updateState";
import { registerDesktopVoiceTranscriptionHandler } from "./voiceTranscription";
import {
  resolveDesktopMenuAccelerator,
  resolveDesktopWindowZoomAction,
  resolveKeyboardShortcutsMenuAccelerator,
} from "./menuShortcuts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallRestartFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import {
  PendingUpdateCacheClearQueue,
  resolveElectronUpdaterCacheDirName,
  resolveElectronUpdaterLegacyZipPath,
  resolveElectronUpdaterPendingCacheDir,
} from "./updatePendingCache";
import {
  clearInstallMarker,
  createUpdateInstallMarker,
  markInstallHandoffSync,
  readInstallMarker,
  recordInstallMarkerFailureSync,
  resolveInstallMarkerOutcome,
  writeInstallMarker,
  type UpdateInstallHandoffExpectation,
  type UpdateInstallMarker,
} from "./updateInstallMarker";
import {
  fingerprintUpdateArtifact,
  verifyUpdateArtifactIdentity,
  type UpdateArtifactIdentity,
} from "./updateArtifactIdentity";
import { buildGitHubReleasesPageUrl, resolveGitHubUpdateSource } from "./githubUpdateFeed";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "./browserManager";
import { createScopedBrowserSessionPartition } from "./browserSessionPolicy";
import { normalizeHostedBrowserViewportBounds } from "./hostedBrowserViewport";
import { AppCommandPipeServer, resolveAppCommandPipePath } from "./appCommandPipeServer";
import { AppTabObserver, resolveAppTabObservationTarget } from "./appTabObserver";
import { BROWSER_APP_ID, isRequiredApp } from "./appDistributionPolicy";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import {
  repairBrowserProfileFromBridgeManifest,
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
} from "./desktopUserDataProfile";
import { configurePenkraAccountAuth } from "./accountAuth";
import { AppRegistryClient } from "./appRegistryClient";
import { assertRegistryReleaseAllowed, parseRegistryTrustKeys } from "./appRegistryTrust";
import { createDesktopPrivilegedSchemes } from "./desktopProtocolSchemes";
import { isBrokenPipeError } from "./desktopProcessErrors";
import {
  createDesktopStaticProtocolResolver,
  resolveDesktopAppRoot,
} from "./desktopStaticProtocol";
import {
  readPenkraRootPointer,
  resolvePenkraRuntime,
  resolvePenkraRootPointerPath,
  writePenkraRootPointer,
} from "./penkraRoot";
import {
  readDesktopWindowState,
  resolveVisibleWindowBounds,
  writeDesktopWindowState,
} from "./windowState";
import {
  acknowledgePenkraStorageSnapshot,
  readPenkraStorageSnapshot,
  resolvePenkraStorageSnapshotPath,
} from "./desktopStorageMigration";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { ComposerDraftJournal } from "./composerDraftJournal";
import { resolveVoiceQaAudioInput } from "./voiceQaAudioInput";
import { startDesktopAppRuntime, type DesktopAppRuntime } from "./desktopAppRuntime";
import {
  openDesktopSimulatorHostRuntime,
  type DesktopSimulatorHostRuntime,
} from "./simulatorHostRuntime";
import { createDesktopSimulatorAdapterBundle } from "./simulatorAdapterBundle";
import { invokeSimulatorCall } from "./simulatorIpc";
import { HostedSurfaceRegistry, type HostedSurfaceParent } from "./hostedSurfaceRegistry";
import { ElectronSimulatorViewerFactory } from "./simulatorViewer";
import { queueAndroidSdkLicenseReview } from "./simulatorLicenseReview";
import {
  parseDesktopAppTheme,
  parseDesktopAppTypography,
  renderDesktopAppThemeCss,
  renderDesktopAppTypographyCss,
} from "./appTheme";
import { mediatedAppFetch } from "./appNetworkFetch";
import { requestAppAccountData, subscribeAppAccountData } from "./appAccountData";
import { APP_STANDARD_PERMISSIONS, isAppStandardPermissionName } from "./appStandardPermissions";
import {
  parseAppSettingKey,
  parseAppSettingTarget,
  parseAppSettingValue,
  parseInstallRegistryAppRequest,
  parseRollbackRegistryAppRequest,
  parseUpdateRegistryAppRequest,
  parseRemoveAppDataRequest,
  parseSetAppEnabledRequest,
  parseSetAppSkillEnabledRequest,
  parseSetAppPermissionRequest,
  parseUninstallAppRequest,
  toDesktopAppSettings,
  toDesktopAppInstallationSnapshot,
} from "./appInstallationIpc";
import {
  parseRegistryArtifactRequest,
  parseRegistryFeedbackRequest,
  parseRegistryGetRequest,
  parseRegistryListRequest,
  parseRegistryRatingRequest,
  parseRegistryReviewRequest,
} from "./appRegistryIpc";
import { installRegistryApp, rollbackRegistryApp, updateRegistryApp } from "./registryAppInstaller";
import {
  reconcileAutomaticRegistryAppUpdates,
  type AutomaticRegistryAppUpdateReport,
} from "./automaticRegistryAppUpdates";
import { bootstrapDefaultRegistryApps } from "./defaultRegistryAppsBootstrap";
import {
  loadRequiredAppsPackage,
  reconcileRequiredAppsForSpaces,
  resolveRequiredAppsBundle,
  REQUIRED_APPS_SOURCE_PATH_ENV,
} from "./requiredRegistryAppBootstrap";
import { DevelopmentAppSideloadRegistry } from "./developmentAppSideloadRegistry";
import { createInitialWindowPresenter } from "./initialWindowVisibility";
import {
  appTabCssBoundsToNativeBounds,
  parseAppTabIdRequest,
  parseAppTabRendererRequest,
  parseAppTabRouteRequest,
  parseNavigateAppTabRequest,
  parseOpenAppFromAppsRequest,
  parseOpenAppTabRequest,
  parseSetAppTabBoundsRequest,
  parseSetAppTabVisibleRequest,
} from "./appTabIpc";
import { parseAppListingDeepLink } from "./appListingDeepLink";
import { getInstalledAppPackage, type VerifiedAppPackageInput } from "./appInstallationState";

// Capture the real archive identity before any explicit app.asar lookup. Static
// snapshotting and the runtime watcher both use this same generation as their
// baseline, so a replacement during startup cannot silently become "normal."
const startupBundleIdentity = captureStartupBundleIdentity();

// Deliberately still on the pre-`whenReady()` path. On posix it is normally a cache read
// (see `createCachedLoginShellEnvironmentReader`); only a first launch, a changed shell
// startup file, or an aged-out entry pays the ~1s login-shell probe again.
// The reads a few lines below decide where this install's data lives, and two of them
// depend on what this probe brings in: `resolveUserDataPath()` takes the Electron profile
// directory from XDG_CONFIG_HOME on Linux, which the login-shell probe captures, and
// `BASE_DIR` prefers PENKRA_HOME, which the Windows registry read hydrates whenever the
// user set it persistently. Resolving either against an unhydrated environment would
// silently relocate an existing user's profile and data directory.
// (The probe also carries PATH, SSH_AUTH_SOCK and HOMEBREW_* for later provider spawns.
// APPDATA on Windows is inherited from the process env, not hydrated here.)
const shellEnvironmentSync = syncShellEnvironment();

const IPC = DESKTOP_IPC_CHANNELS;
const MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;
function composerBytesFromIpc(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Invalid composer asset bytes.");
}
const desktopFlavor = resolvePenkraDesktopFlavor({
  isPackaged: app.isPackaged,
  ...(process.env.PENKRA_DESKTOP_FLAVOR
    ? { requestedFlavor: process.env.PENKRA_DESKTOP_FLAVOR }
    : {}),
});
const isDevelopment = desktopFlavor === "development";
const isPackagedRuntime = app.isPackaged && !isDevelopment;
const desktopPlatform = resolveDesktopPlatformAdapter();
const penkraAppDataBase = resolveDesktopAppDataBase({
  platform: desktopPlatform.platform,
});
const penkraRootPointerPath = resolvePenkraRootPointerPath(penkraAppDataBase);
const penkraAccountServices = resolvePenkraAccountServiceEndpoints({
  configuredApiUrl: process.env.PENKRA_API_URL,
  configuredWebsiteOrigin: process.env.PENKRA_WEBSITE_ORIGIN,
});
const penkraRuntime = resolvePenkraRuntime({
  isDevelopment,
  configuredRoot: process.env.PENKRA_ROOT,
  configuredApiUrl: penkraAccountServices.apiUrl,
  persistedProductionRoot: isDevelopment ? null : readPenkraRootPointer(penkraRootPointerPath),
});
const needsPenkraRootPicker = penkraRuntime.needsRootPicker;
const PENKRA_ROOT = penkraRuntime.root;
const PENKRA_PICKER_USER_DATA = Path.join(penkraAppDataBase, "Penkra", "picker-userdata");
const PENKRA_API_URL = penkraRuntime.apiUrl;
process.env.PENKRA_ROOT = PENKRA_ROOT;
process.env.PENKRA_API_URL = PENKRA_API_URL;
process.env.PENKRA_HOME = Path.join(PENKRA_ROOT, ".penkra");
const developmentInstance = resolvePenkraDevInstance(process.env.PENKRA_DEV_INSTANCE_NUMBER);
const desktopIdentity = penkraDesktopIdentity(desktopFlavor, developmentInstance);
const BASE_DIR =
  process.env.PENKRA_HOME?.trim() ||
  Path.join(OS.homedir(), desktopIdentity.defaultHomeDirectoryName);
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_WINDOW_STATE_PATH = Path.join(STATE_DIR, "desktop-window-state.json");
const DESKTOP_SCHEME = desktopIdentity.scheme;
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_USER_MODEL_ID = desktopIdentity.bundleId;
const desktopSmokeUserDataPath = process.env.PENKRA_DESKTOP_SMOKE_USER_DATA?.trim();
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const DESKTOP_LOG_FILE_NAME = "desktop-main.log";
const BACKEND_LOG_FILE_NAME = "server-child.log";
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const DESKTOP_BACKEND_SHUTDOWN_TOKEN = Crypto.randomBytes(32).toString("hex");
// Electron's single-instance lock is scoped through userData on Windows/Linux.
// Set the flavor-specific profile first so Stable and Dev never contend for the
// same lock even when they use the same Electron executable.
if (desktopSmokeUserDataPath && Path.isAbsolute(desktopSmokeUserDataPath)) {
  // Keep smoke launches isolated from a developer's running Penkra instance.
  app.setName(`${APP_DISPLAY_NAME} Smoke ${process.pid}`);
  // A synthetic smoke identity must not prompt for or wait on the operator's macOS
  // Keychain. The temporary profile still exercises safeStorage through Chromium's
  // purpose-built test keychain; normal Dev and production launches use the real one.
  app.commandLine.appendSwitch("use-mock-keychain");
}
const voiceQaAudioInput = resolveVoiceQaAudioInput(process.env.PENKRA_VOICE_QA_WAV);
if (voiceQaAudioInput) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", voiceQaAudioInput);
}
const userDataPath =
  desktopSmokeUserDataPath && Path.isAbsolute(desktopSmokeUserDataPath)
    ? Path.resolve(desktopSmokeUserDataPath)
    : resolveUserDataPath();
app.setPath("userData", userDataPath);
const composerDraftJournal = new ComposerDraftJournal(userDataPath);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS = 30 * 1000;
const AUTO_UPDATE_CHECK_TIMEOUT_MS = 45 * 1000;
const AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 60 * 1000;
// Upper bound on how long we wait for electron-updater to release a cancelled
// download before allowing a retry, so a wedged updater promise can't block updates.
const AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS = 20 * 1000;
const AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS = 2 * 60 * 1000;
// How long we give quitAndInstall() to actually quit/relaunch the app before we
// conclude the OS installer never started (unsigned/quarantined build, read-only
// install dir, blocked NSIS run) and surface the manual-download fallback.
const AUTO_UPDATE_INSTALL_WATCHDOG_MS = 15 * 1000;
const AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS = 2_800;
// User-driven like the menu and renderer reasons, so it must not be filtered
// out by the automatic-activity suppression a previous install failure arms.
const UPDATE_CHECK_REASON_MIGRATION_RECOVERY = "migration recovery";
const UPDATE_INSTALL_MARKER_FILE_NAME = "pending-update-install.json";
const BACKEND_FORCE_KILL_DELAY_MS = 8_000;
const BACKEND_SHUTDOWN_TIMEOUT_MS = 10_000;
// Update installation is a controlled handoff, so it must give the server's
// 120-second provider-command deadline enough time to settle a claimed external
// command durably. Ordinary app quit keeps the short shutdown budget below.
const UPDATE_BACKEND_FORCE_KILL_DELAY_MS = 125_000;
const UPDATE_BACKEND_SHUTDOWN_TIMEOUT_MS = 130_000;
const BACKEND_MAX_OLD_SPACE_ENV_KEYS = ["PENKRA_BACKEND_MAX_OLD_SPACE_MB"] as const;
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const DESKTOP_MENU_ZOOM_FACTOR_STEP = Math.sqrt(1.2);
const DESKTOP_MENU_MIN_ZOOM_FACTOR = 0.25;
const DESKTOP_MENU_MAX_ZOOM_FACTOR = 5;
const PENKRA_BROWSER_LABEL = "Penkra browser";
const AUTOMATIC_APP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const AUTOMATIC_APP_UPDATE_FAILURE_RETRY_MS = 15 * 60 * 1_000;
const browserPerfLoggingEnabled = process.env.PENKRA_BROWSER_PERF === "1";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let pendingAppListingRequest: { appId: string } | null = null;
let desktopAppRuntime: DesktopAppRuntime | null = null;
let desktopSimulatorRuntime: DesktopSimulatorHostRuntime | null = null;
let simulatorHostedSurfaces: HostedSurfaceRegistry | null = null;
let simulatorViewerFactory: ElectronSimulatorViewerFactory | null = null;
let unsubscribeSimulatorState: (() => void) | null = null;
const appSimulatorTrackedRendererIds = new Set<number>();
let appRegistryClient: AppRegistryClient | null = null;
let developmentSideloadRegistry: DevelopmentAppSideloadRegistry | null = null;
let requiredAppsPackage: (VerifiedAppPackageInput & { source: "registry" }) | null = null;
let requiredAppsPackageLoad: Promise<VerifiedAppPackageInput & { source: "registry" }> | null =
  null;
let requiredAppsPackageIsDevelopmentSource = false;
let configuredAppBootstrapQueue: Promise<void> = Promise.resolve();
let automaticAppUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let automaticAppUpdateReport: AutomaticRegistryAppUpdateReport | null = null;
let getPenkraAccountId: () => Promise<string | null> = async () => null;
let getPenkraAccountCookie: () => string = () => "";
const appAccountSubscriptions = new Map<string, { senderId: number; stop(): void }>();
const activeWorkPowerBlocker = new ActiveWorkPowerBlocker({
  blocker: powerSaveBlocker,
  onError: (message, error) =>
    safeConsoleError(`[desktop-power] ${message} ${formatErrorMessage(error)}`),
});
let spacesMenuState: DesktopSpacesMenuInput = {
  activeSpaceId: null,
  spaces: [],
};
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;

function scheduleAutomaticAppUpdateCheck(delayMs: number): void {
  if (automaticAppUpdateTimer !== null) clearTimeout(automaticAppUpdateTimer);
  automaticAppUpdateTimer = setTimeout(() => {
    automaticAppUpdateTimer = null;
    void bootstrapConfiguredAppsForSpaces().catch((error) => {
      console.warn(`[penkra-app] Automatic App update check failed: ${formatErrorMessage(error)}`);
    });
  }, delayMs);
}

function permissionReviewUpdatesForSpace(spaceId: string | undefined) {
  if (!spaceId || !automaticAppUpdateReport) return [];
  return automaticAppUpdateReport.reviewRequired
    .filter((update) => update.spaceId === spaceId)
    .map(({ appId, installedVersion, availableVersion, permissions }) => ({
      appId,
      installedVersion,
      availableVersion,
      permissions,
    }));
}

async function notifyOpenAppsInstallationState(): Promise<void> {
  const runtime = desktopAppRuntime;
  if (!runtime) return;
  await Promise.all(
    runtime.appTabs
      .list()
      .filter((tab) => tab.appId === "com.penkra.apps")
      .map(async (tab) => {
        const snapshot = await toDesktopAppInstallationSnapshot(
          runtime.installations.snapshot(),
          tab.spaceId,
          permissionReviewUpdatesForSpace(tab.spaceId),
        );
        const contents = runtime.appTabs.observationWebContents(tab.id);
        if (!contents.isDestroyed()) contents.send(IPC.appInstallations.state, snapshot);
      }),
  );
}

function bootstrapConfiguredAppsForSpaces(): Promise<void> {
  const operation = async () => {
    const runtime = desktopAppRuntime;
    if (!runtime) return;
    const spaceIds = spacesMenuState.spaces.map((space) => space.id);
    if (spaceIds.length === 0) return;
    await reconcileConfiguredRequiredApps(spaceIds);
    const registry = appRegistryClient;
    if (registry && (await getPenkraAccountId())) {
      try {
        await bootstrapDefaultRegistryApps({
          runtime,
          registry,
          hostVersion: app.getVersion(),
          spaceIds,
        });
        automaticAppUpdateReport = await reconcileAutomaticRegistryAppUpdates({
          runtime,
          registry,
          hostVersion: app.getVersion(),
          spaceIds,
        });
        for (const update of automaticAppUpdateReport.updated) {
          console.info(
            `[penkra-app] Automatically updated ${update.appId} in Space ${update.spaceId} from ${update.fromVersion} to ${update.toVersion}.`,
          );
        }
        for (const failure of automaticAppUpdateReport.failures) {
          console.warn(
            `[penkra-app] Automatic update for ${failure.appId} in Space ${failure.spaceId} failed; the working ${failure.installedVersion} installation remains active: ${failure.error.message}`,
          );
          try {
            await runtime.diagnostics.record({
              kind: "app-update-failed",
              appId: failure.appId,
              spaceId: failure.spaceId,
              operation: "automatic-update",
              message: `${failure.error.message} Working version ${failure.installedVersion} remains active.`,
            });
          } catch (diagnosticError) {
            console.warn(
              `[penkra-app] Unable to persist automatic update diagnostics: ${formatErrorMessage(diagnosticError)}`,
            );
          }
        }
        await notifyOpenAppsInstallationState();
        scheduleAutomaticAppUpdateCheck(
          automaticAppUpdateReport.failures.some((failure) => failure.retryable)
            ? AUTOMATIC_APP_UPDATE_FAILURE_RETRY_MS
            : AUTOMATIC_APP_UPDATE_INTERVAL_MS,
        );
      } catch (error) {
        scheduleAutomaticAppUpdateCheck(AUTOMATIC_APP_UPDATE_FAILURE_RETRY_MS);
        throw error;
      }
    }
  };
  const result = configuredAppBootstrapQueue.then(operation);
  configuredAppBootstrapQueue = result.catch(() => undefined);
  return result;
}

async function reconcileConfiguredRequiredApps(spaceIds: ReadonlyArray<string>): Promise<void> {
  const runtime = desktopAppRuntime;
  const embedded =
    requiredAppsPackage ??
    (requiredAppsPackageLoad === null ? null : await requiredAppsPackageLoad);
  if (!runtime || !embedded) {
    const error = new Error("The embedded required Apps package is unavailable.");
    handleFatalStartupError("required Apps", error);
    throw error;
  }
  try {
    await reconcileRequiredAppsForSpaces({
      runtime,
      requiredPackage: embedded,
      hostVersion: app.getVersion(),
      spaceIds,
      allowDevelopmentSideload: isDevelopment,
      developmentSourcePackage: requiredAppsPackageIsDevelopmentSource,
    });
  } catch (error) {
    handleFatalStartupError("required Apps", error);
    throw error;
  }
}

async function openPenkraResource(input: {
  path?: string;
  url?: string;
  requestedApp?: string;
  spaceId: string;
  threadId: string;
  callerKind?: "agent" | "user";
}): Promise<unknown> {
  const runtime = desktopAppRuntime;
  if (!runtime) throw new Error("The App runtime is not ready.");
  if (input.url) {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS URLs can be opened.");
    }
    const intent = "open-url" as const;
    const preferredAppId = runtime.openWith.get(input.spaceId, intent);
    const resolved = runtime.intents.resolve(input.spaceId, {
      intent,
      url: url.href,
      ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
      ...(preferredAppId ? { preferredAppId } : {}),
    });
    if (!resolved) {
      await shell.openExternal(url.href);
      return { destination: "system", intent, url: url.href };
    }
    const result = await runtime.broker.invoke({
      app: resolved.slug,
      operation: resolved.operation,
      input: { url: url.href },
      spaceId: input.spaceId,
      threadId: input.threadId,
      callerKind: input.callerKind ?? "agent",
    });
    return {
      destination: "app",
      appId: resolved.appId,
      slug: resolved.slug,
      intent,
      result,
    };
  }

  if (!input.path || !Path.isAbsolute(input.path)) {
    throw new Error("Penkra open requires a validated absolute path.");
  }
  const path = await FS.promises.realpath(input.path);
  const stats = await FS.promises.stat(path);
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (!kind) throw new Error("Only regular files and directories can be opened.");
  const intent = kind === "directory" ? ("open-directory" as const) : ("open-file" as const);
  if (input.requestedApp) {
    throw new Error(
      "Local paths cannot be handed to an App without a browser-native filesystem picker.",
    );
  }
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
  return { destination: "system", intent, path };
}

let backendAuthToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
// Guards every blocking backend-lifecycle dialog (startup block, give-up) so a
// crash loop can never stack modal windows on top of each other.
let backendLifecycleDialogInFlight: Promise<void> | null = null;
let backendListeningDetector: ServerListeningDetector | null = null;
const backendSupervision = new BackendSupervisionPolicy();
// Survives window recreation on purpose: a renderer that keeps dying must not refill
// its reload budget just because the crash produced a new window.
const rendererCrashPolicy = new RendererCrashPolicy();
let rendererCrashDialogInFlight: Promise<void> | null = null;
let lastBackendFailureDetail: string | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let isUpdaterInstallPreparing = false;
let isUpdaterQuitAndInstallInFlight = false;
const updateInstallPreparation = makeUpdateInstallPreparationCoordinator();
let desktopShutdownPromise: Promise<void> | null = null;
let desktopStartupBlockedForMigrationRecovery = false;
let desktopShutdownComplete = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let appUpdateYmlCache: Record<string, string> | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let unreadBackgroundNotificationCount = 0;
let browserPerfInterval: ReturnType<typeof setInterval> | null = null;
const browserManager = new DesktopBrowserManager({
  beforeInputEvent: (event, input) => {
    if (
      isKeyboardShortcutsHelpChord(
        {
          type: input.type,
          key: input.key,
          code: input.code,
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          repeat: input.isAutoRepeat,
        },
        {
          isMac: desktopPlatform.platform === "darwin",
          isWindows: desktopPlatform.platform === "win32",
        },
      )
    ) {
      event.preventDefault();
      dispatchMenuAction("show-shortcuts");
      return true;
    }

    return handleDesktopWindowZoomShortcut(event, input);
  },
  getWindowZoomFactor: () => mainWindow?.webContents.getZoomFactor() ?? 1,
});
let appCommandPipeServer: AppCommandPipeServer | null = null;
const appBrowserViewportByRendererId = new Map<
  number,
  { x: number; y: number; width: number; height: number }
>();
const appBrowserTrackedRendererIds = new Set<number>();
let configuredUpdaterCacheDirName: string | null = null;

browserManager.subscribe((state) => {
  const runtime = desktopAppRuntime;
  if (!runtime) return;
  const appState = toAppBrowserState(state);
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const identity = runtime.rendererIdentity(contents.id);
    if (identity?.tabId === state.threadId) {
      contents.send(IPC.appRuntime.browserState, appState);
    }
  }
});

function toAppBrowserState(
  state: ThreadBrowserState,
): import("@penkra/sdk").AppBrowserSessionState {
  return {
    version: state.version,
    open: state.open,
    activePageId: state.activeTabId,
    pages: state.tabs,
    lastError: state.lastError,
  };
}

function hideHostedBrowserViewport(rendererId: number): void {
  const identity = desktopAppRuntime?.rendererIdentity(rendererId);
  if (!identity?.tabId) return;
  const threadId = identity.tabId as ThreadId;
  if (browserManager.hasSession(threadId)) {
    browserManager.setHostedPanelBounds({
      threadId,
      bounds: null,
      hostBounds: null,
      parentView: null,
    });
  }
}

function syncHostedBrowserViewport(rendererId: number): void {
  const runtime = desktopAppRuntime;
  const identity = runtime?.rendererIdentity(rendererId);
  const local = appBrowserViewportByRendererId.get(rendererId);
  const host = runtime?.appTabs.rendererBounds(rendererId);
  const parentView = runtime?.appTabs.rendererView(rendererId) ?? null;
  if (!identity?.tabId || !local || !host || !parentView) return;
  browserManager.setHostedPanelBounds({
    threadId: identity.tabId as ThreadId,
    parentView,
    hostBounds: normalizeHostedBrowserViewportBounds(host),
    bounds: normalizeHostedBrowserViewportBounds(local),
  });
}

function startBrowserPerformanceLogging(): void {
  if (browserPerfInterval || !browserPerfLoggingEnabled) {
    return;
  }

  browserPerfInterval = setInterval(() => {
    const snapshot = browserManager.getPerformanceSnapshot();
    const trackedProcessIds = new Set(snapshot.trackedProcessIds);
    const processMetrics = app
      .getAppMetrics()
      .filter((metric) => trackedProcessIds.has(metric.pid))
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpu: Number(metric.cpu.percentCPUUsage.toFixed(1)),
        memMb: Math.round(metric.memory.workingSetSize / 1024),
        name: metric.name,
      }));

    console.info(`[${PENKRA_BROWSER_LABEL} perf]`, {
      ...snapshot.counters,
      trackedProcessIds: snapshot.trackedProcessIds,
      processes: processMetrics,
    });
  }, BROWSER_PERF_SAMPLE_INTERVAL_MS);
  browserPerfInterval.unref();
}

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: desktopPlatform.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function safeConsoleError(...args: Parameters<typeof console.error>): void {
  try {
    console.error(...args);
  } catch (error: unknown) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function getDesktopWindowState(window: BrowserWindow): {
  isMaximized: boolean;
  isFullscreen: boolean;
} {
  return {
    isMaximized: window.isMaximized(),
    isFullscreen: window.isFullScreen(),
  };
}

function emitDesktopWindowState(window: BrowserWindow | null = mainWindow): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.windowState, getDesktopWindowState(window));
}

function isSaveFileInput(input: unknown): input is {
  defaultFilename: string;
  contents: string;
  filters?: FileFilter[];
} {
  if (!input || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.defaultFilename !== "string" || record.defaultFilename.trim().length === 0) {
    return false;
  }
  if (typeof record.contents !== "string") {
    return false;
  }
  if (record.filters === undefined) {
    return true;
  }
  if (!Array.isArray(record.filters)) {
    return false;
  }
  return record.filters.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const filterRecord = filter as Record<string, unknown>;
    return (
      typeof filterRecord.name === "string" &&
      Array.isArray(filterRecord.extensions) &&
      filterRecord.extensions.every((extension) => typeof extension === "string")
    );
  });
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function reserveBackendEndpoint(reason: string): Promise<void> {
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  backendHttpUrl = `http://127.0.0.1:${backendPort}`;
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.PENKRA_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`${reason} resolved backend endpoint port=${backendPort}`);
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  return await waitForBackendStartupReady({
    listeningPromise: backendListeningDetector?.promise ?? null,
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        path: "/health",
        timeoutMs: 60_000,
        isReady: async (response) => {
          if (!response.ok) {
            return false;
          }
          try {
            const payload = (await response.json()) as {
              startupReady?: unknown;
            };
            return payload.startupReady === true;
          } catch {
            return false;
          }
        },
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
}

function ensureInitialBackendWindowOpen(baseUrl: string): void {
  openInitialBackendWindow({
    isDevelopment,
    baseUrl,
    hasExistingWindow: () => (mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null) !== null,
    createWindow: () => {
      mainWindow = createWindow();
    },
    getReadinessInFlight: () => backendInitialWindowOpenInFlight,
    setReadinessInFlight: (promise) => {
      backendInitialWindowOpenInFlight = promise;
    },
    waitForBackendWindowReady,
    writeLog: writeDesktopLogHeader,
    isReadinessAborted: isBackendReadinessAborted,
    formatErrorMessage,
    warn: (message, error) => {
      console.warn(message, error);
    },
  });
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (desktopPlatform.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let activeUpdateCheck: Promise<void> | null = null;
let settleActiveUpdateCheck: (() => void) | null = null;
let activeUpdatePreparation: Promise<void> | null = null;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let updateBackgroundedAtMs: number | null = null;
let updateBackgroundBlurTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let updateDownloadStallTimer: ReturnType<typeof setTimeout> | null = null;
let updateInstallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let automaticUpdateActivitySuppressed = false;
let updateDownloadCancellationToken: CancellationToken | null = null;
let rejectUpdateDownloadStall: ((error: Error) => void) | null = null;
let lastUpdateDownloadProgressSample: DownloadProgressSample | null = null;
let stalledDownloadCancellationSuppressionsRemaining = 0;
let stalledDownloadCancellationSuppressionExpiresAtMs = 0;
let downloadedUpdateArtifact: {
  readonly version: string;
  readonly identity: UpdateArtifactIdentity;
} | null = null;
let downloadedUpdateIdentityTask: Promise<void> | null = null;
let activeUpdateInstallHandoff: UpdateInstallHandoffExpectation | null = null;
const pendingUpdateCacheClearQueue = new PendingUpdateCacheClearQueue();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (isUpdaterInstallPreparing || isUpdaterQuitAndInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

function clearUpdaterInstallInFlightAfterError(input?: {
  readonly preservePendingPreparation?: boolean;
}): boolean {
  const preparationCancelled = updateInstallPreparation.cancel();
  if (preparationCancelled && input?.preservePendingPreparation) {
    return true;
  }
  if (!isUpdaterInstallPreparing && !isUpdaterQuitAndInstallInFlight) {
    return preparationCancelled;
  }
  isUpdaterInstallPreparing = false;
  isUpdaterQuitAndInstallInFlight = false;
  activeUpdateInstallHandoff = null;
  isQuitting = false;
  return preparationCancelled;
}

function clearUpdateInstallWatchdogTimer(): void {
  if (updateInstallWatchdogTimer) {
    clearTimeout(updateInstallWatchdogTimer);
    updateInstallWatchdogTimer = null;
  }
}

function getUpdateInstallMarkerPath(): string {
  return Path.join(app.getPath("userData"), UPDATE_INSTALL_MARKER_FILE_NAME);
}

function recordInstallMarkerFailure(
  nowIso: string,
  expected: UpdateInstallHandoffExpectation | null,
): number {
  if (!expected) {
    console.error(
      "[desktop-updater] Could not record durable install failure without an exact active attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  const result = recordInstallMarkerFailureSync(getUpdateInstallMarkerPath(), expected, nowIso);
  if (result.status === "missing" || result.status === "invalid") {
    console.error(
      `[desktop-updater] Could not record durable install failure: marker is ${result.status}${result.status === "invalid" ? ` (${result.error})` : ""}.`,
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "mismatch") {
    console.error(
      "[desktop-updater] Refusing to record install failure against a different durable attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "write-failed") {
    console.error(
      `[desktop-updater] Failed to persist install failure marker: ${formatErrorMessage(result.error)}`,
    );
  }
  return result.marker.consecutiveFailures;
}

async function logMacUpdateDiagnostics(context: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const diagnostics = await Promise.race([
      collectMacUpdateDiagnostics(APP_USER_MODEL_ID),
      new Promise<string>((resolve) => {
        timeout = setTimeout(
          () => resolve("Diagnostic collection timed out."),
          AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS,
        );
      }),
    ]);
    if (diagnostics) {
      console.info(`[desktop-updater] diagnostics (${context})\n${diagnostics}`);
    }
  } catch (error) {
    console.info(
      `[desktop-updater] diagnostics (${context}) unavailable: ${formatErrorMessage(error)}`,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// quitAndInstall() is a fire-and-forget void call with no success signal: when
// the OS installer silently fails the app never quits and the user is left with
// no feedback (the "update doesn't work for some people" report). If the process
// is still alive after the watchdog window, recover and surface an actionable
// install failure so the UI can offer the manual-download fallback.
function armInstallWatchdog(): void {
  clearUpdateInstallWatchdogTimer();
  updateInstallWatchdogTimer = setTimeout(() => {
    updateInstallWatchdogTimer = null;
    if (!isUpdaterQuitAndInstallInFlight) {
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    clearUpdaterInstallInFlightAfterError();
    // The backend was already stopped before quitAndInstall(); since the app is
    // not actually quitting, bring it back so the recovered app is functional
    // (renderer reconnects) instead of a zombie window with a dead backend.
    startBackend();
    // Polling was stopped before the install attempt; resume it so background
    // update checks keep running after this recovery.
    scheduleUpdatePoll();
    const consecutiveFailures = recordInstallMarkerFailure(new Date().toISOString(), failedHandoff);
    setUpdateState({
      ...reduceDesktopUpdateStateOnInstallFailure(
        updateState,
        "The update couldn’t be installed automatically.",
      ),
      installFailureCount: consecutiveFailures,
    });
    console.error(
      "[desktop-updater] quitAndInstall did not exit the app within the watchdog window; surfacing manual-download fallback.",
    );
  }, AUTO_UPDATE_INSTALL_WATCHDOG_MS);
}

protocol.registerSchemesAsPrivileged([...createDesktopPrivilegedSchemes(desktopIdentity)]);

function resolveAppRoot(): string {
  return resolveDesktopAppRoot({
    isPackagedRuntime,
    sourceRoot: ROOT_DIR,
    packagedAppRoot: app.getAppPath(),
  });
}

/**
 * Read the baked-in app-update.yml config (if applicable). The file ships inside
 * the package and never changes at runtime, so the parsed result is cached to keep
 * repeated callers off the synchronous-FS path on the main thread.
 */
function readAppUpdateYml(): Record<string, string> | null {
  if (appUpdateYmlCache !== undefined) {
    return appUpdateYmlCache;
  }
  appUpdateYmlCache = parseAppUpdateYml();
  return appUpdateYmlCache;
}

function parseAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { penkraCommitHash?: unknown };
    return normalizeCommitHash(parsed.penkraCommitHash);
  } catch {
    return null;
  }
}

declare const __PENKRA_REGISTRY_TRUSTED_KEYS__: string;

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.PENKRA_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function desktopMigrationRecoveryPaths(): DesktopMigrationRecoveryPaths {
  return resolveDesktopMigrationRecoveryPaths({
    baseDir: BASE_DIR,
    appRoot: resolveAppRoot(),
    isDevelopment,
  });
}

function isDesktopMigrationRecoveryPending(): boolean {
  try {
    // Deliberately not "a marker exists": while the backend still has resume
    // attempts left, a failed start is an ordinary restart, not a recovery
    // prompt. Escalating early would bury the self-heal under a dialog.
    return requiresDesktopMigrationRecovery(desktopMigrationRecoveryPaths());
  } catch (error) {
    // An unreadable marker path must not break crash supervision.
    writeDesktopLogHeader(
      `migration recovery marker check failed message=${formatErrorMessage(error)}`,
    );
    return false;
  }
}

/** Joins user-facing options as "a, b or c". */
function formatRecoveryOptionList(options: ReadonlyArray<string>): string {
  if (options.length <= 1) return options[0] ?? "";
  return `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;
}

async function handleDesktopMigrationRecovery(): Promise<DesktopMigrationRecoveryOutcome> {
  const paths = desktopMigrationRecoveryPaths();
  desktopStartupBlockedForMigrationRecovery = true;
  const outcome = await recoverDesktopMigrationIfRequired({
    // The gate opens only once the backend has spent its resume budget, while
    // the post-restore verification checks the marker file itself.
    requiresRecovery: () => requiresDesktopMigrationRecovery(paths),
    markerRemains: () => hasPendingDesktopMigrationRecovery(paths),
    choose: async ({ previousFailure }) => {
      // The user is here because Penkra cannot open its database, so the
      // in-app update button is unreachable by definition. A newer build is
      // often the actual fix, and this dialog is the only surface left to
      // offer it from: installing it in place when the updater can reach the
      // feed, and handing over the download page otherwise.
      const releaseUrl = updateState.releaseUrl;
      const canInstallUpdate = canInstallUpdateFromRecovery();
      const restoreFailed = previousFailure?.attempt === "restore";
      const choices: Array<{
        readonly label: string;
        readonly detail: string;
        readonly decision: DesktopMigrationRecoveryDecision;
      }> = [
        restoreFailed
          ? {
              label: "Try restore again",
              detail: "retry the verified backup restore",
              decision: "restore",
            }
          : {
              label: "Restore backup and restart",
              detail: "restore the verified pre-migration backup and restart",
              decision: "restore",
            },
      ];
      if (canInstallUpdate) {
        choices.push({
          label: "Update Penkra and restart",
          detail: "install the newest Penkra release, which may already contain the fix",
          decision: "install-update",
        });
      }
      if (releaseUrl !== null) {
        choices.push({
          label: "Download latest release",
          detail: `${canInstallUpdate ? "download that release" : "download the latest Penkra release"} in a browser`,
          decision: "open-release-page",
        });
      }
      choices.push({
        label: "Quit",
        detail: "quit without opening the database",
        decision: "quit",
      });

      const options = formatRecoveryOptionList(choices.map((choice) => choice.detail));
      const result = await dialog.showMessageBox({
        type: previousFailure === null ? "warning" : "error",
        title:
          previousFailure === null
            ? "Penkra needs to recover its database"
            : restoreFailed
              ? "Migration recovery failed"
              : "Penkra could not update itself",
        message:
          previousFailure === null
            ? "Penkra stopped a database migration before it could finish safely."
            : restoreFailed
              ? "The saved database backup could not be restored."
              : "The newest Penkra release could not be installed.",
        detail: `${previousFailure === null ? "" : `${previousFailure.message}\n\n`}You can ${options}. No provider or chat process will start until recovery succeeds.`,
        buttons: choices.map((choice) => choice.label),
        defaultId: 0,
        cancelId: choices.length - 1,
        noLink: true,
      });
      return choices[result.response]?.decision ?? "quit";
    },
    installUpdate: installLatestUpdateForMigrationRecovery,
    openReleasePage: () => {
      const releaseUrl = updateState.releaseUrl;
      if (releaseUrl !== null) void shell.openExternal(releaseUrl);
    },
    restore: () =>
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: backendNodeArgs(),
        paths,
        cwd: resolveBackendCwd(),
        env: process.env,
      }),
    requestRestart: () => app.relaunch(),
    requestQuit: (reason) => requestGracefulAppQuit(reason),
    formatError: formatErrorMessage,
    log: writeDesktopLogHeader,
  });
  if (outcome === "continue") {
    desktopStartupBlockedForMigrationRecovery = false;
  }
  return outcome;
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

interface ServedStaticRoot {
  readonly dir: string;
  /** True when serving a real-disk snapshot instead of reading through the asar. */
  readonly snapshotted: boolean;
}

interface BundleIdentity {
  readonly path: string;
  readonly signature: BundleSignature | null;
}

class BundleChangedDuringStartupError extends Error {
  readonly bundlePath: string;
  readonly baseline: BundleSignature | null;
  readonly current: BundleSignature | null;

  constructor(input: {
    bundlePath: string;
    baseline: BundleSignature | null;
    current: BundleSignature | null;
  }) {
    super("The packaged application changed while its static assets were being prepared.");
    this.name = "BundleChangedDuringStartupError";
    this.bundlePath = input.bundlePath;
    this.baseline = input.baseline;
    this.current = input.current;
  }
}

let servedStaticRootCache: ServedStaticRoot | null | undefined;

// Serving static assets straight out of app.asar is vulnerable to the archive
// being replaced beneath the running app (Electron caches the header per process,
// so every later read returns bytes from the wrong offsets). Extract the client
// to a per-archive snapshot on real disk and serve that instead — both for the
// penkra:// protocol here and, via PENKRA_STATIC_DIR, for the backend's HTTP static
// route. Memoized so one app run serves one coherent asset generation.
function resolveServedStaticRoot(): ServedStaticRoot | null {
  if (servedStaticRootCache === undefined) {
    servedStaticRootCache = computeServedStaticRoot();
  }
  return servedStaticRootCache;
}

function computeServedStaticRoot(): ServedStaticRoot | null {
  const sourceDir = resolveDesktopStaticDir();
  if (!sourceDir) {
    return null;
  }
  const archivePath = findAsarArchivePath(sourceDir);
  if (!archivePath) {
    // Plain-directory client (dev, unpacked build): real files already survive swaps.
    return { dir: sourceDir, snapshotted: false };
  }
  const startupArchiveSignature =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(archivePath)
      ? startupBundleIdentity.signature
      : undefined;
  if (startupArchiveSignature === null) {
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: null,
      current: readBundleSignature(archivePath),
    });
  }
  const archiveSignature = startupArchiveSignature ?? readBundleSignature(archivePath);
  if (!archiveSignature) {
    return { dir: sourceDir, snapshotted: false };
  }
  const startedAtMs = Date.now();
  let snapshot: ReturnType<typeof ensureStaticSnapshot>;
  try {
    snapshot = ensureStaticSnapshot({
      sourceDir,
      cacheRoot: Path.join(app.getPath("userData"), "static-snapshots"),
      signature: `${archiveSignature.size}-${archiveSignature.mtimeMs}-${archiveSignature.inode}`,
    });
  } catch (error) {
    const currentArchiveSignature = readBundleSignature(archivePath);
    if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
      throw new BundleChangedDuringStartupError({
        bundlePath: archivePath,
        baseline: archiveSignature,
        current: currentArchiveSignature,
      });
    }
    console.warn(
      "[desktop] Failed to snapshot static assets; serving from the archive",
      formatErrorMessage(error),
    );
    return { dir: sourceDir, snapshotted: false };
  }

  const currentArchiveSignature = readBundleSignature(archivePath);
  if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
    // A newly-created snapshot may contain reads from both archive generations.
    // Never leave it behind for a future launch to reuse.
    if (!snapshot.reused) {
      try {
        FS.rmSync(snapshot.dir, { recursive: true, force: true });
      } catch {
        // The signature changes the snapshot key, so failed cleanup is disk waste
        // rather than a path the replacement generation can accidentally reuse.
      }
    }
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: archiveSignature,
      current: currentArchiveSignature,
    });
  }

  writeDesktopLogHeader(
    `static snapshot ${snapshot.reused ? "reused" : "created"} dir=${snapshot.dir} in ${Date.now() - startedAtMs}ms`,
  );
  return { dir: snapshot.dir, snapshotted: true };
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("Penkra failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  if (desktopPlatform.processLifecycle.backendShutdown === "windows-control") {
    requestGracefulAppQuit(`fatal startup (${stage})`);
    return;
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if ((isDevelopment && !desktopSmokeUserDataPath) || desktopProtocolRegistered) return;

  // An unreadable first observation cannot be replaced by a later baseline:
  // Electron may already hold the header for the generation that disappeared.
  if (startupBundleIdentity && !startupBundleIdentity.signature) {
    throw new BundleChangedDuringStartupError({
      bundlePath: startupBundleIdentity.path,
      baseline: null,
      current: readBundleSignature(startupBundleIdentity.path),
    });
  }

  const staticRoot = resolveServedStaticRoot()?.dir ?? null;
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const resolveStaticRequest = createDesktopStaticProtocolResolver(staticRoot);

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    callback(resolveStaticRequest(request.url));
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(IPC.menuAction, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function resolveMenuTargetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function sendDesktopZoomFactor(webContents: Electron.WebContents): void {
  if (webContents.isDestroyed()) return;
  webContents.send(IPC.zoomFactorChanged, webContents.getZoomFactor());
}

function attachDesktopZoomFactorSync(window: BrowserWindow): void {
  const notify = () => sendDesktopZoomFactor(window.webContents);
  window.webContents.on("zoom-changed", notify);
  window.webContents.on("did-finish-load", notify);
}

function setWindowZoomFactor(zoomFactor: number): void {
  const window = resolveMenuTargetWindow();
  if (!window || window.isDestroyed()) return;
  const nextZoomFactor = Math.min(
    DESKTOP_MENU_MAX_ZOOM_FACTOR,
    Math.max(DESKTOP_MENU_MIN_ZOOM_FACTOR, zoomFactor),
  );
  window.webContents.setZoomFactor(nextZoomFactor);
  desktopAppRuntime?.appTabs.setZoomFactor(nextZoomFactor);
  browserManager.setZoomFactor(nextZoomFactor);
  sendDesktopZoomFactor(window.webContents);
}

function applyDesktopWindowZoomAction(
  action: Exclude<ReturnType<typeof resolveDesktopWindowZoomAction>, null>,
): void {
  const currentZoomFactor = resolveMenuTargetWindow()?.webContents.getZoomFactor();
  if (!currentZoomFactor) return;
  if (action === "reset") {
    setWindowZoomFactor(1);
    return;
  }
  setWindowZoomFactor(
    currentZoomFactor *
      (action === "zoomIn" ? DESKTOP_MENU_ZOOM_FACTOR_STEP : 1 / DESKTOP_MENU_ZOOM_FACTOR_STEP),
  );
}

function handleDesktopWindowZoomShortcut(event: Electron.Event, input: Electron.Input): boolean {
  const action = resolveDesktopWindowZoomAction(desktopPlatform.platform, input);
  if (!action) return false;

  event.preventDefault();
  applyDesktopWindowZoomAction(action);
  return true;
}

function attachDesktopWindowZoomShortcuts(webContents: Electron.WebContents): () => void {
  const beforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
    handleDesktopWindowZoomShortcut(event, input);
  };
  webContents.on("before-input-event", beforeInputEvent);
  return () => webContents.removeListener("before-input-event", beforeInputEvent);
}

function resetWindowZoomFromMenu(): void {
  setWindowZoomFactor(1);
}

function adjustWindowZoomFromMenu(multiplier: number): void {
  const zoomFactor = resolveMenuTargetWindow()?.webContents.getZoomFactor();
  if (!zoomFactor) return;
  setWindowZoomFactor(zoomFactor * multiplier);
}

// A configured app-update.yml (or the mock-updates flag) is the prerequisite for any
// auto-update activity; centralized so the menu and the enable check stay in lockstep.
function hasConfiguredUpdateFeed(): boolean {
  return readAppUpdateYml() !== null || Boolean(process.env.PENKRA_DESKTOP_MOCK_UPDATES);
}

function resolveAutoUpdateDisabledReason(): string | null {
  if (desktopPlatform.updater.disabledReason) return desktopPlatform.updater.disabledReason;
  return getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: desktopPlatform.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.PENKRA_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasConfiguredUpdateFeed(),
  });
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = resolveAutoUpdateDisabledReason();
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Penkra ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "downloading" || updateState.status === "available") {
    void dialog.showMessageBox({
      type: "info",
      title: "Update found",
      message: "Penkra is preparing the update in the background.",
      buttons: ["OK"],
    });
  } else if (updateState.status === "downloaded") {
    void dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: "Click Update in the sidebar when you’re ready to restart and install it.",
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  const keyboardShortcutsAccelerator = resolveKeyboardShortcutsMenuAccelerator(
    desktopPlatform.platform,
  );
  const acceleratorProps = (
    accelerator: MenuItemConstructorOptions["accelerator"],
  ): Pick<MenuItemConstructorOptions, "accelerator"> => {
    const resolved = resolveDesktopMenuAccelerator(desktopPlatform.platform, accelerator);
    return resolved ? { accelerator: resolved } : {};
  };
  // Native zoom roles target whichever WebContents has focus. Penkra presents its
  // shell and hosted App views as one window, so all zoom entry points route through
  // the main-process window coordinator instead.
  const zoomMenuItems: MenuItemConstructorOptions[] = [
    {
      label: "Reset Zoom",
      ...acceleratorProps("CmdOrCtrl+0"),
      click: () => resetWindowZoomFromMenu(),
    },
    {
      label: "Zoom In",
      ...acceleratorProps("CmdOrCtrl+="),
      click: () => adjustWindowZoomFromMenu(DESKTOP_MENU_ZOOM_FACTOR_STEP),
    },
    {
      label: "Zoom In",
      ...acceleratorProps("CmdOrCtrl+Plus"),
      visible: false,
      click: () => adjustWindowZoomFromMenu(DESKTOP_MENU_ZOOM_FACTOR_STEP),
    },
    {
      label: "Zoom Out",
      ...acceleratorProps("CmdOrCtrl+-"),
      click: () => adjustWindowZoomFromMenu(1 / DESKTOP_MENU_ZOOM_FACTOR_STEP),
    },
  ];

  if (desktopPlatform.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(desktopPlatform.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                ...acceleratorProps("CmdOrCtrl+,"),
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: desktopPlatform.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          ...acceleratorProps("CmdOrCtrl+B"),
          click: () => dispatchMenuAction("toggle-sidebar"),
        },
        {
          label: "Toggle Browser",
          ...acceleratorProps("CmdOrCtrl+Shift+B"),
          click: () => dispatchMenuAction("toggle-browser"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomMenuItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Spaces",
      submenu: [
        {
          label: "New Space...",
          click: () => dispatchMenuAction("space:new"),
        },
        ...(spacesMenuState.spaces.length > 0
          ? [
              { type: "separator" as const },
              ...spacesMenuState.spaces.map((space) => ({
                label: space.name,
                type: "checkbox" as const,
                checked: space.id === spacesMenuState.activeSpaceId,
                click: () => dispatchMenuAction(`space:focus:${space.id}`),
              })),
            ]
          : []),
        { type: "separator" },
        {
          label: "Manage Spaces...",
          click: () => dispatchMenuAction("space:manage"),
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          ...(keyboardShortcutsAccelerator ? { accelerator: keyboardShortcutsAccelerator } : {}),
          click: () => dispatchMenuAction("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function resolveNotificationIconPath(): string | null {
  if (desktopPlatform.notifications.icon === "bundle") {
    return null;
  }
  if (desktopPlatform.notifications.icon === "ico") {
    return resolveResourcePath("penkra.png") ?? resolveIconPath("ico");
  }
  return resolveResourcePath("penkra.png") ?? resolveIconPath("png");
}

// Keep the app badge aligned with desktop notifications that arrive off-focus.
function syncUnreadNotificationBadge(): void {
  app.setBadgeCount(unreadBackgroundNotificationCount);
}

// Count minimized, hidden, or unfocused windows as background notification targets.
function isMainWindowForeground(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  return window.isVisible() && !window.isMinimized() && window.isFocused();
}

function incrementUnreadNotificationBadge(): void {
  unreadBackgroundNotificationCount = Math.min(unreadBackgroundNotificationCount + 1, 99);
  syncUnreadNotificationBadge();
}

function clearUnreadNotificationBadge(): void {
  if (unreadBackgroundNotificationCount === 0) {
    return;
  }
  unreadBackgroundNotificationCount = 0;
  syncUnreadNotificationBadge();
}

// Reuse the existing desktop window when the app is launched again so users
// don't end up with multiple packaged instances racing the same local state.
function focusMainWindow(options: { stealAppFocus?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (desktopPlatform.application.activateBeforeFocus && options.stealAppFocus === true) {
    // BrowserWindow.focus() alone does not activate a macOS app while another
    // application owns focus.
    app.show();
    app.focus({ steal: true });
  }
  mainWindow.focus();
}

// Show a native OS notification and refocus the app window when the alert is clicked.
function showDesktopNotification(input: {
  title: string;
  body?: string;
  silent?: boolean;
  threadId?: string;
}): boolean {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (title.length === 0 || !Notification.isSupported()) {
    return false;
  }

  const iconPath = resolveNotificationIconPath();
  const notification = new Notification({
    title,
    body,
    silent: input.silent === true,
    ...(iconPath ? { icon: iconPath } : {}),
  });
  if (!isMainWindowForeground(mainWindow)) {
    incrementUnreadNotificationBadge();
  }

  notification.on("click", () => {
    clearUnreadNotificationBadge();
    focusMainWindow();
    if (!mainWindow) {
      return;
    }
    if (threadId.length > 0) {
      mainWindow.webContents.send(IPC.menuAction, `notification-open-thread:${threadId}`);
    }
  });

  notification.show();
  return true;
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json. We override it to a clean lowercase Penkra name.
 */
function resolveUserDataPath(): string {
  const appDataBase = resolveDesktopAppDataBase();
  return resolveDesktopUserDataPath({
    appDataBase,
    userDataDirectoryName: desktopIdentity.userDataDirectoryName,
  });
}

function repairBrowserProfileBeforeElectronReady(userDataPath: string): void {
  const browserProfileRepair = repairBrowserProfileFromBridgeManifest(userDataPath);
  if (browserProfileRepair.status === "repaired") {
    console.info("[desktop] Completed Penkra browser profile bridge repair", {
      sourcePath: browserProfileRepair.sourcePath,
      targetPath: browserProfileRepair.targetPath,
      copiedEntries: browserProfileRepair.copiedEntries,
    });
  } else if (browserProfileRepair.status === "repair-failed") {
    console.warn("[desktop] Failed to complete Penkra browser profile bridge repair", {
      sourcePath: browserProfileRepair.sourcePath,
      targetPath: browserProfileRepair.targetPath,
      error: browserProfileRepair.error,
    });
  }
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
    copyright: `© ${new Date().getFullYear()} Emmanuel Gyekye Atta-Penkra`,
  });

  if (desktopPlatform.application.setWindowsAppUserModelId) {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

// The packaged bundle icon is a solid, pre-rounded ICNS so Tahoe does not reinterpret
// the mark as Icon Composer glass. Older macOS gets the same literal rounded artwork as
// a runtime dock override because it does not apply the modern system mask itself.
function applyLegacyMacDockIcon(): void {
  if (!desktopPlatform.icons.legacyDockOverride || !app.dock) {
    return;
  }
  const darwinMajor = Number.parseInt(OS.release().split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor) || darwinMajor >= 25) {
    return;
  }
  const iconPath = resolveResourcePath("dock-icon.png");
  if (!iconPath) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return;
  }
  app.dock.setIcon(image);
}

function readLaunchVersionRecordContents(): string | null {
  try {
    return FS.readFileSync(resolveLaunchVersionRecordPath(app.getPath("userData")), "utf8");
  } catch {
    // No prior record (fresh profile) or an unreadable file.
    return null;
  }
}

function persistLastLaunchVersion(version: string): void {
  const recordPath = resolveLaunchVersionRecordPath(app.getPath("userData"));
  try {
    // The userData directory is not guaranteed to exist this early on a clean
    // first launch, so ensure it before writing or the record silently fails to
    // persist and the refresh re-runs on every launch.
    FS.mkdirSync(Path.dirname(recordPath), { recursive: true });
    FS.writeFileSync(recordPath, serializeLaunchVersionRecord(version));
  } catch (error) {
    console.warn("[desktop] Failed to persist last launch version", error);
  }
}

// macOS keeps an aggressive Launch Services / IconServices cache keyed by bundle
// path + identifier. electron-updater swaps the bundle in place, so after an
// update the refreshed icon.icns is already on disk while the dock and Finder
// keep painting the previous icon — most visibly on Tahoe, where we no longer
// apply a runtime dock icon (see applyLegacyMacDockIcon). When the version
// changes across launches, force Launch Services to re-read the bundle so the
// new icon shows on every surface. Best-effort: never blocks startup.
function refreshMacIconCacheOnVersionChange(): void {
  if (!desktopPlatform.icons.refreshBundleCacheAfterUpdate || !app.isPackaged) {
    return;
  }

  const currentVersion = app.getVersion();
  const previousVersion = parseLastLaunchVersion(readLaunchVersionRecordContents());
  if (!shouldRefreshIconCache(previousVersion, currentVersion)) {
    return;
  }

  // Record the new version before refreshing so a failed re-registration is not
  // retried on every launch; the icon then heals on the next version bump
  // instead of spawning lsregister each time.
  persistLastLaunchVersion(currentVersion);

  const bundlePath = resolveMacAppBundlePath(process.execPath, desktopPlatform.platform);
  if (!bundlePath || !FS.existsSync(LSREGISTER_PATH)) {
    return;
  }

  // Bump the bundle mtime so Launch Services notices the swap, then re-register
  // it. The codesign signature covers Contents, not the bundle directory mtime,
  // so this is signature-safe; the bundle may be read-only for this user, in
  // which case the re-registration below still nudges the cache.
  try {
    const now = new Date();
    FS.utimesSync(bundlePath, now, now);
  } catch {
    // Read-only bundle: fall through to lsregister.
  }

  const child = ChildProcess.spawn(LSREGISTER_PATH, ["-f", bundlePath], {
    stdio: "ignore",
  });
  child.unref();
  child.once("error", (error) => {
    console.warn("[desktop] Failed to refresh macOS icon cache after update", error);
  });
  child.once("exit", (code) => {
    console.info(
      `[desktop] Refreshed macOS icon registration after update ${previousVersion ?? "(none)"} -> ${currentVersion} (lsregister exit ${code ?? "unknown"}).`,
    );
  });
}

// How often the bundle-swap watcher stats app.asar. A stat is cheap; the cost of
// missing a swap is every subsequent asar read returning bytes from the wrong
// file (invisible icons, corrupted lazy-loaded route chunks), so poll briskly.
const BUNDLE_SWAP_POLL_INTERVAL_MS = 15_000;

let bundleSwapPollTimer: NodeJS.Timeout | null = null;
let bundleSwapPromptOpen = false;

function readBundleSignature(bundlePath: string): BundleSignature | null {
  try {
    return bundleSignatureFromStats(OriginalFS.statSync(bundlePath));
  } catch {
    return null;
  }
}

function captureStartupBundleIdentity(): BundleIdentity | null {
  if (!app.isPackaged) {
    return null;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return null;
  }
  return { path: bundlePath, signature: readBundleSignature(bundlePath) };
}

function restartAfterStartupBundleSwap(error: BundleChangedDuringStartupError): void {
  const baselineSize = error.baseline?.size ?? "unreadable";
  const currentSize = error.current?.size ?? "unreadable";
  writeDesktopLogHeader(
    `bundle changed during startup path=${error.bundlePath} size=${baselineSize}->${currentSize}`,
  );
  console.warn("[desktop] Packaged application changed during startup; restarting", error);

  void dialog
    .showMessageBox({
      type: "warning",
      title: "Penkra needs to restart",
      message: "Penkra changed while it was opening.",
      detail:
        "The current process cannot safely read the replaced application bundle. Restart Penkra to finish opening with one consistent version.",
      buttons: ["Restart Penkra"],
      defaultId: 0,
    })
    .catch(() => undefined)
    .then(() => {
      app.relaunch();
      requestGracefulAppQuit("startup-bundle-swap");
    });
}

// Electron caches the asar header per process, so once app.asar changes on disk
// (updater retry racing a relaunch, a reinstall, a build copied over the bundle)
// every archive read in this process — the penkra:// protocol, the backend's static
// files, lazily-loaded renderer chunks — resolves to stale offsets and silently
// returns the wrong bytes. Detect the swap and offer a restart; continuing is
// never safe.
function startBundleSwapWatcher(): void {
  if (!app.isPackaged || bundleSwapPollTimer) {
    return;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return;
  }
  let baseline =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(bundlePath)
      ? (startupBundleIdentity.signature ?? readBundleSignature(bundlePath))
      : readBundleSignature(bundlePath);
  if (!baseline) {
    return;
  }

  bundleSwapPollTimer = setInterval(() => {
    // The updater owns the quit/relaunch during its own install handoff, and a
    // quitting app is about to re-read the new archive anyway.
    if (isQuitting || isUpdaterInstallPreparing || bundleSwapPromptOpen) {
      return;
    }
    const current = readBundleSignature(bundlePath);
    if (!baseline || !isBundleSwapped(baseline, current)) {
      return;
    }
    writeDesktopLogHeader(
      `bundle swap detected path=${bundlePath} size=${baseline.size}->${current?.size ?? "unknown"}`,
    );
    // Re-arm on the new identity so declining the restart still catches the
    // next replacement instead of re-prompting for the same one.
    baseline = current;
    bundleSwapPromptOpen = true;
    void dialog
      .showMessageBox({
        type: "warning",
        title: "Penkra was replaced on disk",
        message: "The installed Penkra app changed while it was running.",
        detail:
          "The interface keeps running from a safeguarded copy, but parts of the app loaded later can still read the replaced file. Restart now to pick up the new version safely.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        bundleSwapPromptOpen = false;
        if (response === 0) {
          app.relaunch();
          requestGracefulAppQuit("bundle-swap-restart");
        }
      })
      .catch(() => {
        bundleSwapPromptOpen = false;
      });
  }, BUNDLE_SWAP_POLL_INTERVAL_MS);
  bundleSwapPollTimer.unref();
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

// Starts the periodic background update check. Used by configureAutoUpdater and
// by the install watchdog recovery so polling resumes after a silent install
// failure instead of staying off until the next app restart.
function scheduleUpdatePoll(): void {
  if (updatePollTimer || automaticUpdateActivitySuppressed) {
    return;
  }
  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}

function isExplicitUpdateCheckReason(reason: string): boolean {
  return (
    reason === "menu" || reason === "renderer" || reason === UPDATE_CHECK_REASON_MIGRATION_RECOVERY
  );
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(IPC.updateState, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return resolveAutoUpdateDisabledReason() === null;
}

function isKnownUpdateVersionNewer(version: string | null | undefined): boolean {
  return typeof version === "string" && isUpdateVersionNewer(app.getVersion(), version);
}

function getUpdaterCachePathArgs(): {
  cacheDirName: string | null;
  platform: NodeJS.Platform;
  homeDir: string;
  localAppData: string | null;
  xdgCacheHome: string | null;
} {
  return {
    cacheDirName: configuredUpdaterCacheDirName,
    platform: desktopPlatform.platform,
    homeDir: OS.homedir(),
    localAppData: process.env.LOCALAPPDATA ?? null,
    xdgCacheHome: process.env.XDG_CACHE_HOME ?? null,
  };
}

function getPendingUpdateCacheDir(): string | null {
  return resolveElectronUpdaterPendingCacheDir(getUpdaterCachePathArgs());
}

function clearLegacyUpdaterZipAfterVerifiedInstall(): void {
  const legacyZipPath = resolveElectronUpdaterLegacyZipPath(getUpdaterCachePathArgs());
  if (!legacyZipPath) {
    return;
  }
  try {
    FS.rmSync(legacyZipPath, { force: true });
    console.info("[desktop-updater] Cleared legacy top-level update.zip after verified install.");
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear legacy top-level update.zip: ${formatErrorMessage(error)}`,
    );
  }
}

function quarantineInstallMarker(reason: string): void {
  console.warn(`[desktop-updater] Discarding update install marker (${reason}).`);
  try {
    clearInstallMarker(getUpdateInstallMarkerPath());
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to delete quarantined update install marker: ${formatErrorMessage(error)}`,
    );
  }
}

function processInstallMarkerOnStartup(): void {
  const filePath = getUpdateInstallMarkerPath();
  const readResult = readInstallMarker(filePath);
  if (readResult.status === "missing") {
    return;
  }
  if (readResult.status === "invalid") {
    quarantineInstallMarker(`invalid or unreadable: ${readResult.error}`);
    return;
  }

  const marker = readResult.marker;
  const nowIso = new Date().toISOString();
  const outcome = resolveInstallMarkerOutcome(marker, app.getVersion(), nowIso);
  if (outcome === "success") {
    console.info(
      `[desktop-updater] Update to ${marker.toVersion} installed successfully (from ${marker.fromVersion})`,
    );
    try {
      clearInstallMarker(filePath);
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to clear successful update install marker: ${formatErrorMessage(error)}`,
      );
    }
    clearLegacyUpdaterZipAfterVerifiedInstall();
    return;
  }
  if (outcome === "stale" || outcome === "invalid") {
    quarantineInstallMarker(outcome);
    return;
  }

  let consecutiveFailures = marker.consecutiveFailures;
  if (outcome === "failure") {
    consecutiveFailures += 1;
    const failedMarker: UpdateInstallMarker = {
      ...marker,
      phase: "failed",
      consecutiveFailures,
      lastFailureAt: nowIso,
    };
    try {
      writeInstallMarker(filePath, failedMarker);
    } catch (error) {
      console.error(
        `[desktop-updater] Failed to persist restart install failure: ${formatErrorMessage(error)}`,
      );
    }
  }

  automaticUpdateActivitySuppressed = true;
  const message = `Penkra restarted, but update ${marker.toVersion} was not installed. Try again.`;
  setUpdateState(
    reduceDesktopUpdateStateOnInstallRestartFailure(
      updateState,
      marker.toVersion,
      consecutiveFailures,
      message,
    ),
  );
  console.error(
    `[desktop-updater] UPDATE INSTALL FAILED: still running ${app.getVersion()} after attempting ${marker.toVersion}; consecutive failures=${consecutiveFailures}. Automatic update checks are suppressed until the user retries.`,
  );
  void logMacUpdateDiagnostics("startup install verification failure");
}

// electron-updater can leave a same-version ZIP in `pending` after a restart or
// a failed install attempt. Clearing it prevents stale "ready" states.
async function clearPendingUpdateCache(reason: string): Promise<void> {
  const pendingDir = getPendingUpdateCacheDir();
  if (!pendingDir || updateDownloadInFlight) {
    return;
  }
  try {
    await FS.promises.rm(pendingDir, { recursive: true, force: true });
    console.info(`[desktop-updater] Cleared pending update cache (${reason}).`);
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear pending update cache (${reason}): ${formatErrorMessage(error)}`,
    );
  }
}

// Terminal updater events can arrive before downloadUpdate() settles; defer cache deletion
// until the updater has released its in-flight download bookkeeping.
function clearPendingUpdateCacheWhenSafe(reason: string): void {
  pendingUpdateCacheClearQueue.request(reason, updateDownloadInFlight, (safeReason) => {
    void clearPendingUpdateCache(safeReason);
  });
}

function clearUpdateBackgroundBlurTimer(): void {
  if (updateBackgroundBlurTimer) {
    clearTimeout(updateBackgroundBlurTimer);
    updateBackgroundBlurTimer = null;
  }
}

// Fail closed if electron-updater never emits a terminal check outcome.
function clearUpdateCheckTimeoutTimer(): void {
  if (updateCheckTimeoutTimer) {
    clearTimeout(updateCheckTimeoutTimer);
    updateCheckTimeoutTimer = null;
  }
}

function armUpdateCheckTimeout(reason: string): void {
  clearUpdateCheckTimeoutTimer();
  updateCheckTimeoutTimer = setTimeout(() => {
    updateCheckTimeoutTimer = null;
    if (updateState.status !== "checking") {
      return;
    }
    updateCheckInFlight = false;
    // electron-updater may never settle its own promise, so this is also where
    // anyone awaiting the check has to be released.
    settleActiveUpdateCheck?.();
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(
        updateState,
        "Timed out while checking for updates. Try again.",
        new Date().toISOString(),
      ),
    );
    console.error(`[desktop-updater] Update check timed out (${reason}).`);
  }, AUTO_UPDATE_CHECK_TIMEOUT_MS);
  updateCheckTimeoutTimer.unref();
}

function clearUpdateDownloadStallTimer(): void {
  if (updateDownloadStallTimer) {
    clearTimeout(updateDownloadStallTimer);
    updateDownloadStallTimer = null;
  }
}

function clearStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = 0;
  stalledDownloadCancellationSuppressionExpiresAtMs = 0;
}

function armStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining += 1;
  stalledDownloadCancellationSuppressionExpiresAtMs =
    Date.now() + AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS;
}

function isStalledDownloadCancellationSuppressionArmed(): boolean {
  if (stalledDownloadCancellationSuppressionsRemaining <= 0) {
    return false;
  }
  if (Date.now() <= stalledDownloadCancellationSuppressionExpiresAtMs) {
    return true;
  }
  clearStalledDownloadCancellationSuppression();
  return false;
}

function consumeStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = Math.max(
    0,
    stalledDownloadCancellationSuppressionsRemaining - 1,
  );
  if (stalledDownloadCancellationSuppressionsRemaining === 0) {
    stalledDownloadCancellationSuppressionExpiresAtMs = 0;
  }
}

// Bounds a silent updater download while allowing slow downloads that keep making progress.
function armUpdateDownloadStallTimer(reason: string): void {
  clearUpdateDownloadStallTimer();
  updateDownloadStallTimer = setTimeout(() => {
    updateDownloadStallTimer = null;
    if (!updateDownloadInFlight || updateState.status !== "downloading") {
      return;
    }

    const error = new Error(getDownloadStallTimeoutMessage(AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS));
    console.error(`[desktop-updater] ${error.message} (${reason}).`);
    armStalledDownloadCancellationSuppression();
    rejectUpdateDownloadStall?.(error);
    updateDownloadCancellationToken?.cancel();
  }, AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
  updateDownloadStallTimer.unref();
}

function updateDownloadStallTimerOnProgress(progress: DownloadProgressSample): void {
  if (!updateDownloadInFlight) {
    return;
  }
  if (!hasDownloadProgressAdvanced(lastUpdateDownloadProgressSample, progress)) {
    return;
  }
  lastUpdateDownloadProgressSample = {
    percent: progress.percent ?? null,
    transferred: progress.transferred ?? null,
  };
  armUpdateDownloadStallTimer(`download progress ${Math.floor(progress.percent ?? 0)}%`);
}

function isDesktopAppForegrounded(): boolean {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function markDesktopAppBackgrounded(): void {
  clearUpdateBackgroundBlurTimer();
  updateBackgroundBlurTimer = setTimeout(() => {
    updateBackgroundBlurTimer = null;
    if (isDesktopAppForegrounded()) {
      return;
    }
    updateBackgroundedAtMs = Date.now();
  }, 0);
}

function handleDesktopAppForegrounded(): void {
  clearUpdateBackgroundBlurTimer();
  clearUnreadNotificationBadge();
  const foregroundedAtMs = Date.now();
  const backgroundedAtMs = updateBackgroundedAtMs;
  updateBackgroundedAtMs = null;
  const shouldCheck = shouldCheckForUpdatesOnForeground({
    checkedAt: updateState.checkedAt,
    backgroundedAtMs,
    foregroundedAtMs,
    minBackgroundDurationMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS,
    minIntervalMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS,
  });
  if (!shouldCheck) {
    return;
  }
  void checkForUpdates("foreground");
}

/**
 * Publishes the running check so a caller that needs its *outcome* — migration
 * recovery — can join it. `checkForUpdates` is a deliberate no-op while another
 * check holds the lock, and without this the caller would read the intermediate
 * "checking" state as a failed download.
 *
 * The returned finish is idempotent and only clears state it still owns, so the
 * check-timeout path can settle a stuck check without stranding a later one.
 */
function beginActiveUpdateCheck(): () => void {
  // Assigned by the executor, which runs before the constructor returns.
  let settle!: () => void;
  const check = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    settle();
    if (activeUpdateCheck === check) {
      activeUpdateCheck = null;
      settleActiveUpdateCheck = null;
    }
  };
  activeUpdateCheck = check;
  settleActiveUpdateCheck = finish;
  return finish;
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || isUpdaterInstallPreparing || !updaterConfigured || updateCheckInFlight) return;
  if (automaticUpdateActivitySuppressed) {
    if (!isExplicitUpdateCheckReason(reason)) {
      console.info(
        `[desktop-updater] Skipping automatic update check (${reason}) after an unverified install failure.`,
      );
      return;
    }
    automaticUpdateActivitySuppressed = false;
    console.info(
      `[desktop-updater] User requested update recovery (${reason}); automatic checks are enabled for this session.`,
    );
    scheduleUpdatePoll();
  }
  if (
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded"
  ) {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  const finishCheck = beginActiveUpdateCheck();
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  armUpdateCheckTimeout(reason);
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    clearUpdateCheckTimeoutTimer();
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
    finishCheck();
  }
}

async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (
    updaterConfigured &&
    updateState.status === "error" &&
    updateState.errorContext === "install" &&
    updateState.downloadedVersion === null &&
    updateState.availableVersion !== null
  ) {
    await checkForUpdates("renderer");
    return { accepted: true, completed: false };
  }
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  if (!isKnownUpdateVersionNewer(updateState.availableVersion)) {
    await clearPendingUpdateCache("available version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring stale available update ${updateState.availableVersion ?? "unknown"} for current ${app.getVersion()}.`,
    );
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  downloadedUpdateArtifact = null;
  downloadedUpdateIdentityTask = null;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  // Keep existing cancellation suppressions across immediate retries; the old
  // updater cancellation can arrive after a new download has already started.
  lastUpdateDownloadProgressSample = null;
  const cancellationToken = new CancellationToken();
  updateDownloadCancellationToken = cancellationToken;
  const downloadStalled = new Promise<never>((_, reject) => {
    rejectUpdateDownloadStall = reject;
  });
  armUpdateDownloadStallTimer("download start");
  console.info("[desktop-updater] Downloading update...");

  // Track electron-updater's own download promise separately from the stall race.
  // When the stall timer wins the race it cancels this promise, but the updater
  // keeps its internal download promise set until that cancellation unwinds. We
  // observe its settlement here (so a late rejection can't surface as an unhandled
  // rejection) and wait on it before releasing the in-flight flag below.
  let updaterDownloadSettled = false;
  const updaterDownloadPromise = autoUpdater.downloadUpdate(cancellationToken);
  const updaterDownloadSettledPromise = updaterDownloadPromise.then(
    () => {
      updaterDownloadSettled = true;
    },
    () => {
      updaterDownloadSettled = true;
    },
  );

  try {
    await Promise.race([updaterDownloadPromise, downloadStalled]);
    const identityTask = downloadedUpdateIdentityTask;
    if (identityTask) {
      await identityTask;
    }
    return {
      accepted: true,
      completed: downloadedUpdateArtifact !== null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    clearUpdateDownloadStallTimer();
    // Hold the in-flight flag until the updater download actually settles, so an
    // immediate retry can't grab the still-cancelling promise (which would reject
    // as "cancelled"). Bounded so a stuck updater promise can't wedge updates.
    if (!updaterDownloadSettled) {
      await Promise.race([
        updaterDownloadSettledPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS).unref();
        }),
      ]);
    }
    if (updateDownloadCancellationToken === cancellationToken) {
      updateDownloadCancellationToken = null;
    }
    rejectUpdateDownloadStall = null;
    lastUpdateDownloadProgressSample = null;
    updateDownloadInFlight = false;
    const pendingCacheClearReason = pendingUpdateCacheClearQueue.consumeAfterDownload();
    if (pendingCacheClearReason) {
      await clearPendingUpdateCache(pendingCacheClearReason);
    }
  }
}

// Starts the automatic prepare step after a successful update check; install
// stays user-controlled so active agent work is not interrupted by a restart.
function prepareAvailableUpdateInBackground(reason: string): void {
  if (updateDownloadInFlight || updateState.status !== "available") {
    return;
  }
  const preparation = downloadAvailableUpdate()
    .then((result) => {
      if (result.accepted && result.completed) {
        console.info(`[desktop-updater] Background update download completed (${reason}).`);
      }
    })
    .catch((error) => {
      console.error(
        `[desktop-updater] Background update download crashed (${reason}): ${formatErrorMessage(error)}`,
      );
    })
    .finally(() => {
      if (activeUpdatePreparation === preparation) {
        activeUpdatePreparation = null;
      }
    });
  // Published so a caller that needs the download finished — migration
  // recovery — can await this one instead of racing a second download
  // against it.
  activeUpdatePreparation = preparation;
}

/**
 * Whether the recovery prompt can offer an in-place update.
 *
 * Deliberately permissive about the current status: the check has usually not
 * run yet at this point in startup, so "we do not know of an update" is not a
 * reason to hide the option. Only a completed check that found nothing newer
 * is, because then updating provably cannot repair anything.
 */
function canInstallUpdateFromRecovery(): boolean {
  return updaterConfigured && updateState.status !== "up-to-date";
}

/**
 * Drives check → download → install for an install whose database is wedged.
 *
 * This is the only recovery option that needs nothing from the user afterwards,
 * so it runs the whole updater sequence rather than stopping at "an update is
 * available". Resolves to a message to show in the next prompt when the update
 * could not be installed, or to null once the install handoff has started.
 */
async function installLatestUpdateForMigrationRecovery(): Promise<string | null> {
  if (!updaterConfigured) {
    return resolveAutoUpdateDisabledReason() ?? "Automatic updates are not available.";
  }

  if (updateState.status !== "downloaded") {
    // The automatic startup check is armed before this prompt appears, so one
    // may already be running. Joining it is what gets a real answer: starting a
    // second check here would return without doing anything and leave the
    // status at "checking", which reads as a download failure below.
    const inFlightCheck = activeUpdateCheck;
    if (inFlightCheck === null) {
      await checkForUpdates(UPDATE_CHECK_REASON_MIGRATION_RECOVERY);
    } else {
      await inFlightCheck;
    }
    // A successful check starts the download itself; await that one rather
    // than starting a competing transfer.
    const preparation = activeUpdatePreparation;
    if (preparation !== null) {
      await preparation;
    } else if (updateState.status === "available") {
      await downloadAvailableUpdate();
    }
  }

  if (updateState.status === "up-to-date") {
    return `Penkra ${app.getVersion()} is already the newest release, so updating cannot repair this database.`;
  }
  if (updateState.status !== "downloaded") {
    return updateState.message ?? "The update could not be downloaded.";
  }

  await installDownloadedUpdate();
  // quitAndInstall never resolves — the process exits under it. A handoff that
  // silently fails is cleared by the install watchdog instead, and waiting for
  // that verdict is what keeps a failed install from leaving a live app with
  // no window and no way back to this prompt.
  await waitForMigrationRecoveryInstallHandoff();
  if (isUpdaterQuitAndInstallInFlight) {
    return null;
  }
  return updateState.message ?? "The downloaded update could not be installed.";
}

/**
 * Waits out the install watchdog window, which is the earliest a failed handoff
 * can be known: nothing else clears `isUpdaterQuitAndInstallInFlight`, so there
 * is nothing to poll for. A successful handoff exits the process well before
 * this resolves.
 */
async function waitForMigrationRecoveryInstallHandoff(): Promise<void> {
  if (!isUpdaterQuitAndInstallInFlight) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, AUTO_UPDATE_INSTALL_WATCHDOG_MS + 2_000).unref();
  });
}

async function runDownloadedUpdateInstall(
  preparationAttempt: UpdateInstallPreparationAttempt,
): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  const versionToInstall = updateState.downloadedVersion ?? updateState.availableVersion;
  if (!versionToInstall || !isKnownUpdateVersionNewer(versionToInstall)) {
    await clearPendingUpdateCache("downloaded version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring stale downloaded update ${versionToInstall ?? "unknown"} for current ${app.getVersion()}.`,
    );
    return { accepted: false, completed: false };
  }

  const artifact =
    downloadedUpdateArtifact?.version === versionToInstall
      ? downloadedUpdateArtifact.identity
      : null;
  if (!artifact || !(await verifyUpdateArtifactIdentity(artifact))) {
    downloadedUpdateArtifact = null;
    await clearPendingUpdateCache("downloaded artifact identity is missing or changed");
    const message = "The downloaded update could not be reverified. Download it again.";
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Refusing install handoff: ${message}`);
    return { accepted: false, completed: false };
  }
  updateInstallPreparation.requireActive(preparationAttempt);

  const markerPath = getUpdateInstallMarkerPath();
  const existingMarkerResult = readInstallMarker(markerPath);
  const existingMarker =
    existingMarkerResult.status === "valid" &&
    existingMarkerResult.marker.toVersion === versionToInstall
      ? existingMarkerResult.marker
      : null;
  const marker = createUpdateInstallMarker({
    fromVersion: app.getVersion(),
    toVersion: versionToInstall,
    requestedAt: new Date().toISOString(),
    consecutiveFailures: existingMarker?.consecutiveFailures ?? 0,
    lastFailureAt: existingMarker?.lastFailureAt ?? null,
    artifact,
  });
  const handoffExpectation: UpdateInstallHandoffExpectation = {
    attemptId: marker.attemptId,
    artifact,
  };
  let markerWritten = false;
  let artifactInvalidated = false;
  try {
    isQuitting = true;
    clearUpdatePollTimer();
    await stopBackendAndWaitForExit({
      forceKillDelayMs: UPDATE_BACKEND_FORCE_KILL_DELAY_MS,
      timeoutMs: UPDATE_BACKEND_SHUTDOWN_TIMEOUT_MS,
    });
    updateInstallPreparation.requireActive(preparationAttempt);
    await logMacUpdateDiagnostics("before install handoff");
    updateInstallPreparation.requireActive(preparationAttempt);
    if (!(await verifyUpdateArtifactIdentity(artifact))) {
      artifactInvalidated = true;
      downloadedUpdateArtifact = null;
      await clearPendingUpdateCache("downloaded artifact changed during install preparation");
      throw new Error(
        "The downloaded update changed during install preparation. Download it again.",
      );
    }
    updateInstallPreparation.requireActive(preparationAttempt);
    writeInstallMarker(markerPath, marker);
    markerWritten = true;
    if (!markInstallHandoffSync(markerPath, handoffExpectation)) {
      throw new Error("Durable update install marker changed before install handoff.");
    }
    activeUpdateInstallHandoff = handoffExpectation;
    isUpdaterQuitAndInstallInFlight = true;
    autoUpdater.quitAndInstall();
    updateInstallPreparation.requireActive(preparationAttempt);
    armInstallWatchdog();
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    clearUpdaterInstallInFlightAfterError();
    const consecutiveFailures = markerWritten
      ? recordInstallMarkerFailure(new Date().toISOString(), handoffExpectation)
      : updateState.installFailureCount;
    startBackend();
    scheduleUpdatePoll();
    setUpdateState({
      ...(artifactInvalidated
        ? reduceDesktopUpdateStateOnDownloadFailure(updateState, message)
        : reduceDesktopUpdateStateOnInstallFailure(updateState, message)),
      installFailureCount: consecutiveFailures,
    });
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }
  const preparationAttempt = updateInstallPreparation.begin();
  if (preparationAttempt === null) {
    return { accepted: false, completed: false };
  }
  isUpdaterInstallPreparing = true;

  try {
    return await runDownloadedUpdateInstall(preparationAttempt);
  } finally {
    if (!isUpdaterQuitAndInstallInFlight && isUpdaterInstallPreparing) {
      clearUpdaterInstallInFlightAfterError();
    }
    updateInstallPreparation.release(preparationAttempt);
  }
}

async function recordDownloadedUpdateIdentity(info: UpdateDownloadedEvent): Promise<void> {
  clearUpdateDownloadStallTimer();
  if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe("downloaded version is not newer than current app");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring downloaded non-newer update ${info.version}; current version is ${app.getVersion()}.`,
    );
    return;
  }

  try {
    const identity = await fingerprintUpdateArtifact(info.downloadedFile);
    if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
      downloadedUpdateArtifact = null;
      clearPendingUpdateCacheWhenSafe("downloaded version became stale during fingerprinting");
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      return;
    }
    downloadedUpdateArtifact = { version: info.version, identity };
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(
      `[desktop-updater] Update downloaded and fingerprinted: ${info.version} (${identity.size} bytes, sha512=${identity.sha512.slice(0, 16)}…).`,
    );
  } catch (error) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe("downloaded artifact fingerprint failed");
    const message = `The downloaded update could not be verified: ${formatErrorMessage(error)}`;
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] ${message}`);
  }
}

function configureAutoUpdater(): void {
  const appUpdateYml = readAppUpdateYml();
  configuredUpdaterCacheDirName = resolveElectronUpdaterCacheDirName(appUpdateYml, app.getName());
  const githubUpdateSource = resolveGitHubUpdateSource(appUpdateYml);
  const releaseUrl =
    githubUpdateSource === null ? null : buildGitHubReleasesPageUrl(githubUpdateSource);
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
    releaseUrl,
  });
  processInstallMarkerOnStartup();
  if (!enabled) {
    configuredUpdaterCacheDirName = null;
    return;
  }
  updaterConfigured = true;
  hardenElectronUpdater(
    { BaseUpdater },
    autoUpdater,
    desktopPlatform.platform,
    app.isPackaged ? [] : null,
  );

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // The dedicated channel keeps the permanent compatibility release on the
  // default feed while Penkra versions advance independently.
  autoUpdater.channel = PENKRA_DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  // Match electron-updater's native GitHub provider path; the packaged
  // app-update.yml owns the production feed, and generic feeds stay mock-only.
  // macOS release builds repack and validate the Squirrel update zip, then omit
  // the stale zip blockmap so ShipIt always installs the exact signed payload.
  autoUpdater.disableDifferentialDownload =
    desktopPlatform.updater.disableDifferentialDownload ||
    isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  // electron-updater has no working idle timeout on macOS (its socket timeout is
  // wired to a `socket` event Electron's net.request never emits) and never
  // resumes from a byte offset, so a stalled CDN transfer hangs for minutes
  // until TCP recovers on its own. installResumableUpdateDownloader replaces the
  // download transfer with a stall-aware, resumable one and installs a real idle
  // timeout, so an intermittent stall becomes a brief reconnect-and-resume
  // instead of a multi-minute freeze. Independent of the zip-validation fix.
  if (!installResumableUpdateDownloader(autoUpdater as unknown as ResumableDownloaderTarget)) {
    console.warn(
      "[desktop-updater] Could not install resumable update downloader; falling back to default transfer.",
    );
  }
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    if (!isUpdateVersionNewer(app.getVersion(), info.version)) {
      void clearPendingUpdateCache("available version is not newer than current app");
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      lastLoggedDownloadMilestone = -1;
      console.info(
        `[desktop-updater] Ignoring non-newer update ${info.version}; current version is ${app.getVersion()}.`,
      );
      return;
    }
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
    prepareAvailableUpdateInBackground(`available ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    void clearPendingUpdateCache("no newer update available");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    clearUpdateCheckTimeoutTimer();
    const message = formatErrorMessage(error);
    const errorContext = resolveUpdaterErrorContext();
    if (
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: isStalledDownloadCancellationSuppressionArmed(),
        errorContext,
        message,
      })
    ) {
      consumeStalledDownloadCancellationSuppression();
      console.warn("[desktop-updater] Ignored expected cancellation after stalled download.");
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    const installPreparationPending = clearUpdaterInstallInFlightAfterError({
      preservePendingPreparation: true,
    });
    if (errorContext === "download") {
      downloadedUpdateArtifact = null;
    }
    const installFailureCount =
      errorContext === "install"
        ? recordInstallMarkerFailure(new Date().toISOString(), failedHandoff)
        : updateState.installFailureCount;
    if (errorContext === "install" && !installPreparationPending) {
      startBackend();
      scheduleUpdatePoll();
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext,
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
        installFailureCount,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    updateDownloadStallTimerOnProgress(progress);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    const task = recordDownloadedUpdateIdentity(info);
    downloadedUpdateIdentityTask = task;
    const clearTask = () => {
      if (downloadedUpdateIdentityTask === task) downloadedUpdateIdentityTask = null;
    };
    void task.then(clearTask, clearTask);
  });

  clearUpdatePollTimer();

  if (automaticUpdateActivitySuppressed) {
    console.info(
      "[desktop-updater] Startup and periodic update checks suppressed after failed install verification.",
    );
    return;
  }

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  scheduleUpdatePoll();
}
// Builds process-local Node args so provider/tool children do not inherit Penkra's heap guard.
function backendNodeArgs(): string[] {
  const configuredMaxOldSpaceMb =
    BACKEND_MAX_OLD_SPACE_ENV_KEYS.map((key) => process.env[key]).find(
      (value) => value !== undefined && value.trim().length > 0,
    ) ?? null;
  return resolveBackendNodeArgs({
    configuredMaxOldSpaceMb,
    existingNodeOptions: process.env.NODE_OPTIONS,
    totalMemoryBytes: OS.totalmem(),
  });
}

function backendEnv(): NodeJS.ProcessEnv {
  const servedStaticRoot = resolveServedStaticRoot();
  const env = bindDesktopParentPid(
    {
      ...process.env,
      ...(appCommandPipeServer?.environment ?? {}),
      // Point the backend's HTTP static route at the same swap-immune snapshot the
      // penkra:// protocol serves, so both surfaces survive app.asar being replaced.
      ...(servedStaticRoot?.snapshotted ? { PENKRA_STATIC_DIR: servedStaticRoot.dir } : {}),
      PENKRA_MODE: "desktop",
      PENKRA_NO_BROWSER: "1",
      PENKRA_PORT: String(backendPort),
      PENKRA_HOME: BASE_DIR,
      PENKRA_AUTH_TOKEN: backendAuthToken,
      PENKRA_DESKTOP_SHUTDOWN_TOKEN: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
      PENKRA_APP_TEST_ELECTRON: process.execPath,
      PENKRA_APP_TEST_HOST: Path.join(__dirname, "entry.js"),
      PENKRA_APP_TEST_PACKAGED: app.isPackaged ? "1" : "0",
    },
    process.pid,
  );
  // The backend runs the same login-shell probe at startup and does not begin listening
  // until it returns, so an unmarked child serializes a second ~1s hydration behind ours.
  // Written explicitly in both directions: an inherited marker must never suppress a
  // probe when our own hydration failed and the child's PATH is the raw launch one.
  return applyShellEnvironmentHydrationMarker(env, shellEnvironmentSync.pathHydrated);
}

function scheduleBackendRestart(reason: string): void {
  const response = backendSupervision.respondToStartFailure({
    quitting: isQuitting,
    restartPending: restartTimer !== null,
    migrationRecoveryMarkerPresent: isDesktopMigrationRecoveryPending(),
  });

  switch (response.kind) {
    case "ignore":
      return;
    case "recover-migration":
      // The marker is written mid-session by the migration that just killed the
      // backend, so bootstrap's one-shot check never saw it. Recovery owns the
      // process from here; respawning would only repeat the failed migration.
      writeDesktopLogHeader(
        `migration recovery marker detected after backend failure reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed with a pending migration recovery (${reason}); opening recovery`,
      );
      void runMidSessionMigrationRecovery(reason);
      return;
    case "give-up":
      writeDesktopLogHeader(
        `backend supervision gave up failures=${response.failures} reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed to start ${response.failures} times in a row (${reason}); no further restarts will be attempted`,
      );
      presentBackendStartupGiveUp(reason);
      return;
    case "retry":
      safeConsoleError(
        `[desktop] backend exited unexpectedly (${reason}); restarting in ${response.delayMs}ms (attempt ${response.attempt}/${BACKEND_MAX_CONSECUTIVE_START_FAILURES})`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void restartBackendAfterCrash(reason);
      }, response.delayMs);
      return;
  }
}

// Runs the same recovery flow bootstrap uses, but for a marker that appeared while
// the app was already running. Shown once per app run — the policy owns that latch.
async function runMidSessionMigrationRecovery(reason: string): Promise<void> {
  const outcome = await handleDesktopMigrationRecovery();
  if (outcome !== "continue") return;

  // The marker vanished between the crash check and the recovery run (another
  // process cleared it), so fall back to the normal supervised restart.
  await restartBackendAfterCrash(reason);
}

function backendFailureDialogDetail(reason: string): string {
  const summary = summarizeBackendFailureOutput(lastBackendFailureDetail ?? "");
  const cause = summary.length > 0 ? summary : reason;
  return [
    cause,
    "Penkra paused automatic restarts so a failing backend can't keep respawning in the background.",
    `Log file:\n${Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME)}`,
  ].join("\n\n");
}

async function openDesktopLogDirectory(): Promise<void> {
  try {
    await FS.promises.mkdir(LOG_DIR, { recursive: true });
    const errorMessage = await shell.openPath(LOG_DIR);
    if (errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
  } catch (error) {
    safeConsoleError(`[desktop] failed to open log directory: ${formatErrorMessage(error)}`);
  }
}

async function presentFatalDatabaseBlock(
  kind: "database-corrupt" | "unsafe-sqlite-runtime",
): Promise<void> {
  const unsafeRuntime = kind === "unsafe-sqlite-runtime";
  for (;;) {
    const result = await dialog.showMessageBox({
      type: "error",
      title: unsafeRuntime
        ? "Penkra needs a safer database runtime"
        : "Penkra stopped to protect your data",
      message: unsafeRuntime
        ? "This Penkra runtime includes an unsupported SQLite version."
        : "SQLite reported that the local database is damaged.",
      detail: unsafeRuntime
        ? "Penkra did not open your data. Update or reinstall Penkra before trying again."
        : "Penkra stopped automatic restarts and will not keep reopening the database. Review the logs and restore a verified backup while every Penkra process is stopped.",
      buttons: ["Open logs", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      await openDesktopLogDirectory();
      continue;
    }
    requestGracefulAppQuit(unsafeRuntime ? "unsafe SQLite runtime" : "database corruption");
    return;
  }
}

/**
 * Replaces the eternal loading skeleton with a blocking, actionable window once
 * supervision stops respawning the backend.
 */
function presentBackendStartupGiveUp(reason: string): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const detail = backendFailureDialogDetail(reason);
  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Penkra's backend didn't start",
        message: `Penkra's backend failed to start ${BACKEND_MAX_CONSECUTIVE_START_FAILURES} times in a row.`,
        detail,
        buttons: ["Try again", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven retry is a fresh lifecycle start, not another crash cycle.
        backendLifecycleDialogInFlight = null;
        await restartBackendAfterCrash("manual retry after backend startup failure", "lifecycle");
        return;
      }

      requestGracefulAppQuit("backend failed to start");
      return;
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

function handleBackendStartupBlock(block: BackendStartupBlock): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const task = (async () => {
    if (block.kind === "database-corrupt" || block.kind === "unsafe-sqlite-runtime") {
      await presentFatalDatabaseBlock(block.kind);
      return;
    }

    if (block.kind === "migration-recovery-required") {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Penkra needs to recover its database",
        message: "A database migration did not finish safely.",
        detail:
          "Restart Penkra to open the verified backup recovery flow. Provider and chat processes will remain stopped until recovery completes.",
        buttons: ["Restart and recover", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        app.relaunch();
        requestGracefulAppQuit("migration recovery required");
      } else {
        requestGracefulAppQuit("migration recovery declined");
      }
      return;
    }

    const processDetail =
      block.ownerPid === null
        ? "Another Penkra server is already using this database."
        : `Another Penkra server (process ${block.ownerPid}) is already using this database.`;
    const result = await dialog.showMessageBox({
      type: "warning",
      title: "Penkra is already running elsewhere",
      message: "Your local Penkra data is in use by another process.",
      detail: `${processDetail}\n\nStop the other Penkra app or development server, then try again. Your data has not been changed.`,
      buttons: ["Try again", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      // Let a fast failed retry present the block again instead of racing this
      // dialog task's finalizer and leaving the window inert.
      backendLifecycleDialogInFlight = null;
      await restartBackendAfterCrash("database lifecycle lock retry", "lifecycle");
    } else {
      requestGracefulAppQuit("database lifecycle lock");
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

async function restartBackendAfterCrash(
  reason: string,
  trigger: BackendStartTrigger = "crash-restart",
): Promise<void> {
  if (isQuitting || backendProcess) {
    return;
  }

  if (trigger === "lifecycle") {
    // Reset before reserving the port so a user-driven retry gets a full restart
    // budget even when the retry itself fails before the process is spawned.
    backendSupervision.reset();
  }

  cancelBackendReadinessWait();
  try {
    await reserveBackendEndpoint("backend restart");
  } catch (error) {
    scheduleBackendRestart(
      `failed to reserve restart port after ${reason}: ${formatErrorMessage(error)}`,
    );
    return;
  }

  startBackend(trigger);
  ensureInitialBackendWindowOpen(backendHttpUrl);
}

/**
 * "lifecycle" covers every deliberate start — bootstrap, a failed update install
 * handing the backend back, or a user-driven retry — and clears the crash backoff
 * and circuit breaker. Only the supervised crash path keeps the failure count.
 */
type BackendStartTrigger = "lifecycle" | "crash-restart";

function startBackend(trigger: BackendStartTrigger = "lifecycle"): void {
  if (isQuitting || backendProcess) return;
  // Recovery owns the database until it clears the marker. Callers that restart
  // the backend after an unrelated failure — a given-up update install, say —
  // must not hand it a database the user is being asked how to repair.
  if (desktopStartupBlockedForMigrationRecovery) {
    writeDesktopLogHeader("backend start suppressed while migration recovery is pending");
    return;
  }

  if (trigger === "lifecycle") {
    backendSupervision.reset();
  }

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const child = ChildProcess.spawn(process.execPath, [...backendNodeArgs(), backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
      PENKRA_SERVER_ENTRY: backendEntry,
    },
    // Keep output piped in every environment so startup blockers and readiness
    // are observable even when packaged log setup is unavailable.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const listeningDetector = new ServerListeningDetector();
  const startupBlockDetector = new BackendStartupBlockDetector();
  const outputTailDetector = new BackendOutputTailDetector();
  backendListeningDetector = listeningDetector;
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  const backendLogDestination = backendLogSink;
  const backendOutputCapture = captureBackendProcessOutput({
    stdout: child.stdout,
    stderr: child.stderr,
    ...(backendLogDestination ? { writeLog: (chunk) => backendLogDestination.write(chunk) } : {}),
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    detectors: [listeningDetector, startupBlockDetector, outputTailDetector],
  });

  // A successful spawn only proves that Electron created the process. Reset the
  // crash backoff and the circuit breaker after the backend actually listens;
  // otherwise a startup error becomes a permanent 500 ms restart loop.
  void listeningDetector.promise.then(
    () => {
      if (backendListeningDetector === listeningDetector) {
        backendSupervision.recordReadiness();
      }
    },
    () => undefined,
  );

  child.on("error", (error) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(error);
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    lastBackendFailureDetail = error.message;
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(
        new Error(
          `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    void backendOutputCapture.drained.then(() => {
      closeBackendSession(
        `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (isQuitting) return;
      const startupBlock = startupBlockDetector.read();
      if (startupBlock) {
        handleBackendStartupBlock(startupBlock);
        return;
      }
      const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      lastBackendFailureDetail = outputTailDetector.read();
      scheduleBackendRestart(reason);
    });
  });
}

function takeBackendProcessForShutdown(): ChildProcess.ChildProcess | null {
  cancelBackendReadinessWait();
  backendListeningDetector = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  return child;
}

function stopBackend(): void {
  const child = takeBackendProcessForShutdown();
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, BACKEND_FORCE_KILL_DELAY_MS).unref();
  }
}

async function stopBackendAndWaitForExit(options?: {
  readonly forceKillDelayMs?: number;
  readonly timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? BACKEND_SHUTDOWN_TIMEOUT_MS;
  const requestedForceKillDelayMs = options?.forceKillDelayMs ?? BACKEND_FORCE_KILL_DELAY_MS;
  const child = takeBackendProcessForShutdown();
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  if (desktopPlatform.processLifecycle.backendShutdown === "windows-control") {
    const forceKillDelayMs = Math.min(requestedForceKillDelayMs, Math.max(0, timeoutMs - 500));
    try {
      const result = await stopWindowsBackendAndWait({
        child: backendChild,
        backendHttpUrl,
        shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
        forceKillDelayMs,
        timeoutMs,
      });
      requireWindowsBackendExit(result);
    } catch (error) {
      backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
      throw error;
    }
    return;
  }

  const forceKillDelayMs = Math.min(requestedForceKillDelayMs, Math.max(0, timeoutMs - 500));
  try {
    await stopPosixBackendAndWait({
      child: backendChild,
      backendHttpUrl,
      shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
      forceKillDelayMs,
      timeoutMs,
    });
  } catch (error) {
    backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
    throw error;
  }
}

async function disposeAppCommandPipeServerForShutdown(reason: string): Promise<void> {
  const pipeServer = appCommandPipeServer;
  appCommandPipeServer = null;
  if (!pipeServer) return;
  try {
    await pipeServer.dispose();
  } catch (error) {
    console.warn(
      `[desktop] Failed to dispose App command pipe during ${reason}: ${formatErrorMessage(error)}`,
    );
  }
}

async function stopAppRuntimeAndBackend(): Promise<void> {
  const failures: unknown[] = [];
  const sideloadRegistry = developmentSideloadRegistry;
  developmentSideloadRegistry = null;
  if (sideloadRegistry) {
    try {
      await sideloadRegistry.close();
    } catch (error) {
      failures.push(error);
    }
  }
  const hostedSurfaces = simulatorHostedSurfaces;
  simulatorHostedSurfaces = null;
  simulatorViewerFactory = null;
  if (hostedSurfaces) {
    try {
      hostedSurfaces.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  const runtime = desktopAppRuntime;
  desktopAppRuntime = null;
  if (runtime) {
    try {
      await runtime.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  unsubscribeSimulatorState?.();
  unsubscribeSimulatorState = null;
  const simulatorRuntime = desktopSimulatorRuntime;
  desktopSimulatorRuntime = null;
  if (simulatorRuntime) {
    try {
      await simulatorRuntime.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await stopBackendAndWaitForExit();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Desktop services did not shut down cleanly.");
  }
}

// Keeps Electron alive long enough for backend finalizers to reap provider child processes.
async function shutdownDesktopRuntime(reason: string): Promise<void> {
  if (desktopShutdownPromise) {
    return desktopShutdownPromise;
  }

  isQuitting = true;
  writeDesktopLogHeader(`${reason} shutdown start`);
  const shutdown = runAfterDesktopShutdown(
    stopAppRuntimeAndBackend(),
    async () => {
      clearUpdateBackgroundBlurTimer();
      clearUpdateCheckTimeoutTimer();
      clearUpdatePollTimer();
      cancelBackendReadinessWait();
      await disposeAppCommandPipeServerForShutdown(reason);
      browserManager.dispose();
      restoreStdIoCapture?.();
      desktopShutdownComplete = true;
      writeDesktopLogHeader(`${reason} shutdown complete`);
    },
    { runAfterShutdownFailure: true },
  );
  desktopShutdownPromise = shutdown;

  try {
    await shutdown;
  } catch (error) {
    if (desktopShutdownPromise === shutdown) {
      desktopShutdownPromise = null;
    }
    throw error;
  }
}

function requestGracefulAppQuit(reason: string): void {
  if (isUpdaterInstallPreparing) {
    writeDesktopLogHeader(`${reason} waiting for updater quit-and-install`);
    return;
  }

  void runAfterDesktopShutdown(shutdownDesktopRuntime(reason), () => app.quit()).catch(
    (error: unknown) => {
      const message = formatErrorMessage(error);
      writeDesktopLogHeader(`${reason} shutdown failed message=${message}`);
      console.warn(`[desktop] Shutdown failed during ${reason}: ${message}`);
      app.exit(1);
    },
  );
}

function registerIpcHandlers(): void {
  const storageSnapshotPath = resolvePenkraStorageSnapshotPath(app.getPath("userData"));

  const requireMainRenderer = (event: Electron.IpcMainInvokeEvent): void => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Composer drafts are available only to the Penkra shell.");
    }
  };
  for (const channel of Object.values(IPC.composerDrafts)) ipcMain.removeHandler(channel);
  ipcMain.handle(IPC.composerDrafts.readSnapshot, async (event) => {
    requireMainRenderer(event);
    return composerDraftJournal.readSnapshot();
  });
  ipcMain.handle(IPC.composerDrafts.writeSnapshot, async (event, value: unknown) => {
    requireMainRenderer(event);
    if (typeof value !== "string") throw new Error("Invalid composer draft snapshot.");
    await composerDraftJournal.writeSnapshot(value);
  });
  ipcMain.handle(IPC.composerDrafts.removeSnapshot, async (event) => {
    requireMainRenderer(event);
    await composerDraftJournal.removeSnapshot();
  });
  ipcMain.handle(IPC.composerDrafts.writeAsset, async (event, input: unknown) => {
    requireMainRenderer(event);
    if (!input || typeof input !== "object") throw new Error("Invalid composer asset.");
    const candidate = input as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.draftId !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.mimeType !== "string"
    ) {
      throw new Error("Invalid composer asset metadata.");
    }
    return composerDraftJournal.writeAsset({
      id: candidate.id,
      draftId: candidate.draftId,
      name: candidate.name,
      mimeType: candidate.mimeType,
      bytes: composerBytesFromIpc(candidate.bytes),
    });
  });
  ipcMain.handle(IPC.composerDrafts.readAsset, async (event, id: unknown) => {
    requireMainRenderer(event);
    if (typeof id !== "string") throw new Error("Invalid composer asset id.");
    return composerDraftJournal.readAsset(id);
  });
  ipcMain.handle(IPC.composerDrafts.deleteAsset, async (event, id: unknown) => {
    requireMainRenderer(event);
    if (typeof id !== "string") throw new Error("Invalid composer asset id.");
    await composerDraftJournal.deleteAsset(id);
  });
  ipcMain.handle(IPC.composerDrafts.createVoice, async (event, input: unknown) => {
    requireMainRenderer(event);
    if (!input || typeof input !== "object") throw new Error("Invalid voice draft.");
    const job = input as Parameters<typeof composerDraftJournal.createVoice>[0];
    if (
      typeof job.id !== "string" ||
      typeof job.threadId !== "string" ||
      typeof job.cwd !== "string" ||
      typeof job.sampleRateHz !== "number" ||
      typeof job.createdAt !== "string" ||
      typeof job.updatedAt !== "string"
    ) {
      throw new Error("Invalid voice draft metadata.");
    }
    await composerDraftJournal.createVoice(job);
  });
  ipcMain.handle(IPC.composerDrafts.appendVoice, async (event, input: unknown) => {
    requireMainRenderer(event);
    if (!input || typeof input !== "object") throw new Error("Invalid voice draft batch.");
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.sequence !== "number") {
      throw new Error("Invalid voice draft batch metadata.");
    }
    return composerDraftJournal.appendVoice({
      id: candidate.id,
      sequence: candidate.sequence,
      bytes: composerBytesFromIpc(candidate.bytes),
    });
  });
  ipcMain.handle(IPC.composerDrafts.completeVoice, async (event, id: unknown) => {
    requireMainRenderer(event);
    if (typeof id !== "string") throw new Error("Invalid voice draft id.");
    return composerDraftJournal.completeVoice(id);
  });
  ipcMain.handle(IPC.composerDrafts.listVoices, async (event) => {
    requireMainRenderer(event);
    return composerDraftJournal.listVoices();
  });
  ipcMain.handle(IPC.composerDrafts.readVoice, async (event, id: unknown) => {
    requireMainRenderer(event);
    if (typeof id !== "string") throw new Error("Invalid voice draft id.");
    return composerDraftJournal.readVoice(id);
  });
  ipcMain.handle(IPC.composerDrafts.deleteVoice, async (event, id: unknown) => {
    requireMainRenderer(event);
    if (typeof id !== "string") throw new Error("Invalid voice draft id.");
    await composerDraftJournal.deleteVoice(id);
  });

  ipcMain.removeAllListeners(IPC.storageMigration.read);
  ipcMain.on(IPC.storageMigration.read, (event: IpcMainEvent) => {
    event.returnValue = readPenkraStorageSnapshot(storageSnapshotPath);
  });

  ipcMain.removeHandler(IPC.storageMigration.acknowledge);
  ipcMain.handle(IPC.storageMigration.acknowledge, async () => {
    await acknowledgePenkraStorageSnapshot(storageSnapshotPath);
  });

  const requireAppRenderer = (senderId: number) => {
    const runtime = desktopAppRuntime;
    const identity = runtime?.rendererIdentity(senderId);
    if (!runtime || !identity) throw new Error("This renderer is not a registered Penkra App.");
    return { runtime, identity };
  };

  ipcMain.removeHandler(IPC.appRuntime.tabSetRoute);
  ipcMain.handle(IPC.appRuntime.tabSetRoute, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (!identity.tabId) throw new Error("This App renderer is not attached to a tab.");
    runtime.appTabs.setRoute(identity.tabId, parseAppTabRouteRequest(input));
  });

  ipcMain.removeHandler(IPC.appRuntime.permissionQuery);
  ipcMain.handle(IPC.appRuntime.permissionQuery, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    return queryAppPermission(runtime.installations.snapshot(), identity, input);
  });
  ipcMain.removeHandler(IPC.appRuntime.permissionRequest);
  ipcMain.handle(IPC.appRuntime.permissionRequest, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    const current = queryAppPermission(runtime.installations.snapshot(), identity, input);
    if (!current.declared) throw new Error(`${String(input)} is not declared by this App.`);
    if (current.required)
      throw new Error(`${current.name} is required and cannot be requested at runtime.`);
    if (current.state === "granted") return current;
    await runtime.installations.requestOptionalPermission({
      appId: identity.appId,
      spaceId: identity.spaceId,
      permission: current.name,
      confirm: async ({ appName, reason }) => {
        const options: Electron.MessageBoxOptions = {
          type: "question",
          buttons: ["Allow", "Not now"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: `${appName} permission`,
          message: `${appName} would like permission to ${reason.replace(/[.\s]+$/, "").toLowerCase()}.`,
          detail: "You can revoke this permission later in Penkra Settings.",
        };
        const result = mainWindow
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 0;
      },
    });
    return queryAppPermission(runtime.installations.snapshot(), identity, current.name);
  });
  ipcMain.removeHandler(IPC.appRuntime.identityGet);
  ipcMain.handle(IPC.appRuntime.identityGet, async (event) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    return runtime.identities.resolve(identity.appId, identity.spaceId);
  });
  ipcMain.removeHandler(IPC.appRuntime.accountDataRequest);
  ipcMain.handle(IPC.appRuntime.accountDataRequest, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    const permission = queryAppPermission(
      runtime.installations.snapshot(),
      identity,
      "account-data",
    );
    if (!permission.declared || permission.state !== "granted") {
      throw Object.assign(
        new Error("account-data is not granted for this App in the current Space."),
        { code: "PERMISSION_DENIED" },
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Account-data request must be an object.");
    }
    const startedAt = performance.now();
    try {
      return await requestAppAccountData({
        apiUrl: penkraAccountServices.apiUrl,
        appId: identity.appId,
        cookie: getPenkraAccountCookie(),
        request: input as import("./appAccountData").AppAccountDataRequest,
      });
    } finally {
      void runtime.diagnostics
        .record({
          kind: "permission-used",
          appId: identity.appId,
          spaceId: identity.spaceId,
          operation: "account-data-request",
          durationMs: Math.round(performance.now() - startedAt),
        })
        .catch(() => undefined);
    }
  });
  ipcMain.removeHandler(IPC.appRuntime.accountDataSubscribeStart);
  ipcMain.handle(IPC.appRuntime.accountDataSubscribeStart, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    const permission = queryAppPermission(
      runtime.installations.snapshot(),
      identity,
      "account-data",
    );
    if (!permission.declared || permission.state !== "granted") {
      throw Object.assign(
        new Error("account-data is not granted for this App in the current Space."),
        { code: "PERMISSION_DENIED" },
      );
    }
    const channel =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as { channel?: unknown }).channel
        : undefined;
    if (typeof channel !== "string") throw new Error("Account-data channel must be a string.");
    const subscriptionId = Crypto.randomUUID();
    const senderId = event.sender.id;
    const subscription = await subscribeAppAccountData({
      apiUrl: penkraAccountServices.apiUrl,
      appId: identity.appId,
      cookie: getPenkraAccountCookie(),
      channel,
      onEvent: (accountEvent) => {
        const target = webContents.fromId(senderId);
        if (!target || target.isDestroyed()) return;
        target.send(IPC.appRuntime.accountDataEvent, {
          subscriptionId,
          event: accountEvent,
        });
      },
      onConnectionStateChange: (connectionState) => {
        const target = webContents.fromId(senderId);
        if (!target || target.isDestroyed()) return;
        target.send(IPC.appRuntime.accountDataEvent, {
          subscriptionId,
          connectionState,
        });
      },
    });
    appAccountSubscriptions.set(subscriptionId, {
      senderId,
      stop: subscription.stop,
    });
    event.sender.once("destroyed", () => {
      const active = appAccountSubscriptions.get(subscriptionId);
      if (!active) return;
      active.stop();
      appAccountSubscriptions.delete(subscriptionId);
    });
    return subscriptionId;
  });
  ipcMain.removeHandler(IPC.appRuntime.accountDataSubscribeStop);
  ipcMain.handle(IPC.appRuntime.accountDataSubscribeStop, async (event, input: unknown) => {
    const subscriptionId =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as { subscriptionId?: unknown }).subscriptionId
        : undefined;
    if (typeof subscriptionId !== "string") {
      throw new Error("Account-data subscription ID must be a string.");
    }
    const active = appAccountSubscriptions.get(subscriptionId);
    if (!active || active.senderId !== event.sender.id) return;
    active.stop();
    appAccountSubscriptions.delete(subscriptionId);
  });
  ipcMain.removeHandler(IPC.appRuntime.simulatorCall);
  ipcMain.handle(IPC.appRuntime.simulatorCall, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (!identity.tabId) throw new Error("Only an interactive App tab can host a simulator.");
    const simulatorRuntime = desktopSimulatorRuntime;
    if (!simulatorRuntime) throw new Error("The Simulator host service is not ready.");
    const permission = queryAppPermission(
      runtime.installations.snapshot(),
      identity,
      "simulator-session",
    );
    if (!permission.declared || permission.state !== "granted") {
      throw Object.assign(
        new Error("simulator-session is not granted for this App in the current Space."),
        { code: "PERMISSION_DENIED" },
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Simulator call must be an object.");
    }
    const { method, input: value } = input as Record<string, unknown>;
    if (typeof method !== "string") throw new Error("Simulator call method is required.");
    const owner = {
      appId: identity.appId,
      spaceId: identity.spaceId,
      tabId: identity.tabId,
    };
    if (!appSimulatorTrackedRendererIds.has(event.sender.id)) {
      appSimulatorTrackedRendererIds.add(event.sender.id);
      event.sender.once("destroyed", () => {
        appSimulatorTrackedRendererIds.delete(event.sender.id);
        simulatorHostedSurfaces?.closeTab(owner.tabId);
        void desktopSimulatorRuntime?.manager.closeTab(owner.tabId).catch((error) => {
          console.warn(
            `[penkra-app] Simulator cleanup failed after renderer exit: ${formatErrorMessage(error)}`,
          );
        });
      });
    }
    const startedAt = performance.now();
    try {
      return await invokeSimulatorCall({
        manager: simulatorRuntime.manager,
        owner,
        method,
        value,
        viewport:
          simulatorHostedSurfaces ??
          (() => {
            throw Object.assign(new Error("The hosted Simulator viewport is not ready."), {
              code: "HOSTED_VIEW_UNAVAILABLE",
            });
          })(),
        authorizeSetup: async (request) => {
          const runtimeInfo = request.runtimeId
            ? (await simulatorRuntime.manager.listRuntimes()).find(
                (candidate) =>
                  candidate.id === request.runtimeId && candidate.platform === request.platform,
              )
            : null;
          const platformName = request.platform === "ios" ? "iOS Simulator" : "Android";
          const setupName = runtimeInfo?.name ?? `${platformName} support`;
          const options: Electron.MessageBoxOptions = {
            type: "question",
            buttons: ["Install", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: "Install simulator support",
            message: `Install ${setupName}?`,
            detail:
              `Penkra will run ${
                request.platform === "ios"
                  ? "Xcode for Apple platform files, or npm for the pinned Appium/XCUITest automation pair when it is missing"
                  : "the official Android SDK Manager"
              }. ` +
              "This downloads platform files and uses additional disk space. Penkra does not accept license terms automatically, and you can cancel while the installer is running.",
          };
          const result = mainWindow
            ? await dialog.showMessageBox(mainWindow, options)
            : await dialog.showMessageBox(options);
          return result.response === 0;
        },
      });
    } finally {
      void runtime.diagnostics
        .record({
          kind: "permission-used",
          appId: identity.appId,
          spaceId: identity.spaceId,
          operation: `simulator-${method}`,
          durationMs: Math.round(performance.now() - startedAt),
        })
        .catch(() => undefined);
    }
  });
  ipcMain.removeHandler(IPC.simulatorViewer.input);
  ipcMain.handle(IPC.simulatorViewer.input, async (event, input: unknown) => {
    const factory = simulatorViewerFactory;
    if (!factory) throw new Error("The Simulator viewer is not ready.");
    await factory.invokeInput(event.sender.id, input);
  });
  ipcMain.removeHandler(IPC.appRuntime.settingGet);
  ipcMain.handle(IPC.appRuntime.settingGet, async (event, key: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (typeof key !== "string") throw new Error("Setting key must be a string.");
    return runtime.installations.getSetting({ ...identity, key });
  });
  ipcMain.removeHandler(IPC.appRuntime.settingSet);
  ipcMain.handle(IPC.appRuntime.settingSet, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Setting input must be an object.");
    const { key, value } = input as Record<string, unknown>;
    if (typeof key !== "string") throw new Error("Setting key must be a string.");
    await runtime.installations.setSetting({ ...identity, key, value });
  });
  ipcMain.removeHandler(IPC.appRuntime.settingReset);
  ipcMain.handle(IPC.appRuntime.settingReset, async (event, key: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (typeof key !== "string") throw new Error("Setting key must be a string.");
    await runtime.installations.resetSetting({ ...identity, key });
  });
  ipcMain.removeHandler(IPC.appRuntime.secretGet);
  ipcMain.handle(IPC.appRuntime.secretGet, async (event, name: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (typeof name !== "string") throw new Error("Secret name must be a string.");
    return runtime.vault.getSecret(identity.appId, identity.spaceId, name);
  });
  ipcMain.removeHandler(IPC.appRuntime.secretSet);
  ipcMain.handle(IPC.appRuntime.secretSet, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Secret input must be an object.");
    const { name, value } = input as Record<string, unknown>;
    if (typeof name !== "string" || typeof value !== "string")
      throw new Error("Secret name and value must be strings.");
    await runtime.vault.setSecret(identity.appId, identity.spaceId, name, value);
  });
  ipcMain.removeHandler(IPC.appRuntime.secretDelete);
  ipcMain.handle(IPC.appRuntime.secretDelete, async (event, name: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (typeof name !== "string") throw new Error("Secret name must be a string.");
    await runtime.vault.deleteSecret(identity.appId, identity.spaceId, name);
  });
  ipcMain.removeHandler(IPC.appRuntime.browserCall);
  ipcMain.handle(IPC.appRuntime.browserCall, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    if (!identity.tabId) throw new Error("Only an interactive App tab can host browser pages.");
    const permission = queryAppPermission(
      runtime.installations.snapshot(),
      identity,
      "browser-session",
    );
    if (!permission.declared || permission.state !== "granted") {
      throw Object.assign(
        new Error("browser-session is not granted for this App in the current Space."),
        { code: "PERMISSION_DENIED" },
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Browser call must be an object.");
    }
    const { method, input: value } = input as Record<string, unknown>;
    if (typeof method !== "string") throw new Error("Browser call method is required.");
    const threadId = identity.tabId as ThreadId;
    if (!appBrowserTrackedRendererIds.has(event.sender.id)) {
      appBrowserTrackedRendererIds.add(event.sender.id);
      event.sender.once("destroyed", () => {
        appBrowserTrackedRendererIds.delete(event.sender.id);
        appBrowserViewportByRendererId.delete(event.sender.id);
        if (browserManager.hasSession(threadId)) browserManager.close({ threadId });
      });
    }
    browserManager.setSessionPartition(
      threadId,
      createScopedBrowserSessionPartition(identity.appId, identity.spaceId),
    );
    const state = () => toAppBrowserState(browserManager.getState({ threadId }));
    const pageId = () => {
      if (typeof value !== "string" || !value) throw new Error("Browser page ID is required.");
      return value;
    };
    switch (method) {
      case "open":
        return toAppBrowserState(
          browserManager.open({
            threadId,
            ...(typeof value === "string" && value ? { initialUrl: value } : {}),
          }),
        );
      case "close":
        browserManager.close({ threadId });
        return;
      case "getState":
        return state();
      case "setViewport": {
        if (value === null) {
          appBrowserViewportByRendererId.delete(event.sender.id);
          browserManager.setHostedPanelBounds({
            threadId,
            bounds: null,
            hostBounds: null,
            parentView: null,
          });
          return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Browser viewport must be bounds or null.");
        }
        const local = value as Record<string, unknown>;
        const values = [local.x, local.y, local.width, local.height];
        if (
          !values.every((candidate) => typeof candidate === "number" && Number.isFinite(candidate))
        ) {
          throw new Error("Browser viewport bounds must be finite numbers.");
        }
        appBrowserViewportByRendererId.set(
          event.sender.id,
          appTabCssBoundsToNativeBounds(
            {
              x: local.x as number,
              y: local.y as number,
              width: local.width as number,
              height: local.height as number,
            },
            event.sender.getZoomFactor(),
          ),
        );
        syncHostedBrowserViewport(event.sender.id);
        return;
      }
      case "navigate": {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Browser navigation input is required.");
        const record = value as Record<string, unknown>;
        if (typeof record.url !== "string" || !record.url.trim())
          throw new Error("Browser navigation URL is required.");
        return toAppBrowserState(
          browserManager.navigate({
            threadId,
            url: record.url,
            ...(typeof record.pageId === "string" ? { tabId: record.pageId } : {}),
          }),
        );
      }
      case "reload":
        return toAppBrowserState(browserManager.reload({ threadId, tabId: pageId() }));
      case "stop":
        return toAppBrowserState(browserManager.stop({ threadId, tabId: pageId() }));
      case "back":
        return toAppBrowserState(browserManager.goBack({ threadId, tabId: pageId() }));
      case "forward":
        return toAppBrowserState(browserManager.goForward({ threadId, tabId: pageId() }));
      case "newPage": {
        const record =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        return toAppBrowserState(
          browserManager.newTab({
            threadId,
            ...(typeof record.url === "string" ? { url: record.url } : {}),
            ...(typeof record.activate === "boolean" ? { activate: record.activate } : {}),
          }),
        );
      }
      case "closePage":
        return toAppBrowserState(browserManager.closeTab({ threadId, tabId: pageId() }));
      case "selectPage":
        return toAppBrowserState(browserManager.selectTab({ threadId, tabId: pageId() }));
      case "find": {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Browser find input is required.");
        const record = value as Record<string, unknown>;
        if (typeof record.pageId !== "string" || typeof record.text !== "string")
          throw new Error("Browser find requires pageId and text.");
        const action = record.action;
        if (
          action !== undefined &&
          action !== "search" &&
          action !== "next" &&
          action !== "previous"
        )
          throw new Error("Browser find action is invalid.");
        return browserManager.findInPage({
          threadId,
          tabId: record.pageId,
          text: record.text,
          action: action ?? "search",
        });
      }
      case "stopFind":
        browserManager.stopFindInPage({ threadId, tabId: pageId() });
        return;
      case "capture": {
        const result = await browserManager.captureScreenshot({
          threadId,
          tabId: pageId(),
        });
        return {
          dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString("base64")}`,
        };
      }
      case "evaluate": {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Browser evaluate input is required.");
        const record = value as Record<string, unknown>;
        if (typeof record.pageId !== "string" || typeof record.expression !== "string")
          throw new Error("Browser evaluate requires pageId and expression.");
        if (Buffer.byteLength(record.expression) > 100_000)
          throw new Error("Browser expressions may contain at most 100,000 bytes.");
        const response = await browserManager.executeCdp({
          threadId,
          tabId: record.pageId,
          method: "Runtime.evaluate",
          params: {
            expression: record.expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false,
          },
        });
        const result =
          response && typeof response === "object"
            ? (response as {
                result?: { value?: unknown; description?: string };
                exceptionDetails?: unknown;
              })
            : {};
        if (result.exceptionDetails)
          throw new Error(result.result?.description ?? "Browser evaluation failed.");
        return result.result?.value ?? null;
      }
      default:
        throw new Error(`Unsupported browser method: ${method}.`);
    }
  });
  ipcMain.removeHandler(IPC.appRuntime.networkFetch);
  ipcMain.handle(IPC.appRuntime.networkFetch, async (event, input: unknown) => {
    const { runtime, identity } = requireAppRenderer(event.sender.id);
    const permission = queryAppPermission(
      runtime.installations.snapshot(),
      identity,
      "network-fetch",
    );
    if (!permission.declared || permission.state !== "granted") {
      throw Object.assign(
        new Error("network-fetch is not granted for this App in the current Space."),
        { code: "PERMISSION_DENIED" },
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Network request must be an object.");
    const startedAt = performance.now();
    try {
      return await mediatedAppFetch(input as import("./appNetworkFetch").AppNetworkFetchRequest);
    } finally {
      void runtime.diagnostics
        .record({
          kind: "permission-used",
          appId: identity.appId,
          spaceId: identity.spaceId,
          operation: "network-fetch",
          durationMs: Math.round(performance.now() - startedAt),
        })
        .catch(() => undefined);
    }
  });
  const requireAppInstallations = (senderId: number) => {
    const service = desktopAppRuntime?.installations;
    if (!service) throw new Error("The App installation service is not ready.");
    const isShellRenderer = mainWindow?.webContents.id === senderId;
    if (!isShellRenderer && !desktopAppRuntime?.canManageInstallations(senderId)) {
      throw new Error("This renderer cannot manage App installations.");
    }
    return {
      service,
      currentSpaceId: isShellRenderer
        ? undefined
        : (desktopAppRuntime?.installationSpaceId(senderId) ?? undefined),
    };
  };
  for (const channel of Object.values(IPC.appInstallations)) {
    if (channel !== IPC.appInstallations.state) ipcMain.removeHandler(channel);
  }
  ipcMain.handle(IPC.appInstallations.getState, async (event) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    return toDesktopAppInstallationSnapshot(
      service.snapshot(),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.setEnabled, async (event, input: unknown) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    return toDesktopAppInstallationSnapshot(
      await service.setEnabled(parseSetAppEnabledRequest(input)),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.setPermission, async (event, input: unknown) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    const request = parseSetAppPermissionRequest(input);
    return toDesktopAppInstallationSnapshot(
      await (isAppStandardPermissionName(request.permission)
        ? service.setRuntimePermission({
            ...request,
            permission: request.permission,
          })
        : service.setPermission(request)),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.getSettings, async (event, input: unknown) => {
    const { service } = requireAppInstallations(event.sender.id);
    return toDesktopAppSettings(service.listSettings(parseAppSettingTarget(input)));
  });
  ipcMain.handle(IPC.appInstallations.setSetting, async (event, input: unknown) => {
    const { service } = requireAppInstallations(event.sender.id);
    const request = parseAppSettingValue(input);
    await service.setSetting(request);
    return toDesktopAppSettings(service.listSettings(request));
  });
  ipcMain.handle(IPC.appInstallations.resetSetting, async (event, input: unknown) => {
    const { service } = requireAppInstallations(event.sender.id);
    const request = parseAppSettingKey(input);
    await service.resetSetting(request);
    return toDesktopAppSettings(service.listSettings(request));
  });
  ipcMain.handle(IPC.appInstallations.setSkillEnabled, async (event, input: unknown) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    return toDesktopAppInstallationSnapshot(
      await service.setSkillEnabled(parseSetAppSkillEnabledRequest(input)),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.uninstall, async (event, input: unknown) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    return toDesktopAppInstallationSnapshot(
      await service.uninstall(parseUninstallAppRequest(input)),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.removeData, async (event, input: unknown) => {
    const { service, currentSpaceId } = requireAppInstallations(event.sender.id);
    return toDesktopAppInstallationSnapshot(
      await service.removeData(parseRemoveAppDataRequest(input)),
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });

  const requireAppsRegistry = (senderId: number) => {
    if (!desktopAppRuntime?.canManageInstallations(senderId)) {
      throw new Error("This renderer cannot access the App registry.");
    }
    if (!appRegistryClient) throw new Error("The App registry is not ready.");
    return appRegistryClient;
  };
  ipcMain.handle(IPC.appInstallations.installRegistry, async (event, input: unknown) => {
    const request = parseInstallRegistryAppRequest(input);
    const registry = requireAppsRegistry(event.sender.id);
    const runtime = desktopAppRuntime;
    if (!runtime) throw new Error("The App runtime is not ready.");
    const currentSpaceId = runtime.installationSpaceId(event.sender.id);
    if (!currentSpaceId || currentSpaceId !== request.spaceId) {
      throw new Error("Apps can only be installed into the current Space.");
    }
    const state = await installRegistryApp({
      request,
      hostVersion: app.getVersion(),
      registry,
      packages: runtime.packages,
      installations: runtime.installations,
    });
    return toDesktopAppInstallationSnapshot(
      state,
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.updateRegistry, async (event, input: unknown) => {
    const request = parseUpdateRegistryAppRequest(input);
    const registry = requireAppsRegistry(event.sender.id);
    const runtime = desktopAppRuntime;
    if (!runtime) throw new Error("The App runtime is not ready.");
    const currentSpaceId = runtime.installationSpaceId(event.sender.id);
    if (!currentSpaceId || currentSpaceId !== request.spaceId) {
      throw new Error("Apps can only be updated in the current Space.");
    }
    const state = await updateRegistryApp({
      request,
      hostVersion: app.getVersion(),
      registry,
      packages: runtime.packages,
      installations: runtime.installations,
    });
    return toDesktopAppInstallationSnapshot(
      state,
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  ipcMain.handle(IPC.appInstallations.rollbackRegistry, async (event, input: unknown) => {
    const request = parseRollbackRegistryAppRequest(input);
    const registry = requireAppsRegistry(event.sender.id);
    const runtime = desktopAppRuntime;
    if (!runtime) throw new Error("The App runtime is not ready.");
    const currentSpaceId = runtime.installationSpaceId(event.sender.id);
    if (!currentSpaceId || currentSpaceId !== request.spaceId) {
      throw new Error("Apps can only be rolled back in the current Space.");
    }
    const state = await rollbackRegistryApp({
      request,
      hostVersion: app.getVersion(),
      registry,
      packages: runtime.packages,
      installations: runtime.installations,
    });
    return toDesktopAppInstallationSnapshot(
      state,
      currentSpaceId,
      permissionReviewUpdatesForSpace(currentSpaceId),
    );
  });
  for (const channel of Object.values(IPC.appRegistry)) ipcMain.removeHandler(channel);
  ipcMain.handle(IPC.appRegistry.list, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).list(parseRegistryListRequest(input)),
  );
  ipcMain.handle(IPC.appRegistry.get, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).get(parseRegistryGetRequest(input)),
  );
  ipcMain.handle(IPC.appRegistry.getArtifact, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).getArtifact(parseRegistryArtifactRequest(input)),
  );
  ipcMain.handle(IPC.appRegistry.getFeedback, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).getFeedback(parseRegistryFeedbackRequest(input)),
  );
  ipcMain.handle(IPC.appRegistry.setRating, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).setRating(parseRegistryRatingRequest(input)),
  );
  ipcMain.handle(IPC.appRegistry.setReview, async (event, input: unknown) =>
    requireAppsRegistry(event.sender.id).setReview(parseRegistryReviewRequest(input)),
  );

  const requireShellAppTabs = (senderId: number) => {
    if (mainWindow?.webContents.id !== senderId) {
      throw new Error("Only the Penkra shell can manage host App tabs.");
    }
    const tabs = desktopAppRuntime?.appTabs;
    if (!tabs) throw new Error("The App tab host is not ready.");
    return tabs;
  };
  for (const channel of Object.values(IPC.appTabs)) {
    if (
      channel !== IPC.appTabs.opened &&
      channel !== IPC.appTabs.state &&
      channel !== IPC.appTabs.closed &&
      channel !== IPC.appTabs.listingRequested
    ) {
      ipcMain.removeHandler(channel);
    }
  }
  ipcMain.handle(IPC.appTabs.consumeListingRequest, async (event) => {
    requireShellAppTabs(event.sender.id);
    const request = pendingAppListingRequest;
    pendingAppListingRequest = null;
    return request;
  });
  ipcMain.handle(IPC.appTabs.open, async (event, input: unknown) => {
    const request = parseOpenAppTabRequest(input);
    if (isRequiredApp(request.appId)) {
      await reconcileConfiguredRequiredApps([request.spaceId]);
    }
    return requireShellAppTabs(event.sender.id).openInstalled(request);
  });
  ipcMain.handle(IPC.appTabs.openFromApps, async (event, input: unknown) => {
    if (!desktopAppRuntime?.canManageInstallations(event.sender.id)) {
      throw new Error("Only Apps can open an installed App.");
    }
    return desktopAppRuntime.appTabs.openInstalledFromRenderer(
      event.sender.id,
      parseOpenAppFromAppsRequest(input),
    );
  });
  ipcMain.handle(IPC.appTabs.list, async (event) => requireShellAppTabs(event.sender.id).list());
  ipcMain.handle(IPC.appTabs.attach, async (event, input: unknown) => {
    const { tabId, rendererId } = parseAppTabRendererRequest(input);
    requireShellAppTabs(event.sender.id).attach(tabId, rendererId);
  });
  ipcMain.handle(IPC.appTabs.setBounds, async (event, input: unknown) => {
    const { tabId, rendererId, bounds } = parseSetAppTabBoundsRequest(input);
    const tabs = requireShellAppTabs(event.sender.id);
    if (
      tabs.setBounds(
        tabId,
        rendererId,
        appTabCssBoundsToNativeBounds(bounds, event.sender.getZoomFactor()),
      )
    ) {
      syncHostedBrowserViewport(rendererId);
    }
  });
  ipcMain.handle(IPC.appTabs.setVisible, async (event, input: unknown) => {
    const { tabId, rendererId, visible } = parseSetAppTabVisibleRequest(input);
    const tabs = requireShellAppTabs(event.sender.id);
    // React cleanup can hide a pane after an atomic App update has already
    // retired its old renderer. Hiding a missing view is already satisfied.
    if (!tabs.setVisible(tabId, rendererId, visible)) return;
    if (visible) syncHostedBrowserViewport(rendererId);
    else hideHostedBrowserViewport(rendererId);
  });
  ipcMain.handle(IPC.appTabs.navigate, async (event, input: unknown) => {
    const { tabId, route, state } = parseNavigateAppTabRequest(input);
    await requireShellAppTabs(event.sender.id).navigate(tabId, {
      route,
      ...(state === undefined ? {} : { state }),
    });
  });
  ipcMain.handle(IPC.appTabs.close, async (event, input: unknown) => {
    const { tabId } = parseAppTabIdRequest(input);
    requireShellAppTabs(event.sender.id).close(tabId);
  });

  const parseOpenWithInput = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Open With input must be an object.");
    }
    const record = input as Record<string, unknown>;
    if (typeof record.spaceId !== "string" || !record.spaceId.trim()) {
      throw new Error("Open With spaceId is required.");
    }
    return record;
  };
  const requireOpenWithStore = (senderId: number) => {
    if (mainWindow?.webContents.id !== senderId) {
      throw new Error("Only the Penkra shell can manage Open With preferences.");
    }
    if (!desktopAppRuntime) throw new Error("The App runtime is not ready.");
    return desktopAppRuntime.openWith;
  };
  ipcMain.removeHandler(IPC.appOpenWith.get);
  ipcMain.handle(IPC.appOpenWith.get, async (event, input: unknown) => {
    const record = parseOpenWithInput(input);
    return requireOpenWithStore(event.sender.id).forSpace(record.spaceId as string);
  });
  ipcMain.removeHandler(IPC.appOpenWith.set);
  ipcMain.handle(IPC.appOpenWith.set, async (event, input: unknown) => {
    const record = parseOpenWithInput(input);
    if (record.intent !== "open-url") {
      throw new Error("Open With intent is invalid.");
    }
    if (record.appId !== null && (typeof record.appId !== "string" || !record.appId.trim())) {
      throw new Error("Open With appId must be a non-empty string or null.");
    }
    const store = requireOpenWithStore(event.sender.id);
    const state = await store.set(
      record.spaceId as string,
      record.intent,
      record.appId as string | null,
    );
    return state;
  });

  ipcMain.removeHandler(IPC.appDiagnostics.list);
  ipcMain.handle(IPC.appDiagnostics.list, async (event, input: unknown) => {
    if (mainWindow?.webContents.id !== event.sender.id) {
      throw new Error("Only the Penkra shell can read App diagnostics.");
    }
    if (!desktopAppRuntime) throw new Error("The App runtime is not ready.");
    if (
      input !== undefined &&
      (typeof input !== "object" || input === null || Array.isArray(input))
    ) {
      throw new Error("App diagnostics filters must be an object.");
    }
    const filters = (input ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(filters)) {
      if (!["appId", "spaceId", "limit"].includes(key))
        throw new Error(`Unknown App diagnostics filter ${key}.`);
    }
    if (filters.appId !== undefined && typeof filters.appId !== "string")
      throw new Error("appId must be a string.");
    if (filters.spaceId !== undefined && typeof filters.spaceId !== "string")
      throw new Error("spaceId must be a string.");
    if (
      filters.limit !== undefined &&
      (!Number.isInteger(filters.limit) || (filters.limit as number) < 1)
    ) {
      throw new Error("limit must be a positive integer.");
    }
    return desktopAppRuntime.diagnostics.list(
      filters as { appId?: string; spaceId?: string; limit?: number },
    );
  });

  ipcMain.removeAllListeners(IPC.wsUrl);
  ipcMain.on(IPC.wsUrl, (event: IpcMainEvent) => {
    // The backend port is reserved at runtime, so preload asks main for the
    // live URL instead of trusting build-time or inherited renderer env.
    event.returnValue =
      normalizeDesktopWsUrl(backendWsUrl) ?? resolveDesktopWsUrlFromEnv(process.env);
  });

  ipcMain.removeAllListeners(IPC.zoomFactor);
  ipcMain.on(IPC.zoomFactor, (event: IpcMainEvent) => {
    event.returnValue = event.sender.getZoomFactor();
  });

  ipcMain.removeHandler(IPC.pickFolder);
  ipcMain.handle(IPC.pickFolder, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(IPC.pickImage);
  ipcMain.handle(IPC.pickImage, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!selectedPath) return null;

    const extension = Path.extname(selectedPath).toLowerCase();
    const mimeType =
      extension === ".png"
        ? "image/png"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".gif"
            ? "image/gif"
            : "image/jpeg";
    const stats = await FS.promises.stat(selectedPath);
    if (stats.size > 20 * 1024 * 1024) {
      throw new Error("Folder icon source images may contain at most 20 MiB.");
    }
    return {
      name: Path.basename(selectedPath),
      mimeType,
      bytes: new Uint8Array(await FS.promises.readFile(selectedPath)),
    };
  });

  ipcMain.removeHandler(IPC.saveFile);
  ipcMain.handle(IPC.saveFile, async (_event, input: unknown) => {
    if (!isSaveFileInput(input)) {
      throw new Error("Invalid save file input.");
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options = {
      defaultPath: input.defaultFilename,
      ...(input.filters ? { filters: input.filters } : {}),
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    await FS.promises.writeFile(result.filePath, input.contents, "utf8");
    return result.filePath;
  });

  ipcMain.removeHandler(IPC.confirm);
  ipcMain.handle(IPC.confirm, async (_event, input: unknown) => {
    if (
      typeof input !== "string" &&
      (!input ||
        typeof input !== "object" ||
        typeof (input as { message?: unknown }).message !== "string")
    ) {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(input as Parameters<typeof showDesktopConfirmDialog>[0], owner);
  });

  ipcMain.removeHandler(IPC.setTheme);
  ipcMain.handle(IPC.setTheme, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });
  ipcMain.removeHandler(IPC.setAppTheme);
  ipcMain.handle(IPC.setAppTheme, async (event, rawTheme: unknown) => {
    if (mainWindow?.webContents.id !== event.sender.id) {
      throw new Error("Only the Penkra shell can set the App Theme contract.");
    }
    if (!desktopAppRuntime) throw new Error("The App runtime is not ready.");
    await desktopAppRuntime.appTabs.applyTheme(
      renderDesktopAppThemeCss(parseDesktopAppTheme(rawTheme)),
    );
  });
  ipcMain.removeHandler(IPC.setAppTypography);
  ipcMain.handle(IPC.setAppTypography, async (event, rawTypography: unknown) => {
    if (mainWindow?.webContents.id !== event.sender.id) {
      throw new Error("Only the Penkra shell can set the App Typography contract.");
    }
    if (!desktopAppRuntime) throw new Error("The App runtime is not ready.");
    await desktopAppRuntime.appTabs.applyTypography(
      renderDesktopAppTypographyCss(parseDesktopAppTypography(rawTypography)),
    );
  });

  ipcMain.removeHandler(IPC.setSpacesMenu);
  ipcMain.handle(IPC.setSpacesMenu, async (_event, input: unknown) => {
    const nextState = normalizeDesktopSpacesMenuInput(input);
    if (!nextState) return;
    spacesMenuState = nextState;
    await bootstrapConfiguredAppsForSpaces();
    configureApplicationMenu();
  });

  ipcMain.removeHandler(IPC.contextMenu);
  ipcMain.handle(
    IPC.contextMenu,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          separatorBefore: item.separatorBefore === true,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          const shouldInsertSeparator =
            item.separatorBefore ||
            (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0);
          if (shouldInsertSeparator && template.length > 0) {
            template.push({ type: "separator" });
          }
          if (item.destructive) {
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(IPC.openExternal);
  ipcMain.handle(IPC.openExternal, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(IPC.resourceOpen);
  ipcMain.handle(IPC.resourceOpen, async (event, input: unknown) => {
    if (mainWindow?.webContents.id !== event.sender.id) {
      throw new Error("Only the Penkra shell can open a host resource.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Resource open input must be an object.");
    }
    const record = input as Record<string, unknown>;
    if (typeof record.spaceId !== "string" || typeof record.threadId !== "string") {
      throw new Error("Resource open requires Space and Thread IDs.");
    }
    const path = typeof record.path === "string" ? record.path : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    if ((path === undefined) === (url === undefined)) {
      throw new Error("Resource open requires exactly one path or URL.");
    }
    const requestedApp = typeof record.requestedApp === "string" ? record.requestedApp : undefined;
    const context = {
      ...(requestedApp ? { requestedApp } : {}),
      spaceId: record.spaceId,
      threadId: record.threadId,
      callerKind: "user" as const,
    };
    return path
      ? openPenkraResource({ ...context, path })
      : openPenkraResource({ ...context, url: url! });
  });

  ipcMain.removeHandler(IPC.clipboardWriteImage);
  ipcMain.handle(IPC.clipboardWriteImage, async (_event, rawDataUrl: unknown) => {
    if (typeof rawDataUrl !== "string") {
      return false;
    }
    if (rawDataUrl.length > MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH) {
      return false;
    }

    const dataUrl = rawDataUrl.trim();
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return false;
    }

    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      return false;
    }

    clipboard.writeImage(image);
    return true;
  });

  ipcMain.removeHandler(IPC.showInFolder);
  ipcMain.handle(IPC.showInFolder, async (_event, rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("Missing folder path.");
    }
    const resolvedPath = Path.resolve(rawPath);

    let stats: FS.Stats;
    try {
      stats = await FS.promises.stat(resolvedPath);
    } catch {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }

    if (stats.isDirectory()) {
      const errorMessage = await shell.openPath(resolvedPath);
      if (errorMessage.trim().length > 0) {
        throw new Error(errorMessage);
      }
      return;
    }

    shell.showItemInFolder(resolvedPath);
  });

  ipcMain.removeHandler(IPC.windowMinimize);
  ipcMain.handle(IPC.windowMinimize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.minimize();
  });

  ipcMain.removeHandler(IPC.windowToggleMaximize);
  ipcMain.handle(IPC.windowToggleMaximize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) {
      return { isMaximized: false, isFullscreen: false };
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    const state = getDesktopWindowState(window);
    window.webContents.send(IPC.windowState, state);
    return state;
  });

  ipcMain.removeHandler(IPC.windowClose);
  ipcMain.handle(IPC.windowClose, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.close();
  });

  ipcMain.removeHandler(IPC.windowGetState);
  ipcMain.handle(IPC.windowGetState, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    return window ? getDesktopWindowState(window) : { isMaximized: false, isFullscreen: false };
  });

  ipcMain.removeHandler(IPC.updateGetState);
  ipcMain.handle(IPC.updateGetState, async () => updateState);

  ipcMain.removeHandler(IPC.updateCheck);
  ipcMain.handle(IPC.updateCheck, async () => {
    await checkForUpdates("renderer");
    return updateState;
  });

  ipcMain.removeHandler(IPC.updateDownload);
  ipcMain.handle(IPC.updateDownload, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.updateInstall);
  ipcMain.handle(IPC.updateInstall, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.notificationsIsSupported);
  ipcMain.handle(IPC.notificationsIsSupported, async () => Notification.isSupported());

  ipcMain.removeHandler(IPC.notificationsShow);
  ipcMain.handle(
    IPC.notificationsShow,
    async (
      _event,
      input:
        | {
            title?: unknown;
            body?: unknown;
            silent?: unknown;
            threadId?: unknown;
          }
        | null
        | undefined,
    ) =>
      showDesktopNotification({
        title: typeof input?.title === "string" ? input.title : "",
        body: typeof input?.body === "string" ? input.body : "",
        silent: input?.silent === true,
        ...(typeof input?.threadId === "string" ? { threadId: input.threadId } : {}),
      }),
  );

  ipcMain.removeHandler(IPC.mediaRequestMicrophoneAccess);
  ipcMain.handle(IPC.mediaRequestMicrophoneAccess, async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.sender.isDestroyed()) {
      return false;
    }
    if (desktopPlatform.browserPermissions.microphone !== "macos-system-prompt") {
      return true;
    }
    const status = systemPreferences.getMediaAccessStatus("microphone");
    const allowed = await resolveMicrophonePermissionRequest({
      status,
      askForAccess: () => systemPreferences.askForMediaAccess("microphone"),
    });
    console.info(
      `[desktop-media] Explicit microphone access status=${status} allowed=${String(allowed)}.`,
    );
    return allowed;
  });
  ipcMain.removeHandler(IPC.powerSetActiveWork);
  ipcMain.handle(IPC.powerSetActiveWork, (event, input: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.sender.isDestroyed()) {
      return;
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof (input as Record<string, unknown>).threadExecution !== "boolean" ||
      typeof (input as Record<string, unknown>).voice !== "boolean"
    ) {
      throw new Error("Invalid active-work power state.");
    }
    const activeWorkState = input as {
      threadExecution: boolean;
      voice: boolean;
    };
    activeWorkPowerBlocker.setOwnerState(event.sender.id, {
      threadExecution: activeWorkState.threadExecution,
      voice: activeWorkState.voice,
    });
  });
  registerDesktopVoiceTranscriptionHandler();
  startBrowserPerformanceLogging();
}

function getIconOption(): { icon: string } | Record<string, never> {
  const ext = desktopPlatform.icons.window;
  if (!ext) return {}; // macOS uses .icns from app bundle
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

// macOS backs the translucent shell with window vibrancy, so the window is created
// transparent (`#00000000`) over the vibrancy material. Windows/Linux have no vibrancy:
// a transparent window there leaves backdrop-filter surfaces bleeding through and, on
// fractional DPI, rendering blurry. So off macOS we create an opaque window and skip the
// macOS-only options. The background tracks the OS light/dark appearance purely to avoid
// a bright flash before the renderer paints — the window is shown only after first paint
// (`show: false`), so this color is not expected to match a custom in-app theme exactly.
function getWindowMaterialOptions(): BrowserWindowConstructorOptions {
  if (desktopPlatform.window.material === "opaque") {
    return {
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
    };
  }
  return {
    vibrancy: "under-window",
    // "followWindow" lets macOS drop vibrancy blending to inactive when the
    // window is backgrounded, so WindowServer stops continuously recompositing
    // it. "active" forced full-cost blending even when the app was unfocused.
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  };
}

// macOS keeps native traffic lights inset into the renderer's top chrome. Windows
// uses a fully frameless shell and renderer-owned minimize/maximize/close controls,
// so the toolbar can occupy the top edge instead of sitting below a native title bar.
function getTitleBarOptions(): BrowserWindowConstructorOptions {
  if (desktopPlatform.window.titleBar === "windows-frameless") {
    return { frame: false };
  }
  if (desktopPlatform.window.titleBar !== "macos-hidden-inset") {
    return {};
  }
  return {
    titleBarStyle: "hiddenInset",
    // Derived from the shared chat-surface header geometry (@penkra/shared/desktopChrome)
    // so the native lights and the renderer's leading toggle/arrow controls always share
    // the same vertical center. Tune the height/radius there, never the raw px here.
    trafficLightPosition: getMacTrafficLightPosition(),
  };
}

function createWindow(): BrowserWindow {
  const savedWindowState = readDesktopWindowState(DESKTOP_WINDOW_STATE_PATH);
  const primaryDisplay = screen.getPrimaryDisplay();
  const restoredBounds = savedWindowState
    ? resolveVisibleWindowBounds({
        savedBounds: savedWindowState.bounds,
        displayWorkAreas: [
          primaryDisplay.workArea,
          ...screen
            .getAllDisplays()
            .filter((display) => display.id !== primaryDisplay.id)
            .map((display) => display.workArea),
        ],
        minimumWidth: 840,
        minimumHeight: 620,
      })
    : { width: 1100, height: 780 };
  const window = new BrowserWindow({
    ...restoredBounds,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getTitleBarOptions(),
    ...getWindowMaterialOptions(),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Let Chromium throttle renderer timers/rAF when the window is hidden.
      backgroundThrottling: true,
    },
  });
  const rendererOwnerId = window.webContents.id;
  // `ready-to-show` is not guaranteed by every development compositor path.
  // A completed main-frame load is an equally valid event-driven fallback.
  const showInitialWindow = createInitialWindowPresenter({
    window,
    maximize: !savedWindowState || savedWindowState.isMaximized,
    onShown: (source) => {
      emitDesktopWindowState(window);
      writeDesktopLogHeader(`main window shown source=${source}`);
    },
  });
  browserManager.setWindow(window);
  attachDesktopZoomFactorSync(window);
  attachRendererCrashRecovery(window);
  attachDesktopWindowZoomShortcuts(window.webContents);

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
    showInitialWindow("did-finish-load");
    if (desktopSmokeUserDataPath) {
      void window.webContents
        .executeJavaScript(
          "({ location: location.href, isSecureContext, hasMediaDevices: typeof navigator.mediaDevices !== 'undefined', hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function' })",
        )
        .then((capabilities) => {
          console.info(`[desktop-smoke] renderer-capabilities ${JSON.stringify(capabilities)}`);
        });
    }
  });
  window.once("ready-to-show", () => showInitialWindow("ready-to-show"));

  window.on("maximize", () => emitDesktopWindowState(window));
  window.on("unmaximize", () => emitDesktopWindowState(window));
  window.on("enter-full-screen", () => emitDesktopWindowState(window));
  window.on("leave-full-screen", () => emitDesktopWindowState(window));
  window.on("close", (event) => {
    try {
      writeDesktopWindowState(DESKTOP_WINDOW_STATE_PATH, {
        version: 1,
        bounds: window.getNormalBounds(),
        isMaximized: window.isMaximized(),
      });
    } catch (error) {
      console.warn(`[desktop] Failed to persist window state: ${formatErrorMessage(error)}`);
    }

    if (
      shouldDeferDesktopWindowClose({
        platform: desktopPlatform.platform,
        shutdownComplete: desktopShutdownComplete,
        updaterHandoffActive: isUpdaterQuitAndInstallInFlight,
      })
    ) {
      event.preventDefault();
      requestGracefulAppQuit("window-close");
    }
  });

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(desktopIdentity.entryUrl);
  }

  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (!isInPlace && isMainFrame) {
      activeWorkPowerBlocker.releaseOwner(rendererOwnerId);
    }
  });

  window.on("closed", () => {
    activeWorkPowerBlocker.releaseOwner(rendererOwnerId);
    if (mainWindow === window) {
      mainWindow = null;
    }
    browserManager.setWindow(null);
  });

  return window;
}

/**
 * Renderer crashes used to be entirely invisible to the main process: no listener, no
 * log line, no telemetry, and no way back — a renderer OOM kill just left the user
 * staring at a blank window. Recovery is deliberately narrow: only reasons the renderer
 * can actually come back from reload, and only a few times, because a deterministic
 * crash reloading forever is worse than one blank window.
 */
function attachRendererCrashRecovery(window: BrowserWindow): void {
  const rendererOwnerId = window.webContents.id;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const clearReloadTimer = (): void => {
    if (reloadTimer === null) return;
    clearTimeout(reloadTimer);
    reloadTimer = null;
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    activeWorkPowerBlocker.releaseOwner(rendererOwnerId);
    const description = `reason=${details.reason} exitCode=${details.exitCode}`;
    writeDesktopLogHeader(`renderer process gone ${description}`);
    safeConsoleError(`[desktop] renderer process gone (${description})`);

    const response = rendererCrashPolicy.respondToCrash({
      reason: details.reason,
      quitting: isQuitting,
      nowMs: Date.now(),
    });

    switch (response.kind) {
      case "ignore":
        return;
      case "reload":
        writeDesktopLogHeader(
          `renderer reload scheduled attempt=${response.attempt}/${RENDERER_MAX_AUTOMATIC_RELOADS} delayMs=${response.delayMs}`,
        );
        clearReloadTimer();
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          if (isQuitting || window.isDestroyed()) return;
          window.webContents.reload();
        }, response.delayMs);
        return;
      case "prompt":
        writeDesktopLogHeader(
          `renderer recovery prompt cause=${response.cause} crashes=${response.crashes}`,
        );
        presentRendererCrashRecovery(window, details.reason, response);
        return;
    }
  });

  // A hung renderer is not a crash — Chromium keeps the process alive — so it never
  // reaches the listener above. Logging both edges makes a freeze that the user
  // reports as "the app died" distinguishable from an actual crash in the same log.
  window.webContents.on("unresponsive", () => {
    writeDesktopLogHeader("renderer unresponsive");
  });
  window.webContents.on("responsive", () => {
    writeDesktopLogHeader("renderer responsive");
  });

  window.on("closed", clearReloadTimer);
}

/**
 * Replaces the blank window with a blocking, actionable one once automatic recovery
 * stops (or was never allowed for this crash reason).
 */
function presentRendererCrashRecovery(
  window: BrowserWindow,
  reason: string,
  response: Extract<RendererCrashResponse, { kind: "prompt" }>,
): void {
  if (isQuitting || rendererCrashDialogInFlight) return;

  const message =
    response.cause === "reload-budget-exhausted"
      ? `Penkra's window crashed ${response.crashes} times in a row.`
      : "Penkra's window stopped unexpectedly.";
  const detail = [
    `The window's renderer process exited (${reason}).`,
    response.cause === "reload-budget-exhausted"
      ? "Penkra paused automatic reloads so a repeating crash can't keep reloading in the background."
      : "This exit reason repeats on reload, so Penkra did not retry automatically.",
    `Log file:\n${Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME)}`,
  ].join("\n\n");

  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Penkra's window stopped",
        message,
        detail,
        buttons: ["Reload", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven reload is a fresh start, not a continuation of the streak.
        rendererCrashPolicy.reset();
        if (!window.isDestroyed()) {
          window.webContents.reload();
        }
        return;
      }

      requestGracefulAppQuit("renderer crashed");
      return;
    }
  })().finally(() => {
    if (rendererCrashDialogInFlight === task) {
      rendererCrashDialogInFlight = null;
    }
  });
  rendererCrashDialogInFlight = task;
}

function configureMediaPermissions(): void {
  for (const { targetSession, trustedRequester } of [
    {
      targetSession: session.defaultSession,
      trustedRequester: () => mainWindow?.webContents ?? null,
    },
    {
      targetSession: session.fromPartition(BROWSER_SESSION_PARTITION),
      trustedRequester: () => null,
    },
  ]) {
    if (!targetSession) continue;

    targetSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) =>
        permission === "media" &&
        isTrustedMediaPermissionRequest(webContents, trustedRequester(), details, requestingOrigin),
    );

    targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (
        permission !== "media" ||
        !isTrustedMediaPermissionRequest(webContents, trustedRequester(), details)
      ) {
        callback(false);
        return;
      }

      if (desktopPlatform.browserPermissions.microphone === "macos-system-prompt") {
        const status = systemPreferences.getMediaAccessStatus("microphone");
        void resolveMicrophonePermissionRequest({
          status,
          askForAccess: () => systemPreferences.askForMediaAccess("microphone"),
        }).then((allowed) => {
          console.info(
            `[desktop-media] Microphone permission request status=${status} allowed=${String(allowed)}.`,
          );
          callback(allowed);
        });
        return;
      }

      callback(true);
    });
  }
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
if (hasSingleInstanceLock) {
  repairBrowserProfileBeforeElectronReady(userDataPath);
  const accountAuthRuntime = configurePenkraAccountAuth({
    accountAuthScheme: desktopIdentity.accountAuthScheme,
    authBaseUrl: penkraAccountServices.authBaseUrl,
    desktopFlavor,
    developmentInstance,
    getWindow: () => mainWindow,
    ipcMain,
    registerAsDefaultProtocolClient: !desktopSmokeUserDataPath,
    inspectInitialProtocolUrlFromArgv: desktopPlatform.deepLinks.inspectInitialArgv,
    websiteOrigin: penkraAccountServices.websiteOrigin,
  });
  getPenkraAccountId = accountAuthRuntime.getAccountId;
  getPenkraAccountCookie = accountAuthRuntime.getCookie;
  appRegistryClient = new AppRegistryClient({
    apiUrl: penkraAccountServices.apiUrl,
    getCookie: accountAuthRuntime.getCookie,
    getAccountId: accountAuthRuntime.getAccountId,
    trustedRegistryKeys: parseRegistryTrustKeys(
      process.env.PENKRA_REGISTRY_TRUSTED_KEYS ?? __PENKRA_REGISTRY_TRUSTED_KEYS__,
    ),
    policyCachePath: Path.join(STATE_DIR, "registry-app-policy.jws"),
    receiptQueuePath: Path.join(STATE_DIR, "registry-install-receipts.json"),
  });
}

configureAppIdentity();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("open-url", (event, value) => {
    const request = parseAppListingDeepLink(value);
    if (!request) return;
    event.preventDefault();
    requestAppListing(request);
  });
  app.on("second-instance", (_event, commandLine) => {
    const request = commandLine.toReversed().map(parseAppListingDeepLink).find(Boolean);
    if (request) requestAppListing(request);
    focusMainWindow({ stealAppFocus: true });
  });
}

function requestAppListing(request: { appId: string }): void {
  pendingAppListingRequest = request;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.appTabs.listingRequested, request);
  focusMainWindow();
}

if (desktopPlatform.deepLinks.inspectInitialArgv) {
  pendingAppListingRequest ??=
    process.argv.toReversed().map(parseAppListingDeepLink).find(Boolean) ?? null;
}

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  // Ahead of the recovery gate on purpose. A startup that blocks below returns
  // early, and every path that could ship the fix for whatever blocked it lives
  // after that return: an install wedged on a bad migration would be unable to
  // update out of it, which is exactly how 0.6.0 stranded its users. The
  // updater touches no database state, so configuring it first is safe.
  configureAutoUpdater();

  const migrationRecoveryOutcome = await handleDesktopMigrationRecovery();
  if (migrationRecoveryOutcome !== "continue") {
    return;
  }

  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  await reserveBackendEndpoint("bootstrap");

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  desktopAppRuntime = await startDesktopAppRuntime({
    userDataPath: app.getPath("userData"),
    appPreloadPath: Path.join(__dirname, "appPreload.js"),
    ipcMain,
    getAccountId: getPenkraAccountId,
    requestStandardPermissions: async (request) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const labels = request.permissions.map((permission) => APP_STANDARD_PERMISSIONS[permission]);
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: `${request.appName} permission`,
        message: `${request.appName} would like to ${labels.join(" and ").toLowerCase()}.`,
        detail:
          "This permission applies only to this App in the current Space and can be changed in Settings.",
        buttons: ["Don't Allow", "Allow"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    window: () => mainWindow,
    onTabOpened: (descriptor) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.appTabs.opened, descriptor);
    },
    onTabState: (descriptor) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.appTabs.state, descriptor);
    },
    onTabClosed: (descriptor) => {
      simulatorHostedSurfaces?.closeTab(descriptor.id);
      void desktopSimulatorRuntime?.manager.closeTab(descriptor.id).catch((error) => {
        console.warn(
          `[penkra-app] Simulator cleanup failed after tab close: ${formatErrorMessage(error)}`,
        );
      });
      const browserSessionId = descriptor.id as ThreadId;
      if (browserManager.hasSession(browserSessionId)) {
        browserManager.close({ threadId: browserSessionId });
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.appTabs.closed, descriptor);
    },
    onTabRendererCreated: (renderer) => attachDesktopWindowZoomShortcuts(renderer),
    onInvalidRendererMessage: (error, senderId) => {
      console.warn(
        `[penkra-app] Rejected invalid renderer message sender=${senderId}: ${formatErrorMessage(error)}`,
      );
    },
    assertAppAllowed: async (installedApp) => {
      const release = installedApp.registryRelease;
      if (!release) return;
      if (!appRegistryClient) throw new Error("The App registry security policy is unavailable.");
      const policy = await appRegistryClient.getSecurityPolicy();
      assertRegistryReleaseAllowed(policy, {
        appId: release.appId,
        versionId: release.versionId,
        publisherId: release.publisherId ?? "",
      });
    },
  });
  const requiredAppsSource = resolveRequiredAppsBundle({
    ...(process.env[REQUIRED_APPS_SOURCE_PATH_ENV] === undefined
      ? {}
      : { configuredSourcePath: process.env[REQUIRED_APPS_SOURCE_PATH_ENV] }),
    resourcesPath: process.resourcesPath,
    desktopBundleDirectory: __dirname,
    packaged: app.isPackaged,
  });
  if (!requiredAppsSource) {
    throw new Error(
      app.isPackaged
        ? "This Penkra installation does not contain its required Apps package. Update or reinstall Penkra."
        : `Required Apps source is unavailable. Set ${REQUIRED_APPS_SOURCE_PATH_ENV} to the Apps package directory.`,
    );
  }
  requiredAppsPackageIsDevelopmentSource = isDevelopment && requiredAppsSource.kind === "directory";
  requiredAppsPackageLoad = loadRequiredAppsPackage({
    runtime: desktopAppRuntime,
    source: requiredAppsSource,
    hostVersion: app.getVersion(),
  });
  requiredAppsPackage = await requiredAppsPackageLoad;
  writeDesktopLogHeader(
    `bootstrap required Apps package ready version=${requiredAppsPackage.manifest.version} digest=${requiredAppsPackage.sha256}`,
  );
  const simulatorAdapters = await createDesktopSimulatorAdapterBundle({
    platform: desktopPlatform.platform,
    userDataPath: app.getPath("userData"),
    reviewAndroidLicense: (prompt, signal) =>
      queueAndroidSdkLicenseReview({
        parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
        preloadPath: Path.join(__dirname, "simulatorLicenseReviewPreload.js"),
        prompt,
        signal,
      }),
  });
  desktopSimulatorRuntime = await openDesktopSimulatorHostRuntime({
    userDataPath: app.getPath("userData"),
    adapters: simulatorAdapters.adapters,
    disposeResources: () => simulatorAdapters.dispose(),
  });
  simulatorViewerFactory = new ElectronSimulatorViewerFactory({
    manager: desktopSimulatorRuntime.manager,
    preloadPath: Path.join(__dirname, "simulatorViewerPreload.js"),
  });
  simulatorHostedSurfaces = new HostedSurfaceRegistry({
    factory: simulatorViewerFactory,
    resolveParent: (owner) => {
      const runtime = desktopAppRuntime;
      if (!runtime) return null;
      try {
        const rendererId = runtime.appTabs.rendererId(owner.tabId);
        return runtime.appTabs.rendererView(rendererId) as unknown as HostedSurfaceParent;
      } catch {
        return null;
      }
    },
  });
  if (desktopSimulatorRuntime.recovery) {
    console.error(
      `[penkra-app] Quarantined corrupt Simulator state at ${desktopSimulatorRuntime.recovery.quarantinedPath}: ${desktopSimulatorRuntime.recovery.error.message}`,
    );
  }
  unsubscribeSimulatorState = desktopSimulatorRuntime.manager.subscribe((owner, state) => {
    const runtime = desktopAppRuntime;
    if (!runtime) return;
    try {
      const target = runtime.appTabs.observationWebContents(owner.tabId);
      if (!target.isDestroyed()) target.send(IPC.appRuntime.simulatorState, state);
    } catch {
      // The tab may have closed between the native state transition and delivery.
    }
  });
  if (desktopAppRuntime.safeStartRecovery) {
    console.error(
      `[penkra-app] Quarantined corrupt installation state at ${desktopAppRuntime.safeStartRecovery.quarantinedPath}: ${desktopAppRuntime.safeStartRecovery.error.message}`,
    );
  }
  if (desktopAppRuntime.updateRecovery?.status === "restored") {
    console.warn(
      `[penkra-app] Restored ${desktopAppRuntime.updateRecovery.appId} after interrupted update to ${desktopAppRuntime.updateRecovery.targetVersion}.`,
    );
  } else if (desktopAppRuntime.updateRecovery?.status === "corrupt") {
    console.error(
      `[penkra-app] Quarantined corrupt update journal at ${desktopAppRuntime.updateRecovery.quarantinedPath}: ${desktopAppRuntime.updateRecovery.error.message}`,
    );
  }
  if (desktopAppRuntime.packageGarbageCollection.removedPaths.length > 0) {
    console.info(
      `[penkra-app] Removed ${desktopAppRuntime.packageGarbageCollection.removedPaths.length} unreferenced App package entr${desktopAppRuntime.packageGarbageCollection.removedPaths.length === 1 ? "y" : "ies"}.`,
    );
  }
  for (const failure of desktopAppRuntime.packageGarbageCollection.failures) {
    console.warn(
      `[penkra-app] Unable to remove unreferenced package entry ${failure.path}: ${failure.error.message}`,
    );
  }
  void appRegistryClient?.reconcileInstallReceipts().catch((error) => {
    console.warn(
      `[penkra-app] Install receipt reconciliation failed: ${formatErrorMessage(error)}`,
    );
  });
  developmentSideloadRegistry = isDevelopment
    ? new DevelopmentAppSideloadRegistry({
        runtime: desktopAppRuntime,
        onApplied: async (result) => {
          console.info(
            `[penkra-app] Development sideload ${result.status} after local rebuild in Space ${result.spaceId}: ${result.sourcePath}`,
          );
          await notifyOpenAppsInstallationState();
        },
        onError: (error, context) => {
          console.warn(
            `[penkra-app] Development sideload rebuild was not applied for ${context.appId} in Space ${context.spaceId}; the working package remains active: ${formatErrorMessage(error)}`,
          );
        },
      })
    : null;
  try {
    await bootstrapConfiguredAppsForSpaces();
  } catch (error) {
    console.error("Unable to bootstrap configured Apps.", error);
  }
  desktopAppRuntime.installations.subscribe((state) => {
    void toDesktopAppInstallationSnapshot(state).then((snapshot) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.appInstallations.state, snapshot);
    });
  });
  writeDesktopLogHeader("bootstrap App runtime started");
  const appTabObserver = new AppTabObserver({
    resolve: async (tabId) => {
      const descriptor = desktopAppRuntime!.appTabs
        .list()
        .find((candidate) => candidate.id === tabId);
      if (!descriptor) throw new Error(`App tab ${tabId} is unavailable.`);
      return resolveAppTabObservationTarget({
        descriptor,
        browserAppId: BROWSER_APP_ID,
        appWebContents: (targetTabId) =>
          desktopAppRuntime!.appTabs.observationWebContents(targetTabId),
        // A public browser-session is isolated to the App tab that owns it;
        // DesktopBrowserManager retains the older `threadId` parameter name.
        browserWebContents: (appTabId) =>
          browserManager.observationWebContents(appTabId as ThreadId),
        hostedWebContents: (appTabId) =>
          (simulatorHostedSurfaces?.observationTarget(appTabId) as WebContents | null) ?? null,
      });
    },
  });
  appCommandPipeServer = new AppCommandPipeServer({
    path: resolveAppCommandPipePath(app.getPath("userData")),
    token: Crypto.randomBytes(32).toString("hex"),
    catalog: desktopAppRuntime.operationCatalog,
    broker: desktopAppRuntime.broker,
    tabs: desktopAppRuntime.appTabs,
    observer: appTabObserver,
    providerCredentialVault: desktopAppRuntime.providerCredentialVault,
    registry: appRegistryClient,
    open: openPenkraResource,
    sideload: async ({ sourcePath, spaceId }) => {
      if (!isDevelopment || !developmentSideloadRegistry) {
        throw new Error("App sideloading is available only in Penkra development.");
      }
      const targetSpaceId =
        spaceId ?? spacesMenuState.activeSpaceId ?? spacesMenuState.spaces[0]?.id ?? null;
      if (!targetSpaceId || !spacesMenuState.spaces.some((space) => space.id === targetSpaceId)) {
        throw new Error("The requested development Space is unavailable.");
      }
      const result = await developmentSideloadRegistry.register(sourcePath, targetSpaceId);
      console.info(
        `[penkra-app] Development sideload ${result.status} in Space ${result.spaceId}: ${result.sourcePath}`,
      );
      await notifyOpenAppsInstallationState();
      return result;
    },
  });
  await appCommandPipeServer.start();
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    void waitForBackendWindowReady(backendHttpUrl)
      .then((source) => {
        writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created");
        }
      })
      .catch((error) => {
        if (isBackendReadinessAborted(error)) {
          return;
        }
        writeDesktopLogHeader(
          `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
        );
        console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created after readiness warning");
        }
      });
    return;
  }

  ensureInitialBackendWindowOpen(backendHttpUrl);
}

app.on("before-quit", (event) => {
  writeDesktopLogHeader("before-quit received");
  if (desktopShutdownComplete) {
    return;
  }

  if (isUpdaterQuitAndInstallInFlight) {
    // Electron's updater owns this quit; canceling it would turn install into a plain app quit.
    try {
      if (
        !activeUpdateInstallHandoff ||
        !markInstallHandoffSync(getUpdateInstallMarkerPath(), activeUpdateInstallHandoff)
      ) {
        throw new Error("Durable update install handoff no longer matches the active attempt.");
      }
    } catch (error) {
      event.preventDefault();
      const failedHandoff = activeUpdateInstallHandoff;
      clearUpdaterInstallInFlightAfterError();
      const consecutiveFailures = recordInstallMarkerFailure(
        new Date().toISOString(),
        failedHandoff,
      );
      startBackend();
      scheduleUpdatePoll();
      setUpdateState({
        ...reduceDesktopUpdateStateOnInstallFailure(
          updateState,
          "The downloaded update could not be handed to the installer safely.",
        ),
        installFailureCount: consecutiveFailures,
      });
      console.error(
        `[desktop-updater] Refused mismatched install handoff during quit: ${formatErrorMessage(error)}`,
      );
      return;
    }
    writeDesktopLogHeader("before-quit allowing updater quit-and-install");
    return;
  }

  if (isUpdaterInstallPreparing) {
    // Keep user/system quits from preempting the pending updater install with a plain app.quit().
    writeDesktopLogHeader("before-quit waiting for updater quit-and-install");
    event.preventDefault();
    return;
  }

  event.preventDefault();
  requestGracefulAppQuit("before-quit");
});

app.on("will-quit", () => {
  activeWorkPowerBlocker.shutdown();
});

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      writeDesktopLogHeader("app ready");
      configureAppIdentity();
      applyLegacyMacDockIcon();
      refreshMacIconCacheOnVersionChange();
      configureMediaPermissions();
      configureApplicationMenu();
      try {
        registerDesktopProtocol();
      } catch (error) {
        if (error instanceof BundleChangedDuringStartupError) {
          restartAfterStartupBundleSwap(error);
          return;
        }
        throw error;
      }
      startBundleSwapWatcher();
      void bootstrap().catch((error) => {
        handleFatalStartupError("bootstrap", error);
      });

      app.on("browser-window-blur", () => {
        markDesktopAppBackgrounded();
      });

      app.on("browser-window-focus", () => {
        handleDesktopAppForegrounded();
      });

      app.on("activate", () => {
        if (desktopStartupBlockedForMigrationRecovery || isQuitting) {
          return;
        }
        handleDesktopAppForegrounded();
        if (BrowserWindow.getAllWindows().length === 0) {
          if (!isDevelopment) {
            ensureInitialBackendWindowOpen(backendHttpUrl);
            return;
          }
          void waitForBackendWindowReady(backendHttpUrl)
            .catch((error) => {
              if (isBackendReadinessAborted(error)) {
                return;
              }
              console.warn(
                "[desktop] backend readiness check timed out during dev activate",
                error,
              );
            })
            .finally(() => {
              if (!mainWindow) {
                mainWindow = createWindow();
              }
            });
          return;
        }
        focusMainWindow();
      });
    })
    .catch((error) => {
      handleFatalStartupError("whenReady", error);
    });
}

// GPU, utility, and pepper process failures never reach the window's renderer listener,
// so without this they are invisible too. Chromium respawns these itself — the value is
// the log line that explains a sudden loss of GPU acceleration or a dead audio/network
// service. Clean exits are routine teardown, so they stay out of the log.
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  const attributes = [
    `type=${details.type}`,
    `reason=${details.reason}`,
    `exitCode=${details.exitCode}`,
    ...(details.serviceName ? [`service=${details.serviceName}`] : []),
    ...(details.name ? [`name=${sanitizeLogValue(details.name)}`] : []),
  ].join(" ");
  writeDesktopLogHeader(`child process gone ${attributes}`);
  safeConsoleError(`[desktop] child process gone (${attributes})`);
});

app.on("window-all-closed", () => {
  if (desktopPlatform.application.quitWhenAllWindowsClose) {
    app.quit();
  }
});

if (desktopPlatform.processLifecycle.registerPosixShutdownSignals) {
  process.on("uncaughtException", (error: unknown) => {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("EPIPE received");
    requestGracefulAppQuit("EPIPE");
  });

  process.on("SIGINT", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGINT received");
    requestGracefulAppQuit("SIGINT");
  });

  process.on("SIGTERM", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGTERM received");
    requestGracefulAppQuit("SIGTERM");
  });
}
