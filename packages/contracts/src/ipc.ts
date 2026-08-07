import type {
  AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthLogoutResult,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "./auth";
import type {
  GitCheckoutInput,
  GitActionProgressEvent,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitCreateDetachedWorktreeResult,
  GitHubRepositoryInput,
  GitHubRepositoryResult,
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitWorkingTreeDiffStatsResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStageFilesInput,
  GitStageFilesResult,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizeDiffInput,
  GitSummarizeDiffResult,
  GitUnstageFilesInput,
  GitUnstageFilesResult,
} from "./git";
import type {
  PullRequestActionInput,
  PullRequestActionResult,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestReviewRequestCountInput,
  PullRequestReviewRequestCountResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  PullRequestsListInput,
  PullRequestsListResult,
} from "./pullRequests";
import type {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDevServersResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRunDevServerInput,
  ProjectRunDevServerResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectStopDevServerInput,
  ProjectStopDevServerResult,
  ProjectWriteFileInput,
  ProjectWorkspaceChangeEvent,
  ProjectWriteFileResult,
} from "./project";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import type { StudioListThreadOutputsInput, StudioListThreadOutputsResult } from "./studio";
import type {
  ServerConfig,
  ServerDiagnosticsResult,
  ServerGenerateThreadRecapInput,
  ServerGenerateThreadRecapResult,
  ServerGetEnvironmentResult,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerGetSettingsResult,
  ServerListLocalServersResult,
  ServerListWorktreesResult,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerRefreshProvidersResult,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerSpaceNavigationState,
  ServerUpdateSpaceNavigationStateInput,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";
import type {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetThreadDetailSnapshotInput,
  OrchestrationGetThreadDetailSnapshotResult,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationListProviderDeliveryBlockersInput,
  OrchestrationListProviderDeliveryBlockersResult,
  OrchestrationReconcileProviderDeliveryInput,
  OrchestrationReconcileProviderDeliveryResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration";
import type { EditorId } from "./editor";
import type { ThreadId } from "./baseSchemas";
import type {
  ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from "./providerDiscovery";
import type { ProviderCompactThreadInput } from "./provider";
import type {
  StatsGetProfileStatsInput,
  StatsGetProfileStatsResult,
  StatsGetProfileTokenStatsInput,
  StatsGetProfileTokenStatsResult,
} from "./stats";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  /** Starts a new visual group before this actionable row. */
  separatorBefore?: boolean;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopAppTheme {
  variant: "light" | "dark";
  tokens: {
    background: string;
    panel: string;
    surface: string;
    control: string;
    selected: string;
    overlay: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    border: string;
    focus: string;
    accent: string;
    success: string;
    warning: string;
    destructive: string;
    info: string;
    fontSans: string;
  };
}

export interface DesktopAppTypography {
  base: string;
  small: string;
  meta: string;
  large: string;
}

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  installFailureCount: number;
  // Public URL where the user can manually download the release when the
  // in-app updater cannot apply it (silent installer failure, unsigned build,
  // read-only install location, unsupported platform). Null when no GitHub
  // update source is configured.
  releaseUrl: string | null;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  status: "live" | "suspended";
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
}

export interface ThreadBrowserState {
  threadId: ThreadId;
  version: number;
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  lastError: string | null;
}

export interface BrowserOpenInput {
  threadId: ThreadId;
  initialUrl?: string;
}

export interface BrowserThreadInput {
  threadId: ThreadId;
}

export interface BrowserTabInput {
  threadId: ThreadId;
  tabId: string;
}

export interface BrowserNavigateInput {
  threadId: ThreadId;
  tabId?: string;
  url: string;
}

export interface BrowserNewTabInput {
  threadId: ThreadId;
  url?: string;
  activate?: boolean;
}

export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSetPanelBoundsInput {
  threadId: ThreadId;
  bounds: BrowserPanelBounds | null;
  surface?: "native" | "renderer";
}

export interface BrowserAttachWebviewInput extends BrowserTabInput {
  webContentsId: number;
}

export interface BrowserDetachWebviewInput extends BrowserTabInput {
  webContentsId: number;
}

export interface BrowserCaptureScreenshotResult {
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  bytes: Uint8Array;
}

export interface BrowserExecuteCdpInput extends BrowserTabInput {
  method: string;
  params?: Record<string, unknown>;
}

export interface BrowserFindInPageInput extends BrowserTabInput {
  text: string;
  action: "search" | "next" | "previous";
}

export interface BrowserFindInPageResult {
  activeMatchOrdinal: number;
  matches: number;
}

// Pushed from the desktop main process when the Browser App copy-link chord fires
// while the native page (not the React chrome) holds keyboard focus.
export interface BrowserCopyLinkEvent {
  threadId: ThreadId;
  url: string;
}

export interface BrowserControlMethods {
  open: (input: BrowserOpenInput) => Promise<ThreadBrowserState>;
  close: (input: BrowserThreadInput) => Promise<ThreadBrowserState>;
  hide: (input: BrowserThreadInput) => Promise<void>;
  getState: (input: BrowserThreadInput) => Promise<ThreadBrowserState>;
  setPanelBounds: (input: BrowserSetPanelBoundsInput) => Promise<void>;
  attachWebview: (input: BrowserAttachWebviewInput) => Promise<ThreadBrowserState>;
  detachWebview: (input: BrowserDetachWebviewInput) => Promise<void>;
  copyLink: (input: BrowserTabInput) => Promise<void>;
  copyScreenshotToClipboard: (input: BrowserTabInput) => Promise<void>;
  captureScreenshot: (input: BrowserTabInput) => Promise<BrowserCaptureScreenshotResult>;
  executeCdp: (input: BrowserExecuteCdpInput) => Promise<unknown>;
  findInPage?: (input: BrowserFindInPageInput) => Promise<BrowserFindInPageResult>;
  stopFindInPage?: (input: BrowserTabInput) => Promise<void>;
  navigate: (input: BrowserNavigateInput) => Promise<ThreadBrowserState>;
  reload: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  goBack: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  goForward: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  newTab: (input: BrowserNewTabInput) => Promise<ThreadBrowserState>;
  closeTab: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  selectTab: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  openDevTools: (input: BrowserTabInput) => Promise<void>;
  onState: (listener: (state: ThreadBrowserState) => void) => () => void;
}

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  silent?: boolean;
  threadId?: ThreadId;
}

export interface DesktopWindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
}

export interface DesktopAccountUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export type DesktopAccountAuthState =
  | { status: "authenticated"; user: DesktopAccountUser }
  | { status: "unauthenticated" }
  | { status: "error"; message: string };

export interface DesktopAccountAuthError {
  message: string;
}

export interface DesktopAccountAuthCallback {
  intent: "sign-in" | "sign-up" | null;
}

export interface PenkraStorageSnapshot {
  readonly version: 1;
  readonly exportedAt: string;
  readonly entries: Readonly<Record<string, string>>;
}

export interface DesktopConfirmOptions {
  cancelLabel?: string;
  confirmLabel?: string;
  detail?: string;
  message: string;
  title?: string;
  type?: "question" | "warning";
}

export interface DesktopSpacesMenuInput {
  activeSpaceId: string | null;
  spaces: ReadonlyArray<{
    id: string;
    name: string;
  }>;
}

export interface DesktopInstalledApp {
  id: string;
  spaceId: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
  source: "registry" | "sideload";
  installedAt: string;
  /** Verified package icon for trusted launcher and tab presentation. */
  iconDataUrl: string | null;
  permissions: ReadonlyArray<{
    name: string;
    required: boolean;
    reason: string;
  }>;
  skills: ReadonlyArray<{ path: string }>;
  handlers: ReadonlyArray<
    | { intent: "open-url"; operation: string; schemes: ReadonlyArray<string> }
    | {
        intent: "open-file";
        operation: string;
        extensions: ReadonlyArray<string>;
      }
    | { intent: "open-directory"; operation: string }
  >;
}

export interface DesktopSpaceAppState {
  appId: string;
  spaceId: string;
  enabled: boolean;
  permissions: Readonly<Record<string, "denied" | "granted">>;
  skills: Readonly<Record<string, boolean>>;
}

export interface DesktopAppInstallationSnapshot {
  installed: ReadonlyArray<DesktopInstalledApp>;
  spaces: ReadonlyArray<DesktopSpaceAppState>;
  /** Present only for an App-owned renderer bound to one Space. */
  currentSpaceId?: string;
  /** Trusted compatible updates that require the user to review expanded permissions. */
  permissionReviewUpdates?: ReadonlyArray<{
    appId: string;
    installedVersion: string;
    availableVersion: string;
    permissions: ReadonlyArray<string>;
  }>;
}

export type DesktopAppSetting = {
  key: string;
  label: string;
  description?: string;
  configured: boolean;
  migrationId?: string;
} & (
  | { type: "boolean"; default: boolean; value: boolean }
  | {
      type: "string";
      default: string;
      sensitive: boolean;
      value?: string;
      validation?: { minLength?: number; maxLength?: number };
    }
  | {
      type: "number";
      default: number;
      value: number;
      validation?: { minimum?: number; maximum?: number; step?: number };
    }
  | {
      type: "select";
      default: string;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
    }
);

export interface DesktopAppInstallationBridge {
  getState: () => Promise<DesktopAppInstallationSnapshot>;
  installRegistry: (input: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, "denied" | "granted">>;
  }) => Promise<DesktopAppInstallationSnapshot>;
  updateRegistry: (input: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, "denied" | "granted">>;
  }) => Promise<DesktopAppInstallationSnapshot>;
  rollbackRegistry: (input: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, "denied" | "granted">>;
  }) => Promise<DesktopAppInstallationSnapshot>;
  setEnabled: (input: {
    appId: string;
    spaceId: string;
    enabled: boolean;
  }) => Promise<DesktopAppInstallationSnapshot>;
  setPermission: (input: {
    appId: string;
    spaceId: string;
    permission: string;
    grant: "denied" | "granted";
  }) => Promise<DesktopAppInstallationSnapshot>;
  getSettings: (input: {
    appId: string;
    spaceId: string;
  }) => Promise<ReadonlyArray<DesktopAppSetting>>;
  setSetting: (input: {
    appId: string;
    spaceId: string;
    key: string;
    value: boolean | number | string;
  }) => Promise<ReadonlyArray<DesktopAppSetting>>;
  resetSetting: (input: {
    appId: string;
    spaceId: string;
    key: string;
  }) => Promise<ReadonlyArray<DesktopAppSetting>>;
  setSkillEnabled: (input: {
    appId: string;
    spaceId: string;
    path: string;
    enabled: boolean;
  }) => Promise<DesktopAppInstallationSnapshot>;
  uninstall: (input: {
    appId: string;
    spaceId: string;
    retainData: boolean;
  }) => Promise<DesktopAppInstallationSnapshot>;
  removeData: (input: {
    appId: string;
    spaceId: string;
  }) => Promise<DesktopAppInstallationSnapshot>;
  onState: (listener: (state: DesktopAppInstallationSnapshot) => void) => () => void;
}

export interface DesktopRegistryAppSummary {
  id: string;
  identifier: string;
  slug: string;
  displayName: string;
  summary: string;
  visibility: "public" | "private";
  publisher: {
    slug: string;
    displayName: string;
    domain: string | null;
    verified: boolean;
  };
  latestVersion: string;
  iconAssetId: string | null;
  installCount: number;
  rating: number | null;
  ratingCount: number;
}

export interface DesktopRegistryAppDetail extends DesktopRegistryAppSummary {
  screenshots: ReadonlyArray<{
    id: string;
    position: number;
    altText: string;
  }>;
  versions: ReadonlyArray<{
    id: string;
    version: string;
    packageDigest: string;
    compatibilityRange: string;
    publishedAt: string;
    readmeArtifactId: string;
    instructionsArtifactId: string;
    publisherSignatureArtifactId: string;
    registrySignatureArtifactId: string;
    validationReportArtifactId: string;
    permissions: ReadonlyArray<{
      permission: string;
      required: boolean;
      rationale: string;
    }>;
  }>;
}

export interface DesktopRegistryAccountFeedback {
  appId: string;
  eligible: true;
  installedAt: string;
  rating: number | null;
  review: {
    body: string;
    status: "pending" | "published" | "rejected" | "removed";
    updatedAt: string;
  } | null;
}

export interface DesktopAppRegistryBridge {
  list: (input?: { query?: string; cursor?: string; limit?: number }) => Promise<{
    items: ReadonlyArray<DesktopRegistryAppSummary>;
    pageInfo: { nextCursor: string | null };
  }>;
  get: (input: { slug: string }) => Promise<DesktopRegistryAppDetail>;
  getArtifact: (input: {
    id: string;
    source: "artifact" | "asset";
  }) => Promise<
    | { kind: "text"; contentType: string; text: string }
    | { kind: "image"; contentType: string; dataUrl: string }
  >;
  getFeedback: (input: { appId: string }) => Promise<DesktopRegistryAccountFeedback>;
  setRating: (input: { appId: string; rating: number }) => Promise<{
    appId: string;
    rating: number;
    updatedAt: string;
  }>;
  setReview: (input: { appId: string; body: string }) => Promise<{
    appId: string;
    body: string;
    status: "pending";
    updatedAt: string;
  }>;
}

export interface DesktopAppTabDescriptor {
  id: string;
  rendererId: number;
  appId: string;
  slug: string;
  name: string;
  iconDataUrl: string | null;
  spaceId: string;
  threadId: string;
  route: string;
  status: "loading" | "ready" | "crashed";
}

export interface DesktopAppTabClosed {
  id: string;
  threadId: string;
}

export interface DesktopAppTabsBridge {
  list: () => Promise<ReadonlyArray<DesktopAppTabDescriptor>>;
  consumeListingRequest: () => Promise<{ appId: string } | null>;
  open: (input: {
    appId: string;
    spaceId: string;
    threadId: string;
    route: string;
    state?: unknown;
  }) => Promise<DesktopAppTabDescriptor>;
  attach: (input: { tabId: string; rendererId: number }) => Promise<void>;
  setBounds: (input: {
    tabId: string;
    rendererId: number;
    bounds: { x: number; y: number; width: number; height: number };
  }) => Promise<void>;
  setVisible: (input: { tabId: string; rendererId: number; visible: boolean }) => Promise<void>;
  navigate: (input: { tabId: string; route: string; state?: unknown }) => Promise<void>;
  close: (input: { tabId: string }) => Promise<void>;
  onListingRequested: (listener: (input: { appId: string }) => void) => () => void;
  onOpened: (listener: (tab: DesktopAppTabDescriptor) => void) => () => void;
  onState: (listener: (tab: DesktopAppTabDescriptor) => void) => () => void;
  onClosed: (listener: (tab: DesktopAppTabClosed) => void) => () => void;
}

export interface DesktopResourceOpenInput {
  path?: string;
  url?: string;
  requestedApp?: string;
  spaceId: string;
  threadId: string;
}

export interface DesktopResourcesBridge {
  open(input: DesktopResourceOpenInput): Promise<{
    destination: "app" | "system";
    intent: "open-url" | "open-file" | "open-directory";
    appId?: string;
    slug?: string;
  }>;
}

export interface DesktopAppDiagnosticEntry {
  id: string;
  timestamp: string;
  kind:
    | "operation-completed"
    | "operation-failed"
    | "permission-used"
    | "runtime-disabled"
    | "tab-crashed"
    | "tab-opened"
    | "tab-ready"
    | "tab-responsive"
    | "tab-unresponsive";
  appId: string;
  spaceId: string;
  tabId?: string;
  operation?: string;
  durationMs?: number;
  memoryBytes?: number;
  message?: string;
}

export interface DesktopAppDiagnosticsBridge {
  list: (input?: {
    appId?: string;
    spaceId?: string;
    limit?: number;
  }) => Promise<ReadonlyArray<DesktopAppDiagnosticEntry>>;
}

export type DesktopAppOpenIntent = "open-url" | "open-file" | "open-directory";

export interface DesktopAppOpenWithPreferences {
  "open-url"?: string;
  "open-directory"?: string;
  files: Readonly<Record<string, string>>;
}

export interface DesktopAppOpenWithBridge {
  get: (input: { spaceId: string }) => Promise<DesktopAppOpenWithPreferences>;
  set: (input: {
    spaceId: string;
    intent: DesktopAppOpenIntent;
    extension?: string;
    appId: string | null;
  }) => Promise<DesktopAppOpenWithPreferences>;
}

export interface DesktopComposerAssetDescriptor {
  id: string;
  draftId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  committedBytes: number;
}

export interface DesktopVoiceDraftDescriptor {
  id: string;
  threadId: string;
  providerThreadId?: string;
  cwd: string;
  sampleRateHz: number;
  state: "recording" | "ready";
  committedBytes: number;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopComposerDraftsBridge {
  readSnapshot: () => Promise<string | null>;
  writeSnapshot: (value: string) => Promise<void>;
  removeSnapshot: () => Promise<void>;
  writeAsset: (input: {
    id: string;
    draftId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }) => Promise<DesktopComposerAssetDescriptor>;
  readAsset: (id: string) => Promise<Uint8Array | null>;
  deleteAsset: (id: string) => Promise<void>;
  createVoice: (input: DesktopVoiceDraftDescriptor) => Promise<void>;
  appendVoice: (input: {
    id: string;
    sequence: number;
    bytes: Uint8Array;
  }) => Promise<DesktopVoiceDraftDescriptor>;
  completeVoice: (id: string) => Promise<DesktopVoiceDraftDescriptor>;
  listVoices: () => Promise<DesktopVoiceDraftDescriptor[]>;
  readVoice: (id: string) => Promise<Uint8Array | null>;
  deleteVoice: (id: string) => Promise<void>;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  /**
   * Absolute filesystem path for a File from drag/drop or file inputs.
   * Electron only (`webUtils.getPathForFile`). Returns null when unavailable.
   */
  getPathForFile?: (file: File) => string | null;
  pickFolder: () => Promise<string | null>;
  saveFile?: (input: {
    defaultFilename: string;
    contents: string;
    filters?: ReadonlyArray<{
      name: string;
      extensions: ReadonlyArray<string>;
    }>;
  }) => Promise<string | null>;
  confirm: (input: string | DesktopConfirmOptions) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setAppTheme?: (theme: DesktopAppTheme) => Promise<void>;
  setAppTypography?: (typography: DesktopAppTypography) => Promise<void>;
  setSpacesMenu?: (input: DesktopSpacesMenuInput) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  showInFolder: (path: string) => Promise<void>;
  shell?: {
    showInFolder: (path: string) => Promise<void>;
  };
  clipboard?: {
    writeImagePngDataUrl: (dataUrl: string) => Promise<boolean>;
  };
  windowControls?: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<DesktopWindowState>;
    close: () => Promise<void>;
    getState: () => Promise<DesktopWindowState>;
    onState: (listener: (state: DesktopWindowState) => void) => () => void;
  };
  onMenuAction: (listener: (action: string) => void) => () => void;
  /** Current `webContents` page zoom (1 = 100%). Used to keep macOS traffic-light gutter aligned. */
  getZoomFactor: () => number;
  onZoomFactorChange: (listener: (zoomFactor: number) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  notifications: {
    isSupported: () => Promise<boolean>;
    show: (input: DesktopNotificationInput) => Promise<boolean>;
  };
  media?: {
    /** Resolve the native OS grant before Chromium opens the audio device. */
    requestMicrophoneAccess: () => Promise<boolean>;
    /** Keep the display awake only while this renderer is actively recording voice. */
    setVoiceRecordingActive: (recordingId: string, active: boolean) => Promise<void>;
  };
  composerDrafts?: DesktopComposerDraftsBridge;
  accountAuth?: {
    getState: () => Promise<DesktopAccountAuthState>;
    requestSignIn: () => Promise<void>;
    requestSignUp: () => Promise<void>;
    signOut: () => Promise<void>;
    onCallbackStarted: (listener: (callback: DesktopAccountAuthCallback) => void) => () => void;
    onAuthenticated: (listener: (user: DesktopAccountUser) => void) => () => void;
    onUserUpdated: (listener: (user: DesktopAccountUser | null) => void) => () => void;
    onError: (listener: (error: DesktopAccountAuthError) => void) => () => void;
  };
  appInstallations?: DesktopAppInstallationBridge;
  appRegistry?: DesktopAppRegistryBridge;
  appTabs?: DesktopAppTabsBridge;
  resources?: DesktopResourcesBridge;
  appDiagnostics?: DesktopAppDiagnosticsBridge;
  appOpenWith?: DesktopAppOpenWithBridge;
  storageMigration: {
    readSnapshot: () => PenkraStorageSnapshot | null;
    acknowledgeSnapshot: () => Promise<void>;
  };
  server?: {
    transcribeVoice: (
      input: ServerVoiceTranscriptionInput,
    ) => Promise<ServerVoiceTranscriptionResult>;
  };
  browserUse: {
    onOpenRequest: (listener: () => void) => () => void;
  };
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    saveFile?: (input: {
      defaultFilename: string;
      contents: string;
      filters?: ReadonlyArray<{
        name: string;
        extensions: ReadonlyArray<string>;
      }>;
    }) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    ackOutput: (input: TerminalAckOutputInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    discoverScripts: (input: ProjectDiscoverScriptsInput) => Promise<ProjectDiscoverScriptsResult>;
    listDirectories: (input: ProjectListDirectoriesInput) => Promise<ProjectListDirectoriesResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    searchLocalEntries: (
      input: ProjectSearchLocalEntriesInput,
    ) => Promise<ProjectSearchLocalEntriesResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    createLocalFilePreviewGrant: (
      input: ProjectCreateLocalFilePreviewGrantInput,
    ) => Promise<ProjectCreateLocalFilePreviewGrantResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    runDevServer: (input: ProjectRunDevServerInput) => Promise<ProjectRunDevServerResult>;
    stopDevServer: (input: ProjectStopDevServerInput) => Promise<ProjectStopDevServerResult>;
    listDevServers: () => Promise<ProjectListDevServersResult>;
    onDevServerEvent: (callback: (event: ProjectDevServerEvent) => void) => () => void;
    onWorkspaceChange: (callback: (event: ProjectWorkspaceChangeEvent) => void) => () => void;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  studio: {
    listThreadOutputs: (
      input: StudioListThreadOutputsInput,
    ) => Promise<StudioListThreadOutputsResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    showInFolder: (path: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    githubRepository: (input: GitHubRepositoryInput) => Promise<GitHubRepositoryResult>;
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    createDetachedWorktree: (
      input: GitCreateDetachedWorktreeInput,
    ) => Promise<GitCreateDetachedWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    stashAndCheckout: (input: GitStashAndCheckoutInput) => Promise<void>;
    stashDrop: (input: GitStashDropInput) => Promise<void>;
    stashInfo: (input: GitStashInfoInput) => Promise<GitStashInfoResult>;
    removeIndexLock: (input: GitRemoveIndexLockInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    stageFiles: (input: GitStageFilesInput) => Promise<GitStageFilesResult>;
    unstageFiles: (input: GitUnstageFilesInput) => Promise<GitUnstageFilesResult>;
    handoffThread: (input: GitHandoffThreadInput) => Promise<GitHandoffThreadResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    pullRequestSnapshot: (
      input: GitPullRequestSnapshotInput,
    ) => Promise<GitPullRequestSnapshotResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    readWorkingTreeDiff: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitReadWorkingTreeDiffResult>;
    workingTreeDiffStats: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitWorkingTreeDiffStatsResult>;
    summarizeDiff: (input: GitSummarizeDiffInput) => Promise<GitSummarizeDiffResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
    onActionProgress: (callback: (event: GitActionProgressEvent) => void) => () => void;
  };
  pullRequests: {
    list: (input: PullRequestsListInput) => Promise<PullRequestsListResult>;
    reviewRequestCount: (
      input: PullRequestReviewRequestCountInput,
    ) => Promise<PullRequestReviewRequestCountResult>;
    detail: (input: PullRequestDetailInput) => Promise<PullRequestDetail>;
    diff: (input: PullRequestDetailInput) => Promise<PullRequestDiffResult>;
    action: (input: PullRequestActionInput) => Promise<PullRequestActionResult>;
    comment: (input: PullRequestCommentInput) => Promise<PullRequestActionResult>;
    setPinned: (input: PullRequestSetPinnedInput) => Promise<PullRequestSetPinnedResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getEnvironment: () => Promise<ServerGetEnvironmentResult>;
    getSettings: () => Promise<ServerGetSettingsResult>;
    updateSettings: (input: ServerUpdateSettingsInput) => Promise<ServerUpdateSettingsResult>;
    getSpaceNavigationState: () => Promise<ServerSpaceNavigationState>;
    updateSpaceNavigationState: (
      input: ServerUpdateSpaceNavigationStateInput,
    ) => Promise<ServerSpaceNavigationState>;
    getAuthSession: () => Promise<AuthSessionState>;
    bootstrapAuth: (input: AuthBootstrapInput) => Promise<AuthBootstrapResult>;
    bootstrapBearerAuth: (input: AuthBootstrapInput) => Promise<AuthBearerBootstrapResult>;
    issueAuthWebSocketToken: () => Promise<AuthWebSocketTokenResult>;
    createAuthPairingToken: (
      input?: AuthCreatePairingCredentialInput,
    ) => Promise<AuthPairingCredentialResult>;
    listAuthPairingLinks: () => Promise<ReadonlyArray<AuthPairingLink>>;
    revokeAuthPairingLink: (input: AuthRevokePairingLinkInput) => Promise<{ revoked: boolean }>;
    listAuthClients: () => Promise<ReadonlyArray<AuthClientSession>>;
    revokeAuthClient: (input: AuthRevokeClientSessionInput) => Promise<{ revoked: boolean }>;
    revokeOtherAuthClients: () => Promise<{ revokedCount: number }>;
    logoutAuthSession: () => Promise<AuthLogoutResult>;
    refreshProviders: () => Promise<ServerRefreshProvidersResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdateResult>;
    listWorktrees: () => Promise<ServerListWorktreesResult>;
    listLocalServers: () => Promise<ServerListLocalServersResult>;
    stopLocalServer: (input: ServerStopLocalServerInput) => Promise<ServerStopLocalServerResult>;
    getProviderUsageSnapshot: (
      input: ServerGetProviderUsageSnapshotInput,
    ) => Promise<ServerGetProviderUsageSnapshotResult>;
    listProviderUsage: (
      input: ServerListProviderUsageInput,
    ) => Promise<ServerListProviderUsageResult>;
    getDiagnostics: () => Promise<ServerDiagnosticsResult>;
    generateThreadRecap: (
      input: ServerGenerateThreadRecapInput,
    ) => Promise<ServerGenerateThreadRecapResult>;
    transcribeVoice: (
      input: ServerVoiceTranscriptionInput,
    ) => Promise<ServerVoiceTranscriptionResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
  };
  stats: {
    getProfileStats: (input: StatsGetProfileStatsInput) => Promise<StatsGetProfileStatsResult>;
    getProfileTokenStats: (
      input: StatsGetProfileTokenStatsInput,
    ) => Promise<StatsGetProfileTokenStatsResult>;
  };
  provider: {
    getComposerCapabilities: (
      input: ProviderGetComposerCapabilitiesInput,
    ) => Promise<ProviderComposerCapabilities>;
    compactThread: (input: ProviderCompactThreadInput) => Promise<void>;
    listCommands: (input: ProviderListCommandsInput) => Promise<ProviderListCommandsResult>;
    listSkills: (input: ProviderListSkillsInput) => Promise<ProviderListSkillsResult>;
    listSkillsCatalog: (input: ProviderSkillsCatalogInput) => Promise<ProviderSkillsCatalogResult>;
    listPlugins: (input: ProviderListPluginsInput) => Promise<ProviderListPluginsResult>;
    readPlugin: (input: ProviderReadPluginInput) => Promise<ProviderReadPluginResult>;
    listModels: (input: ProviderListModelsInput) => Promise<ProviderListModelsResult>;
    listAgents: (input: ProviderListAgentsInput) => Promise<ProviderListAgentsResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    getShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    getThreadDetailSnapshot: (
      input: OrchestrationGetThreadDetailSnapshotInput,
    ) => Promise<OrchestrationGetThreadDetailSnapshotResult>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    importThread: (
      input: OrchestrationImportThreadInput,
    ) => Promise<OrchestrationImportThreadResult>;
    repairState: () => Promise<OrchestrationReadModel>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    listProviderDeliveryBlockers: (
      input?: OrchestrationListProviderDeliveryBlockersInput,
    ) => Promise<OrchestrationListProviderDeliveryBlockersResult>;
    reconcileProviderDelivery: (
      input: OrchestrationReconcileProviderDeliveryInput,
    ) => Promise<OrchestrationReconcileProviderDeliveryResult>;
    subscribeShell: () => Promise<void>;
    unsubscribeShell: () => Promise<void>;
    subscribeThread: (input: OrchestrationSubscribeThreadInput) => Promise<void>;
    unsubscribeThread: (input: OrchestrationSubscribeThreadInput) => Promise<void>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
    onShellEvent: (callback: (event: OrchestrationShellStreamItem) => void) => () => void;
    onThreadEvent: (callback: (event: OrchestrationThreadStreamItem) => void) => () => void;
  };
}
