import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  type MessageDeliveryState,
  type ModelSelection,
  type NativeApi,
  type OrchestrationShellSnapshot,
  type ProjectScript,
  type ModelSlug,
  type ProviderKind,
  type ProviderConnectionId,
  type ProviderConnectionsSnapshot,
  type ProjectEntry,
  type ContainerId,
  type ProviderApprovalDecision,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  type PinnedMessage,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  ThreadId,
  ThreadMarkerId,
  type ThreadMarker,
  type ThreadMarkerColor,
  type ThreadMarkerStyle,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  RuntimeMode,
} from "@penkra/contracts";
import { getModelCapabilities, normalizeModelSlug } from "@penkra/shared/model";
import { resolveTailUserMessageEditTarget } from "@penkra/shared/conversationEdit";
import { threadExportBlockedReason } from "@penkra/shared/threadExport";
import { pendingRequestInstanceKey } from "@penkra/shared/threadSummary";
import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
} from "@penkra/shared/chatThreads";
import {
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd,
} from "@penkra/shared/threadEnvironment";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  providerComposerCapabilitiesQueryOptions,
  providerCommandsQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
  supportsThreadFork,
} from "~/lib/providerDiscoveryReactQuery";
import {
  providerConnectionQueryKeys,
  providerConnectionsQueryOptions,
  threadProviderBindingQueryOptions,
} from "~/lib/providerConnectionsReactQuery";
import {
  anonymousRouteAuthorizesModel,
  connectionAuthorizesModel,
  reconcileComposerConnectionSelection,
  resolveComposerConnection,
  resolveComposerConnectionAtAdmission,
} from "~/lib/providerConnectionCapabilities";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import {
  composerMentionPathNeedsQuoting,
  formatComposerMentionToken,
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
  skillMentionPrefix,
} from "~/lib/composerMentions";
import { getLocalFolderBrowseRootPath, isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import {
  findProviderStatus,
  normalizeCustomBinaryPath,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "../confirmedCustomBinaryPathStore";
import { isElectron } from "../env";
import { isScrollContainerNearBottom } from "../chat-scroll";
import { parseChatRouteSearch } from "../chatRouteSearch";
import { openThreadUrlReference, useThreadResourceOpener } from "../lib/threadResourceOpener";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { isStudioContainerProject } from "../lib/studioProjects";
import { resolveFirstSendTarget } from "../lib/chatFirstSend";
import { readActiveSpaceId, useSpacesUiStore } from "../spacesUiStore";
import {
  buildComposerFileAttachmentsFromFiles,
  buildComposerImageAttachmentsFromFiles,
  stageUploadComposerAttachments,
  cloneComposerImageAttachment,
  effectiveComposerAttachmentCount,
  findPendingBlobComposerAttachments,
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
} from "../lib/composerSend";
import { persistComposerAsset } from "../lib/composerAssetStore";
import {
  getQueuedComposerTurnDispatchInFlight,
  queuedComposerTurnServerMessageId,
} from "../lib/queuedComposerTurnDispatch";
import { reconcileDeletedThreadFromClient } from "../lib/deletedThreadClientReconciliation";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useComposerDropzone } from "../hooks/useComposerDropzone";
import { useChatRouteSearch } from "../hooks/useChatRouteSearch";
import {
  buildTranscriptAutoFollowSignal,
  derivePromptHistoryFromMessages,
  enrichSubagentWorkEntries,
  hasFileUndoSettled,
  promptStillMatchesActiveHistoryBrowse,
  type PendingFileUndo,
  type PromptHistoryNavigationState,
  resolveActiveThreadTitle,
  resolveCommittedProviderModel,
  resolveCycledModelSlug,
  resolveProjectScriptTerminalTarget,
  resolvePromptHistoryNavigation,
  shouldHandlePromptHistoryNavigationKey,
  shouldEnableComposerPastedTextCollapse,
  shouldConsumePendingCustomBinaryConfirmation,
} from "./ChatView.logic";
import {
  createRelevantWorkLogThreadsSelector,
  createThreadLineageSelector,
  localSubagentThreadId,
} from "./ChatView.selectors";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  stripComposerTriggerText,
} from "../composer-logic";
import {
  ensureLeadingSpaceForReplacement,
  extendReplacementRangeForTrailingSpace,
} from "../composerTriggerInsertion";
import {
  createProjectSelector,
  createComposerThreadMentionSourcesSelector,
  createThreadSelector,
} from "../storeSelectors";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import {
  canOfferForkSlashCommand,
  canOfferReviewSlashCommand,
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
  resolveComposerSlashRootBranch,
} from "../composerSlashCommands";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveWorkLogEntries,
  hasActivePendingTurnStart,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  PROVIDER_OPTIONS,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  hasCompletePendingUserInputAnswers,
  omitNullPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  type ChatMessage,
  type Thread,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import {
  buildSearchableModelOptions,
  useComposerCommandMenuItems,
} from "../hooks/useComposerCommandMenuItems";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { RuntimeUsageControls } from "./RuntimeUsageControls";
import { PenkraMark } from "./foundations/penkra-mark-shared/PenkraMark";
import {
  formatShortcutLabel,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import { Button } from "./ui/button";
import { randomTerminalId } from "./terminal/terminalSession";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  type ProjectScriptRunOptions,
  type ProjectScriptRunResult,
} from "~/projectScripts";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { requireNewThreadSpaceId } from "~/lib/threadBootstrap";
import { readFavoriteModelSlugs } from "~/lib/modelFavorites";
import {
  getCustomBinaryPathForProvider,
  getProviderStartOptions,
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "../appSettings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableEventTarget } from "../lib/editableEventTarget";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerAssistantSelectionAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  type QueuedComposerChatTurn,
  type QueuedComposerTurn,
  captureComposerPromptHistorySavedDraft,
  flushComposerDraftsDurably,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../composerDraftStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import { useWorkflowRunUiStore, useWorkflowRunUiThreadState } from "../workflowRunUiStore";
import { appendComposerPromptText } from "../lib/chatReferences";
import {
  appendOriginalComposerPromptBlocks,
  appendTerminalContextsToPrompt,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendPastedTextsToPrompt,
  createPastedTextDraft,
  pastedTextTitle,
  type PastedTextDraft,
} from "../lib/composerPastedText";
import {
  appendAssistantSelectionsToPrompt,
  formatAssistantSelectionQueuePreview,
  formatAssistantSelectionTitleSeed,
} from "../lib/assistantSelections";
import {
  appendFileCommentsToPrompt,
  formatFileCommentLabel,
  formatFileCommentTitleSeed,
  type FileCommentDraft,
} from "../lib/fileComments";
import {
  deriveContextWindowSelectionStatus,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowSnapshot,
  deriveSelectedContextWindowSnapshot,
} from "../lib/contextWindow";
import { useComposerVoiceController } from "./chat/useComposerVoiceController";
import {
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  useSplitViewStore,
} from "../splitViewStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { usePinnedMessageActions } from "./chat/usePinnedMessageActions";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "./chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SidebarHeaderTrigger, useSidebar } from "./ui/sidebar";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useNowMs } from "~/hooks/useNowMs";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import { ComposerDefault } from "./middle-panel/composer-default/ComposerDefault";
import { ThreadScreen3Rails } from "./middle-panel/thread-screen-3-rails/ThreadScreen3Rails";
import { ThreadScreenEmpty } from "./middle-panel/thread-screen-empty/ThreadScreenEmpty";
import { ThreadShell } from "./middle-panel/thread-shell/ThreadShell";
import { TopBarThreadAdapter } from "./middle-panel/top-bar-thread/TopBarThreadAdapter";
import type { TranscriptVirtualListRef } from "./chat/TranscriptVirtualList";
import { buildTurnDiffSummaryByAssistantMessageId } from "./chat/MessagesTimeline.logic";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  ProviderModelPicker,
  resolveProviderModelLabel,
} from "./chat/ProviderModelPicker";
import { ComposerModelEffortPicker } from "./chat/ComposerModelEffortPicker";
import { resolveTraitsTriggerSummary, TraitsPicker } from "./chat/TraitsPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import { ComposerPendingApprovalPanel } from "./middle-panel/composer-pending-approval/ComposerPendingApprovalPanel";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { ComposerQuickSettings } from "./chat/ComposerQuickSettings";
import { ComposerPendingUserInputPanel } from "./middle-panel/composer-user-question/ComposerPendingUserInputPanel";
import { ButtonSend } from "./middle-panel/button-send/ButtonSend";
import { ComposerActions } from "./middle-panel/composer-actions/ComposerActions";
import { ComposerActionsEmptyThread } from "./middle-panel/composer-actions-empty-thread/ComposerActionsEmptyThread";
import { DraftFolderBar } from "./middle-panel/composer-default/DraftFolderBar";
import { EffortSelectorEmptyThread } from "./middle-panel/effort-selector-empty-thread/EffortSelectorEmptyThread";
import { FolderPromptShared } from "./middle-panel/folder-prompt-shared/FolderPromptShared";
import { ModelSelectorEmptyThread } from "./middle-panel/model-selector-empty-thread/ModelSelectorEmptyThread";
import { ComposerVoiceButton } from "./chat/ComposerVoiceButton";
import { VoiceRecorderShared } from "./middle-panel/voice-recorder-shared/VoiceRecorderShared";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ExpandedImageOverlay } from "./chat/ExpandedImageOverlay";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { useChatTerminalController } from "./chat/useChatTerminalController";
import { ComposerSubagentStrip } from "./chat/ComposerSubagentStrip";
import {
  collectForegroundRunningSubagentStripItems,
  collectRunningSubagentStripItems,
  deriveComposerSubagentStripItems,
  type ComposerSubagentStripItem,
} from "./chat/ComposerSubagentStrip.logic";
import {
  deriveSubagentToolTraceByThreadId,
  type SubagentToolTrace,
} from "./chat/subagentToolTrace.logic";
import { WorkflowRunCard } from "./chat/WorkflowRunCard";
import {
  buildWorkflowResumePrompt,
  deriveWorkflowRunState,
  type WorkflowSubagentThreadRef,
} from "./chat/WorkflowRunCard.logic";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import { resolveTranscriptMarkerRange } from "./chat/chatSelectionActions";
import { dispatchThreadMarkerAdd, dispatchThreadMarkerRemove } from "../threadMarkers";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { getComposerTraitSelection } from "./chat/composerTraits";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";
import { ProjectPicker } from "./chat/ProjectPicker";
import { FolderClosed } from "./FolderClosed";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import {
  ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS,
  shouldStartActiveTurnLayoutGrace,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  resolveNextLocalDispatchSnapshot,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  shouldRenderProviderHealthBanner,
  resolveRuntimeModeAfterApprovalDecision,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useFeatureFlags } from "../featureFlags";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { buildModelSelection, buildNextProviderOptions } from "../providerModelOptions";
import {
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
} from "../lib/projectCreateRecovery";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
const EMPTY_THREAD_MARKERS: readonly ThreadMarker[] = [];
const CAN_PIN_ANY_MESSAGE = () => true;
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
const EMPTY_SUBAGENT_TOOL_TRACES: ReadonlyMap<string, SubagentToolTrace> = new Map();
const DRAFT_PROJECT_SYNC_MAX_ATTEMPTS = 6;
const DRAFT_PROJECT_SYNC_DELAY_MS = 50;

class PendingTurnStartCancelled extends Error {
  override readonly name = "PendingTurnStartCancelled";
}

function waitForDraftProjectSyncDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// Waits for a project to appear in the shell snapshot before a local draft points at it.
async function waitForShellProjectById(
  api: NativeApi,
  projectId: ContainerId,
): Promise<{
  project: OrchestrationShellSnapshot["projects"][number] | null;
  snapshot: OrchestrationShellSnapshot | null;
}> {
  let latestSnapshot: OrchestrationShellSnapshot | null = null;
  for (let attempt = 1; attempt <= DRAFT_PROJECT_SYNC_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
    if (snapshot) {
      latestSnapshot = snapshot;
      const project = snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (project) {
        return { project, snapshot };
      }
    }
    if (attempt < DRAFT_PROJECT_SYNC_MAX_ATTEMPTS) {
      await waitForDraftProjectSyncDelay(DRAFT_PROJECT_SYNC_DELAY_MS * attempt);
    }
  }
  return { project: null, snapshot: latestSnapshot };
}

function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
  if (previewUrls.length === 0 || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }, 0);
  });
}

// Shared by the live-composer and prompt-history attachment sync effects.
// Images inline a data URL and fall back to an already-persisted attachment
// when serialization fails.
async function stagePersistedComposerImageAttachments(input: {
  threadId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  getPersistedAttachments: () => PersistedComposerImageAttachment[];
}): Promise<PersistedComposerImageAttachment[]> {
  try {
    const existingPersistedById = new Map(
      input.getPersistedAttachments().map((attachment) => [attachment.id, attachment]),
    );
    const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
    await Promise.all(
      input.images.map(async (image) => {
        try {
          if (window.desktopBridge?.composerDrafts) {
            const assetKey = await persistComposerAsset({
              threadId: input.threadId,
              assetId: image.id,
              file: image.file,
            });
            stagedAttachmentById.set(image.id, {
              id: image.id,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              blobKey: assetKey,
            });
            return;
          }
          const dataUrl = await readFileAsDataUrl(image.file);
          stagedAttachmentById.set(image.id, {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          });
        } catch {
          const existingPersisted = existingPersistedById.get(image.id);
          if (existingPersisted) {
            stagedAttachmentById.set(image.id, existingPersisted);
          }
        }
      }),
    );
    return Array.from(stagedAttachmentById.values());
  } catch {
    const currentImageIds = new Set(input.images.map((image) => image.id));
    return input
      .getPersistedAttachments()
      .filter((attachment) => currentImageIds.has(attachment.id));
  }
}

function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

function canHandleComposerPickerShortcut(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  if (eventTargetsComposer(event, composerForm)) return true;
  const target = event.target;
  return (
    target === document.body ||
    target === document.documentElement ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;
const EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT: Record<string, string> = {};
const EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS: ReadonlyArray<string> = [];

function getThreadProviderCustomBinaryPathKey(threadId: Thread["id"], provider: ProviderKind) {
  return `${threadId}:${provider}`;
}

function getConfirmedCustomBinarySessionKey(
  thread: Thread | null | undefined,
  provider: ProviderKind,
): string | null {
  const session = thread?.session;
  if (!thread || session?.provider !== provider) {
    return null;
  }
  if (session.status !== "ready" && session.status !== "running") {
    return null;
  }
  return getThreadProviderCustomBinaryPathKey(thread.id, provider);
}

function getProviderStartOptionsCustomBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string | null {
  switch (provider) {
    case "codex":
      return normalizeCustomBinaryPath(providerOptions?.codex?.binaryPath);
    case "claudeAgent":
      return normalizeCustomBinaryPath(providerOptions?.claudeAgent?.binaryPath);
    case "antigravity":
      return normalizeCustomBinaryPath(providerOptions?.antigravity?.binaryPath);
    case "grok":
      return normalizeCustomBinaryPath(providerOptions?.grok?.binaryPath);
    case "droid":
      return normalizeCustomBinaryPath(providerOptions?.droid?.binaryPath);
    case "kilo":
      return normalizeCustomBinaryPath(providerOptions?.kilo?.binaryPath);
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
    case "cursor":
      return normalizeCustomBinaryPath(providerOptions?.cursor?.binaryPath);
    case "pi":
      return normalizeCustomBinaryPath(providerOptions?.pi?.binaryPath);
  }
}

function getProviderHealthBannerDismissalKey(status: ServerProviderStatus | null): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("\u001f");
}

function getRateLimitBannerDismissalKey(
  status: RateLimitStatus | null,
  threadId: Thread["id"] | null,
): string | null {
  if (!status || !threadId) {
    return null;
  }
  return [
    threadId,
    status.status,
    status.resetsAt ?? "",
    typeof status.utilization === "number" ? String(Math.round(status.utilization * 100)) : "",
  ].join("\u001f");
}

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];

function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  pastedTexts: ReadonlyArray<PastedTextDraft>;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  const firstImage = input.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  const firstFile = input.files[0];
  if (firstFile) {
    return `File: ${firstFile.name}`;
  }
  if (input.assistantSelections.length > 0) {
    return formatAssistantSelectionQueuePreview(input.assistantSelections.length);
  }
  const firstTerminalContext = input.terminalContexts[0];
  if (firstTerminalContext) {
    return formatTerminalContextLabel(firstTerminalContext);
  }
  const firstFileComment = input.fileComments[0];
  if (firstFileComment) {
    return formatFileCommentLabel(firstFileComment);
  }
  const pastedTitle = formatPastedTextTitleSeed(input.pastedTexts);
  if (pastedTitle) {
    return pastedTitle;
  }
  return "Queued follow-up";
}

function formatPastedTextTitleSeed(pastedTexts: ReadonlyArray<PastedTextDraft>): string | null {
  const firstPastedText = pastedTexts[0];
  if (!firstPastedText) {
    return null;
  }
  return pastedTexts.length === 1
    ? pastedTextTitle(firstPastedText.text)
    : `${pastedTexts.length} pasted texts`;
}

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const VOICE_RECORDER_ACTION_ARM_DELAY_MS = 250;

function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

interface ChatViewProps {
  threadId: ThreadId;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  isFocusedPane?: boolean;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  onChangeThreadInSplitPane?: () => void;
  onCloseThreadPane?: () => void;
}

interface LateComposerSendHandlers {
  readonly advanceActivePendingUserInput: (
    answerOverrides?: Record<string, PendingUserInputDraftAnswer>,
  ) => boolean;
  readonly handleStandaloneSlashCommand: (trimmedPrompt: string) => Promise<boolean>;
}

export default function ChatView({
  threadId,
  paneScopeId: paneScopeIdProp,
  surfaceMode: surfaceModeProp,
  isFocusedPane: isFocusedPaneProp,
  onSplitSurface,
  onMaximizeSurface,
  onChangeThreadInSplitPane,
  onCloseThreadPane,
}: ChatViewProps) {
  // Keep defaults out of the parameter list. Assignment-pattern parameters make
  // React Compiler skip this component, which turns every composer keystroke
  // into a full long-thread render.
  const paneScopeId = paneScopeIdProp ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const surfaceMode = surfaceModeProp ?? "single";
  const isFocusedPane = isFocusedPaneProp ?? true;
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadError = useStore((store) => store.setError);
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { open: leftRailOpen, setOpen: setLeftRailOpen } = useSidebar();
  const setComposerDraftModelSelectionAndSticky = useComposerDraftStore(
    (store) => store.setModelSelectionAndSticky,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const rawSearch = useChatRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(rawSearch.splitViewId ?? null), [rawSearch.splitViewId]),
  );
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const threadResourceOpener = useThreadResourceOpener();
  const isInactiveSplitPane = surfaceMode === "split" && !isFocusedPane;
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerPromptHistorySavedDraft = composerDraft.promptHistorySavedDraft;
  const composerPromptHistorySavedDraftImages = composerPromptHistorySavedDraft?.images ?? null;
  const composerImages = composerDraft.images;
  const composerFiles = composerDraft.files;
  const composerAssistantSelections = composerDraft.assistantSelections;
  const composerFileComments = composerDraft.fileComments;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPastedTexts = composerDraft.pastedTexts;
  const composerSkills = composerDraft.skills;
  const composerMentions = composerDraft.mentions;
  const queuedComposerTurns = composerDraft.queuedTurns;
  const queuePaused = composerDraft.queuePaused;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
        assistantSelectionCount: composerAssistantSelections.length,
        fileCommentCount: composerFileComments.length,
        terminalContexts: composerTerminalContexts,
        pastedTexts: composerPastedTexts,
      }),
    [
      composerAssistantSelections.length,
      composerFileComments.length,
      composerFiles.length,
      composerImages.length,
      composerTerminalContexts,
      composerPastedTexts,
      prompt,
    ],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const durablyPersistedComposerImageIds = composerDraft.persistedAttachments;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.setPromptHistorySavedDraft,
  );
  const restoreComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.restorePromptHistorySavedDraft,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const enqueueQueuedComposerTurn = useComposerDraftStore((store) => store.enqueueQueuedTurn);
  const insertQueuedComposerTurn = useComposerDraftStore((store) => store.insertQueuedTurn);
  const removeQueuedComposerTurnFromDraft = useComposerDraftStore(
    (store) => store.removeQueuedTurn,
  );
  const setComposerQueuePaused = useComposerDraftStore((store) => store.setQueuePaused);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const addComposerDraftAssistantSelection = useComposerDraftStore(
    (store) => store.addAssistantSelection,
  );
  const clearComposerDraftAssistantSelections = useComposerDraftStore(
    (store) => store.clearAssistantSelections,
  );
  const addComposerDraftFileComment = useComposerDraftStore((store) => store.addFileComment);
  const clearComposerDraftFileComments = useComposerDraftStore((store) => store.clearFileComments);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const addComposerDraftPastedTexts = useComposerDraftStore((store) => store.addPastedTexts);
  const removeComposerDraftPastedText = useComposerDraftStore((store) => store.removePastedText);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftSkills = useComposerDraftStore((store) => store.setSkills);
  const setComposerDraftMentions = useComposerDraftStore((store) => store.setMentions);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const syncComposerDraftPromptHistorySavedDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPromptHistorySavedDraftPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const markWorkflowRunPaused = useWorkflowRunUiStore((store) => store.markPaused);
  const markWorkflowRunDismissed = useWorkflowRunUiStore((store) => store.markDismissed);
  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const composerThreadSummaries = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const composerThreadProjects = useStore((state) => state.projects);
  const crossTaskSourceThreadId =
    serverThread?.creationSource && serverThread.sourceThreadId
      ? serverThread.sourceThreadId
      : null;
  const crossTaskSourceThread = useStore(
    useMemo(() => createThreadSelector(crossTaskSourceThreadId), [crossTaskSourceThreadId]),
  );
  const crossTaskOrigin = useMemo(
    () =>
      crossTaskSourceThreadId
        ? {
            sourceThreadId: crossTaskSourceThreadId,
            sourceProvider: crossTaskSourceThread?.modelSelection.provider ?? null,
          }
        : null,
    [crossTaskSourceThread?.modelSelection.provider, crossTaskSourceThreadId],
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  const parentScopedDraftThread = useMemo(
    () =>
      draftThread === null || draftThread.spaceId !== null || fallbackDraftProject === undefined
        ? draftThread
        : { ...draftThread, spaceId: fallbackDraftProject.spaceId ?? null },
    [draftThread, fallbackDraftProject],
  );
  useEffect(() => {
    if (
      draftThread !== null &&
      draftThread.spaceId === null &&
      fallbackDraftProject?.spaceId !== null &&
      fallbackDraftProject?.spaceId !== undefined
    ) {
      setDraftThreadContext(threadId, {
        spaceId: fallbackDraftProject.spaceId,
      });
    }
  }, [draftThread, fallbackDraftProject?.spaceId, setDraftThreadContext, threadId]);
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  // Mirror during the commit, before events or async continuations can observe
  // the new UI with the previous render's preview URLs.
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  const composerAssistantSelectionsRef = useRef<ComposerAssistantSelectionAttachment[]>(
    composerAssistantSelections,
  );
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const composerFileCommentsRef = useRef<FileCommentDraft[]>(composerFileComments);
  const composerPastedTextsRef = useRef<PastedTextDraft[]>(composerPastedTexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const pendingTurnStartMessageRef = useRef<
    (QueuedComposerChatTurn & { readonly messageId: MessageId }) | null
  >(null);
  const restorePendingTurnStartRef = useRef<
    ((pendingTurn: QueuedComposerChatTurn) => Promise<void>) | null
  >(null);
  const cancelPendingTurnStartMessageIdsRef = useRef<Set<MessageId>>(new Set());
  const [isLocalConnecting, _setIsLocalConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [pendingFileUndo, setPendingFileUndo] = useState<PendingFileUndo | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [respondingRequestKeys, setRespondingRequestKeys] = useState<string[]>([]);
  const [respondingUserInputRequestKeys, setRespondingUserInputRequestKeys] = useState<string[]>(
    [],
  );
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const pendingUserInputAnswersByRequestIdRef = useRef(pendingUserInputAnswersByRequestId);
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [subagentStripCompact, setSubagentStripCompact] = useState(false);
  const [workflowRunCardCompact, setWorkflowRunCardCompact] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Width-aware visibility for the footer picker cluster (context meter,
  // model name, traits label). Inputs live in a ref so the resize observer
  // can re-plan without re-subscribing; the sync function is exposed via ref
  // so label changes can re-plan without a resize.
  const [composerFooterTier, setComposerFooterTier] = useState(0);
  const composerFooterTierRef = useRef(0);
  const composerFooterDemotionWidthsRef = useRef<ReadonlyArray<number | undefined>>([]);
  const composerFooterLayoutSyncRef = useRef<(() => void) | null>(null);
  const [confirmedCustomBinaryPathsByProvider, setConfirmedCustomBinaryPathsByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >(loadConfirmedCustomBinaryPaths);
  const confirmedCustomBinarySessionKeysRef = useRef<Set<string>>(new Set());
  const pendingCustomBinaryPathsByThreadProviderRef = useRef<Map<string, string>>(new Map());
  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
  const [secondaryChromePlaceholderHeight, setSecondaryChromePlaceholderHeight] = useState(88);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [selectedComposerSkills, setSelectedComposerSkills] = useState<ProviderSkillReference[]>(
    () => composerSkills,
  );
  const [selectedComposerMentions, setSelectedComposerMentions] = useState<
    ProviderMentionReference[]
  >(() => composerMentions);
  const selectedComposerSkillsRef = useRef<ProviderSkillReference[]>(selectedComposerSkills);
  const selectedComposerMentionsRef = useRef<ProviderMentionReference[]>(selectedComposerMentions);
  // The setters below stamp these refs synchronously; layout effects backstop
  // external state changes before another browser event can read stale values.
  useLayoutEffect(() => {
    selectedComposerSkillsRef.current = selectedComposerSkills;
  }, [selectedComposerSkills]);
  useLayoutEffect(() => {
    selectedComposerMentionsRef.current = selectedComposerMentions;
  }, [selectedComposerMentions]);
  const updateSelectedComposerSkills = useCallback(
    (
      next:
        | ProviderSkillReference[]
        | ((existing: ProviderSkillReference[]) => ProviderSkillReference[]),
    ) => {
      const existing = selectedComposerSkillsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerSkillsRef.current = resolved;
      setSelectedComposerSkills(resolved);
      setComposerDraftSkills(threadId, resolved);
    },
    [setComposerDraftSkills, threadId],
  );
  const updateSelectedComposerMentions = useCallback(
    (
      next:
        | ProviderMentionReference[]
        | ((existing: ProviderMentionReference[]) => ProviderMentionReference[]),
    ) => {
      const existing = selectedComposerMentionsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerMentionsRef.current = resolved;
      setSelectedComposerMentions(resolved);
      setComposerDraftMentions(threadId, resolved);
    },
    [setComposerDraftMentions, threadId],
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT,
    LastInvokedScriptByProjectSchema,
  );
  const [dismissedProviderHealthBannerKeys, setDismissedProviderHealthBannerKeys] = useLocalStorage(
    DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
    EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS,
    DismissedProviderHealthBannersSchema,
  );
  const [dismissedRateLimitBannerKey, setDismissedRateLimitBannerKey] = useState<string | null>(
    null,
  );
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const transcriptListRef = useRef<TranscriptVirtualListRef | null>(null);
  const isAtEndRef = useRef(true);
  const autoFollowThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade; the pickers already closed post-commit.
    const settle = window.setTimeout(() => {
      setComposerCommandPicker(null);
      setIsModelPickerOpen(false);
      setIsTraitsPickerOpen(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [threadId]);
  useEffect(() => {
    const scrollDebouncer = showScrollDebouncer.current;
    return () => {
      scrollDebouncer.cancel();
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, []);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const pendingComposerFocusRef = useRef(false);
  const promptHistoryNavigationRef = useRef<PromptHistoryNavigationState | null>(null);
  const applyingPromptHistoryNavigationRef = useRef(false);
  const expectedPromptHistoryPromptRef = useRef<string | null>(null);
  const promptHistoryAppliedPromptRef = useRef<string | null>(null);
  const composerFormHeightRef = useRef(0);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const queuedComposerTurnsRef = useRef<QueuedComposerTurn[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const activatedThreadIdRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
  }, [threadId]);
  // While a history browse is active the persisted draft prompt holds a
  // recalled entry and the user's real draft snapshot sits in promptHistorySavedDraft.
  // A non-null saved draft with no live navigation state means the browse was
  // interrupted (thread switch, reload, unmount) — put the real draft back.
  useEffect(() => {
    if (promptHistoryNavigationRef.current !== null || composerPromptHistorySavedDraft === null) {
      return;
    }
    restoreComposerDraftPromptHistorySavedDraft(threadId);
    setComposerCursor(
      collapseExpandedComposerCursor(
        composerPromptHistorySavedDraft.prompt,
        composerPromptHistorySavedDraft.prompt.length,
      ),
    );
  }, [composerPromptHistorySavedDraft, restoreComposerDraftPromptHistorySavedDraft, threadId]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const discardPromptHistoryNavigationForComposerMutation = useCallback(() => {
    if (promptHistoryNavigationRef.current === null) {
      return;
    }
    // Attachment edits mean the recalled prompt is now the user's draft; do not restore the old one.
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
    setComposerDraftPromptHistorySavedDraft(threadId, null);
  }, [setComposerDraftPromptHistorySavedDraft, threadId]);
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      discardPromptHistoryNavigationForComposerMutation();
      if (!window.desktopBridge?.composerDrafts) {
        addComposerDraftImage(threadId, image);
        return;
      }
      void persistComposerAsset({
        threadId,
        assetId: image.id,
        file: image.file,
      })
        .then(() => addComposerDraftImage(threadId, image))
        .catch((error: unknown) => {
          console.error("[composer-images] Could not persist image.", error);
          toastManager.add({
            type: "error",
            title: "Could not save image",
            description: "The image was not added because Penkra could not store it safely.",
          });
        });
    },
    [addComposerDraftImage, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      if (!window.desktopBridge?.composerDrafts) {
        addComposerDraftImages(threadId, images);
        return;
      }
      void Promise.all(
        images.map((image) =>
          persistComposerAsset({
            threadId,
            assetId: image.id,
            file: image.file,
          }),
        ),
      )
        .then(() => addComposerDraftImages(threadId, images))
        .catch((error: unknown) => {
          console.error("[composer-images] Could not persist images.", error);
          toastManager.add({
            type: "error",
            title: "Could not save images",
            description: "The images were not added because Penkra could not store them safely.",
          });
        });
    },
    [addComposerDraftImages, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFilesToDraft = useCallback(
    (files: ComposerFileAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      void Promise.all(
        files.map(async (file) => {
          if (file.assetKey) return file;
          const assetKey = await persistComposerAsset({
            threadId,
            assetId: file.id,
            file: file.file,
          });
          return { ...file, assetKey };
        }),
      )
        .then((persistedFiles) => addComposerDraftFiles(threadId, persistedFiles))
        .catch((error: unknown) => {
          console.error("[composer-files] Could not persist attachment.", error);
          toastManager.add({
            type: "error",
            title: "Could not save attachment",
            description: "The file was not added because Penkra could not store it safely.",
          });
        });
    },
    [addComposerDraftFiles, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerAssistantSelectionToDraft = useCallback(
    (selection: ComposerAssistantSelectionAttachment) => {
      discardPromptHistoryNavigationForComposerMutation();
      return addComposerDraftAssistantSelection(threadId, selection);
    },
    [
      addComposerDraftAssistantSelection,
      discardPromptHistoryNavigationForComposerMutation,
      threadId,
    ],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerPastedTextsToDraft = useCallback(
    (pastedTexts: PastedTextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(threadId, pastedTexts);
    },
    [addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFileCommentToDraft = useCallback(
    (comment: FileCommentDraft) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftFileComment(threadId, comment);
    },
    [addComposerDraftFileComment, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftImage(threadId, imageId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftImage, threadId],
  );
  const clearComposerAssistantSelectionsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftAssistantSelections(threadId);
  }, [
    clearComposerDraftAssistantSelections,
    discardPromptHistoryNavigationForComposerMutation,
    threadId,
  ]);
  const clearComposerFileCommentsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftFileComments(threadId);
  }, [clearComposerDraftFileComments, discardPromptHistoryNavigationForComposerMutation, threadId]);
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftTerminalContext,
      setPrompt,
      threadId,
    ],
  );
  const removeComposerPastedTextFromDraft = useCallback(
    (pastedTextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftPastedText(threadId, pastedTextId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftPastedText, threadId],
  );
  // "Show in text field": drop the full pasted text back into the editor (appended
  // to the current prompt) and discard the card so it can be edited as normal text.
  const showComposerPastedTextInField = useCallback(
    (pastedTextId: string) => {
      const pasted = composerPastedTexts.find((entry) => entry.id === pastedTextId);
      if (!pasted) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const current = promptRef.current;
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      const nextPrompt = `${current}${separator}${pasted.text}`;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      removeComposerDraftPastedText(threadId, pastedTextId);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    },
    [
      composerPastedTexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftPastedText,
      setPrompt,
      threadId,
    ],
  );

  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      parentScopedDraftThread
        ? buildLocalDraftThread(
            threadId,
            parentScopedDraftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [
      fallbackDraftProject?.defaultModelSelection,
      localDraftError,
      parentScopedDraftThread,
      threadId,
    ],
  );
  const activeThread = serverThread ?? localDraftThread;
  useEffect(() => {
    if (
      !pendingFileUndo ||
      !hasFileUndoSettled({
        pending: pendingFileUndo,
        thread: activeThread ?? null,
      })
    ) {
      return;
    }
    // Async setState (post-paint) keeps this settled-undo cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setPendingFileUndo(null);
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread, pendingFileUndo]);
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeSessionTurnId = activeThread?.session?.activeTurnId ?? null;
  const activeSessionTurnStartedAt =
    activeLatestTurn && activeSessionTurnId === activeLatestTurn.turnId
      ? (activeLatestTurn.startedAt ?? null)
      : null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn: activeLatestTurn,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    activities: threadActivities,
    session: activeThread?.session ?? null,
  });
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const activeCumulativeCostUsd = useMemo(
    () => deriveCumulativeCostUsd(threadActivities),
    [threadActivities],
  );
  const activeRateLimitStatus = useMemo(
    () => deriveLatestRateLimitStatus(threadActivities),
    [threadActivities],
  );
  const activeRateLimitBannerDismissalKey = useMemo(
    () => getRateLimitBannerDismissalKey(activeRateLimitStatus, activeThread?.id ?? null),
    [activeRateLimitStatus, activeThread?.id],
  );
  const visibleActiveRateLimitStatus =
    activeRateLimitBannerDismissalKey === dismissedRateLimitBannerKey
      ? null
      : activeRateLimitStatus;
  const latestTurnSettledByProvider = isLatestTurnSettled(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const latestTurnSettled = latestTurnSettledByProvider && !hasLiveTurnTail;
  // `latestTurnSettled` is also false when there is NO started turn (a brand-new
  // chat), because `isLatestTurnSettled` treats a non-existent turn as unsettled.
  // Gate live-turn UI on an actually-started turn so composer chrome cannot
  // appear on a fresh chat just because the repo already has local edits.
  const latestTurnLive = Boolean(activeLatestTurn?.startedAt) && !latestTurnSettled;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const deletePlaceholderTerminalThread = useCallback(
    async (terminalThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const deleteEmptyTerminalThread = async () => {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: terminalThreadId,
        });
        void reconcileDeletedThreadFromClient({
          threadId: terminalThreadId,
          removeDeletedThreadFromClientState:
            useStore.getState().removeDeletedThreadFromClientState,
        });
        useComposerDraftStore.getState().clearDraftThread(terminalThreadId);
        useTerminalStateStore.getState().clearTerminalState(terminalThreadId);
        removeThreadFromSplitViews(terminalThreadId);
        if (activeSplitView) {
          const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
          const nextThreadId = nextSplitView
            ? resolveSplitViewFocusedThreadId(nextSplitView)
            : null;
          if (nextSplitView && nextThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
              search: () => ({ splitViewId: nextSplitView.id }),
            });
            return;
          }
        }
        await handleNewChat({ fresh: true });
      };

      try {
        await deleteEmptyTerminalThread();
      } catch (error) {
        console.error("Failed to delete empty terminal thread after closing its last terminal", {
          threadId: terminalThreadId,
          error,
        });
      }
    },
    [activeSplitView, handleNewChat, navigate, removeThreadFromSplitViews],
  );
  const {
    terminalState,
    terminalFocusRequestId,
    requestTerminalFocus,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalHeight,
    setTerminalMetadataInStore: storeSetTerminalMetadata,
    setTerminalActivityInStore: storeSetTerminalActivity,
    openTerminalThreadPageInStore: storeOpenTerminalThreadPage,
    newTerminalInStore: storeNewTerminal,
    setActiveTerminalInStore: storeSetActiveTerminal,
    closeTerminalGroupInStore: storeCloseTerminalGroup,
    resizeTerminalSplitInStore: storeResizeTerminalSplit,
    toggleTerminalVisibility,
    expandTerminalWorkspace,
    collapseTerminalWorkspace,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalDown,
    splitTerminalUp,
    createNewTerminal,
    createNewTerminalTab,
    createTerminalFromShortcut,
    moveTerminalToNewGroup,
    openNewFullWidthTerminal,
    activateTerminal,
    closeTerminal,
    closeActiveWorkspaceView,
  } = useChatTerminalController({
    threadId,
    activeThreadId,
    activeThread,
    activeProjectPresent: activeProject !== undefined,
    isFocusedPane,
    isServerThread,
    confirmTerminalClose: settings.confirmTerminalTabClose,
    onDeletePlaceholderThread: deletePlaceholderTerminalThread,
  });
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const selectedSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const emptyLandingSpaceId =
    activeThread?.spaceId ?? draftThread?.spaceId ?? activeProject?.spaceId ?? selectedSpaceId;
  const emptyLandingSpaceName = useStore(
    (state) => state.spaces.find((space) => space.id === emptyLandingSpaceId)?.name?.trim() || null,
  );
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
  });
  const isStudioContainer = isStudioContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  const isContainerLandingProject = isHomeChatContainer || isStudioContainer;
  const activeProjectDisplayName = isHomeChatContainer
    ? activeProject?.folderName
    : activeProject?.name;
  const activeFolderName = !isContainerLandingProject ? activeProject?.name.trim() : null;
  const emptyLandingParentName = activeFolderName || emptyLandingSpaceName || "this space";
  const isChatProject = isContainerLandingProject;
  const threadLineageThreads = useStore(
    useMemo(() => createThreadLineageSelector(activeThread?.id ?? null), [activeThread?.id]),
  );
  const resolvedThreadEnvMode = isServerThread
    ? (activeThread?.envMode ?? null)
    : (draftThread?.envMode ?? null);
  const resolvedThreadWorktreePath = isServerThread
    ? (activeThread?.worktreePath ?? null)
    : (draftThread?.worktreePath ?? null);
  const resolvedThreadWorkingDirectory = isServerThread
    ? (activeThread?.workingDirectory ?? null)
    : (draftThread?.workingDirectory ?? null);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const providerConnectionsQuery = useQuery(
    providerConnectionsQueryOptions(activeThread?.spaceId ?? null),
  );
  const threadProviderBindingQuery = useQuery(
    threadProviderBindingQueryOptions(activeThread?.id ?? null),
  );
  const configuredProviderKinds = useMemo(() => {
    const activeInstallations = new Set(
      providerConnectionsQuery.data?.installations
        .filter((installation) => installation.lifecycle === "active")
        .map((installation) => installation.harness) ?? [],
    );
    return new Set<ProviderKind>([
      ...(providerConnectionsQuery.data?.connections
        .filter(
          (connection) =>
            connection.lifecycle === "active" && activeInstallations.has(connection.harness),
        )
        .map((connection) => connection.harness) ?? []),
      ...(providerConnectionsQuery.data?.anonymousRoutes
        .filter((route) => activeInstallations.has(route.harness))
        .map((route) => route.harness) ?? []),
    ]);
  }, [providerConnectionsQuery.data]);
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const preferredProvider =
    selectedProviderByThreadId ?? threadProvider ?? settings.defaultProvider;
  const selectedProvider = useMemo<ProviderKind>(
    () =>
      lockedProvider ??
      (configuredProviderKinds.size === 0 || configuredProviderKinds.has(preferredProvider)
        ? preferredProvider
        : (AVAILABLE_PROVIDER_OPTIONS.find((option) => configuredProviderKinds.has(option.value))
            ?.value ?? preferredProvider)),
    [configuredProviderKinds, lockedProvider, preferredProvider],
  );
  const composerHiddenProviders = useMemo(
    () =>
      Array.from(
        new Set<ProviderKind>([
          ...settings.hiddenProviders,
          ...PROVIDER_OPTIONS.filter(
            (option) =>
              !configuredProviderKinds.has(option.value) && option.value !== lockedProvider,
          ).map((option) => option.value),
        ]),
      ),
    [configuredProviderKinds, lockedProvider, settings.hiddenProviders],
  );
  const previousSelectedProviderRef = useRef<{
    threadId: ThreadId;
    provider: ProviderKind;
  } | null>(null);
  const featureFlags = useFeatureFlags();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const threadModelSelection = activeThread?.modelSelection ?? null;
    const projectModelSelection = activeProject?.defaultModelSelection ?? null;
    const draftSelections = composerDraft.modelSelectionByProvider;

    const resolveHint = (provider: ProviderKind): string | null =>
      draftSelections[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      antigravity: resolveHint("antigravity"),
      grok: resolveHint("grok"),
      droid: resolveHint("droid"),
      kilo: resolveHint("kilo"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
    };
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    composerDraft.modelSelectionByProvider,
  ]);
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeThreadWorkingDirectory: resolvedThreadWorkingDirectory,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    customModelsByProvider,
    modelOptionsByProvider,
    unavailableModelProviders,
    runtimeModelsByProvider,
    selectedRuntimeAgents: discoveredRuntimeAgents,
  } = useProviderModelCatalog({
    selectedProvider,
    discoveryEnabled: isModelPickerOpen,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: composerModelHintByProvider,
    agentDiscoveryPolicy: "eager-core",
  });
  const selectableModelOptionsByProvider = useMemo(() => {
    const snapshot = providerConnectionsQuery.data;
    if (snapshot === undefined) return modelOptionsByProvider;
    const activeInstallations = new Set(
      snapshot.installations
        .filter((installation) => installation.lifecycle === "active")
        .map((installation) => installation.harness),
    );
    const authorizedModelsByProvider = Object.fromEntries(
      Object.entries(modelOptionsByProvider).map(([providerValue, options]) => {
        const provider = providerValue as ProviderKind;
        if (!activeInstallations.has(provider)) return [provider, []];
        const isManagedHarness =
          snapshot.authenticationMethods.some((method) => method.harness === provider) ||
          snapshot.anonymousRoutes.some((route) => route.harness === provider);
        const discoveredModelSlugs = new Set(
          runtimeModelsByProvider[provider].map((model) => model.slug),
        );
        const authorized = options.filter((option) => {
          if (isManagedHarness && !discoveredModelSlugs.has(option.slug)) return false;
          const availableConnectionIds = runtimeModelsByProvider[provider].find(
            (model) => model.slug === option.slug,
          )?.availableConnectionIds;
          if (
            anonymousRouteAuthorizesModel({
              snapshot,
              provider,
              model: option.slug,
              ...(isManagedHarness ? { availableConnectionIds: availableConnectionIds ?? [] } : {}),
            })
          ) {
            return true;
          }
          return snapshot.connections.some(
            (connection) =>
              connection.harness === provider &&
              connection.lifecycle === "active" &&
              connectionAuthorizesModel({
                snapshot,
                connectionId: connection.id,
                provider,
                model: option.slug,
                ...(isManagedHarness
                  ? { availableConnectionIds: availableConnectionIds ?? [] }
                  : {}),
              }),
          );
        });
        return [provider, authorized];
      }),
    );
    return { ...modelOptionsByProvider, ...authorizedModelsByProvider };
  }, [modelOptionsByProvider, providerConnectionsQuery.data, runtimeModelsByProvider]);
  const activeThreadModelSelection = activeThread?.modelSelection ?? null;
  const effectiveComposerModelOptionsByProvider = useMemo(() => {
    if (!hasThreadStarted || !activeThreadModelSelection) {
      return selectableModelOptionsByProvider;
    }
    const persisted = activeThreadModelSelection;
    const available = selectableModelOptionsByProvider[persisted.provider] ?? [];
    if (available.some((option) => option.slug === persisted.model)) {
      return selectableModelOptionsByProvider;
    }
    const known = modelOptionsByProvider[persisted.provider]?.find(
      (option) => option.slug === persisted.model,
    );
    return {
      ...selectableModelOptionsByProvider,
      [persisted.provider]: [
        ...available,
        known ?? { slug: persisted.model, name: persisted.model },
      ],
    };
  }, [
    activeThreadModelSelection,
    hasThreadStarted,
    modelOptionsByProvider,
    selectableModelOptionsByProvider,
  ]);
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection: activeThreadModelSelection ?? undefined,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: effectiveComposerModelOptionsByProvider,
  });
  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [runtimeModelsByProvider, selectedModel, selectedProvider],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModel: selectedRuntimeModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedRuntimeModel],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const draftModelSelectionForSelectedProvider =
    composerDraft.modelSelectionByProvider[selectedProvider] ?? null;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    if (selectedProvider === "pi" && draftModelSelectionForSelectedProvider?.provider === "pi") {
      return buildModelSelection(
        selectedProvider,
        draftModelSelectionForSelectedProvider.model,
        selectedModelOptionsForDispatch ?? draftModelSelectionForSelectedProvider.options,
      );
    }
    return buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch);
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);
  type PendingConnectionSelection = Partial<Record<ProviderKind, ProviderConnectionId | null>>;
  const [selectedConnectionByThread, setSelectedConnectionByThread] = useState<
    Partial<Record<ThreadId, PendingConnectionSelection>>
  >({});
  const selectedConnectionByProvider = selectedConnectionByThread[threadId] ?? {};
  const setSelectedConnectionByProvider = useCallback(
    (update: (current: PendingConnectionSelection) => PendingConnectionSelection) => {
      setSelectedConnectionByThread((current) => ({
        ...current,
        [threadId]: update(current[threadId] ?? {}),
      }));
    },
    [threadId],
  );
  const resolveSelectedConnectionFromSnapshot = useCallback(
    (
      snapshot: ProviderConnectionsSnapshot,
      provider: ProviderKind,
      model: string,
    ): ProviderConnectionId | null | undefined => {
      const isManagedHarness =
        snapshot.authenticationMethods.some((method) => method.harness === provider) ||
        snapshot.anonymousRoutes.some((route) => route.harness === provider);
      const availableConnectionIds = runtimeModelsByProvider[provider].find(
        (descriptor) => descriptor.slug === model,
      )?.availableConnectionIds;
      return resolveComposerConnection({
        snapshot,
        provider,
        model,
        ...(isManagedHarness && availableConnectionIds !== undefined
          ? { availableConnectionIds }
          : {}),
        explicitSelection: {
          specified: Object.prototype.hasOwnProperty.call(selectedConnectionByProvider, provider),
          connectionId: selectedConnectionByProvider[provider],
        },
        startedThreadBinding: {
          loaded: threadProviderBindingQuery.data !== undefined,
          connectionId: threadProviderBindingQuery.data?.binding?.connectionId,
        },
        hasThreadStarted,
      });
    },
    [
      hasThreadStarted,
      runtimeModelsByProvider,
      selectedConnectionByProvider,
      threadProviderBindingQuery.data,
    ],
  );
  const resolveSelectedConnection = useCallback(
    (provider: ProviderKind, model: string): ProviderConnectionId | null | undefined => {
      const snapshot = providerConnectionsQuery.data;
      return snapshot === undefined
        ? undefined
        : resolveSelectedConnectionFromSnapshot(snapshot, provider, model);
    },
    [providerConnectionsQuery.data, resolveSelectedConnectionFromSnapshot],
  );
  const selectedConnectionId = resolveSelectedConnection(
    selectedProvider,
    selectedModelSelection.model,
  );
  const dynamicAgents = useMemo(
    () =>
      discoveredRuntimeAgents.filter(
        (agent) =>
          agent.availableConnectionIds === undefined ||
          (selectedConnectionId !== undefined &&
            agent.availableConnectionIds.includes(selectedConnectionId)),
      ),
    [discoveredRuntimeAgents, selectedConnectionId],
  );
  const selectedModelConnections = useMemo(() => {
    const snapshot = providerConnectionsQuery.data;
    if (snapshot === undefined) return [];
    const availableConnectionIds = runtimeModelsByProvider[selectedProvider].find(
      (descriptor) => descriptor.slug === selectedModelSelection.model,
    )?.availableConnectionIds;
    return snapshot.connections.filter(
      (connection) =>
        connection.harness === selectedProvider &&
        connection.lifecycle === "active" &&
        connectionAuthorizesModel({
          snapshot,
          connectionId: connection.id,
          provider: selectedProvider,
          model: selectedModelSelection.model,
          ...(availableConnectionIds === undefined ? {} : { availableConnectionIds }),
        }),
    );
  }, [
    providerConnectionsQuery.data,
    runtimeModelsByProvider,
    selectedModelSelection.model,
    selectedProvider,
  ]);
  const handleConnectionChange = (connectionId: ProviderConnectionId | null) => {
    setSelectedConnectionByProvider((current) => ({
      ...current,
      [selectedProvider]: connectionId,
    }));
  };
  const handleManageConnections = useCallback(() => {
    void navigate({ to: "/settings", search: { section: "providers" } });
  }, [navigate]);
  const selectedBindingRevision = threadProviderBindingQuery.data?.binding?.revision;
  const resolveThreadBindingRevisionAtAdmission = useCallback(async (): Promise<number> => {
    if (!hasThreadStarted) {
      return 0;
    }
    if (selectedBindingRevision !== undefined) {
      return selectedBindingRevision;
    }
    const refreshed = await threadProviderBindingQuery.refetch();
    const revision = refreshed.data?.binding?.revision;
    if (revision === undefined) {
      throw new Error("Could not load the thread's current provider binding.");
    }
    return revision;
  }, [hasThreadStarted, selectedBindingRevision, threadProviderBindingQuery]);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () =>
      buildSearchableModelOptions({
        providerOptions: AVAILABLE_PROVIDER_OPTIONS,
        modelOptionsByProvider: selectableModelOptionsByProvider,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
        protectedProviders: [selectedProvider],
        lockedProvider,
      }),
    [
      lockedProvider,
      selectableModelOptionsByProvider,
      selectedProvider,
      settings.hiddenProviders,
      settings.providerOrder,
    ],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isConnecting = isLocalConnecting || phase === "connecting";
  // User messages intentionally have no turn id; assistant messages are the stable
  // bridge for deciding which historical work can fold into visible replies.
  // Memoized on purpose: an inline Set would change identity every render and
  // cascade through the work-log/timeline chain into the virtualized list.
  const workLogVisibleTurnIds = useMemo(() => {
    const turnIds = new Set<TurnId>();
    for (const message of activeThread?.messages ?? []) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (activeLatestTurnId) {
      turnIds.add(activeLatestTurnId);
    }
    return turnIds;
  }, [activeLatestTurnId, activeThread?.messages]);
  const rawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        visibleTurnIds: workLogVisibleTurnIds,
        activeTurnId: activeSessionTurnId,
        activeTurnStartedAt: activeSessionTurnStartedAt,
        latestTurnState: activeLatestTurn?.state ?? null,
        latestTurnCompletedAt: activeLatestTurn?.completedAt ?? null,
      }),
    [
      activeLatestTurn,
      activeSessionTurnId,
      activeSessionTurnStartedAt,
      threadActivities,
      workLogVisibleTurnIds,
    ],
  );
  const hasWorkLogSubagents = useMemo(
    () => rawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [rawWorkLogEntries],
  );
  const relevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: rawWorkLogEntries,
          parentThreadId: activeThread?.id ?? null,
          enabled: hasWorkLogSubagents,
        }),
      [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries],
    ),
  );
  const workLogEntries = useMemo(
    () =>
      hasWorkLogSubagents
        ? enrichSubagentWorkEntries(
            rawWorkLogEntries,
            relevantWorkLogThreads,
            activeThread?.id ?? null,
          )
        : rawWorkLogEntries,
    [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries, relevantWorkLogThreads],
  );
  // Native-CLI-style nested trace: transcript subagent rows show the child thread's
  // recent tool calls. Retain child detail subscriptions only while a subagent runs
  // so its activities stream in live; settled traces stay frozen from whatever the
  // store already holds.
  const liveSubagentThreadIdsKey = useMemo(() => {
    if (!hasWorkLogSubagents) {
      return "";
    }
    const threadIds = new Set<string>();
    for (const entry of workLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (subagent.isActive && subagent.resolvedThreadId) {
          threadIds.add(subagent.resolvedThreadId);
        }
      }
    }
    return [...threadIds].toSorted().join("\n");
  }, [hasWorkLogSubagents, workLogEntries]);
  useEffect(() => {
    if (!liveSubagentThreadIdsKey) {
      return;
    }
    const releases = liveSubagentThreadIdsKey
      .split("\n")
      .map((threadId) => retainThreadDetailSubscription(ThreadId.makeUnsafe(threadId)));
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [liveSubagentThreadIdsKey]);
  const subagentToolTraceByThreadId = useMemo(
    () =>
      hasWorkLogSubagents
        ? deriveSubagentToolTraceByThreadId({
            workEntries: workLogEntries,
            threads: relevantWorkLogThreads,
          })
        : EMPTY_SUBAGENT_TOOL_TRACES,
    [hasWorkLogSubagents, relevantWorkLogThreads, workLogEntries],
  );
  // Native-CLI parity: while a subagent thread is open, the strip derives from the
  // PARENT thread's activities so all sibling subagents (plus a way back to the
  // main thread) stay visible, with the open subagent marked as viewed.
  const stripParentThreadId = activeThread?.parentThreadId ?? null;
  const stripParentThread = useStore(
    useMemo(() => createThreadSelector(stripParentThreadId), [stripParentThreadId]),
  );
  // Deep links can land on a subagent thread before the parent has a detail
  // subscription; retain one so the parent's activities hydrate for the strip.
  useEffect(() => {
    if (!stripParentThreadId) {
      return;
    }
    return retainThreadDetailSubscription(stripParentThreadId);
  }, [stripParentThreadId]);
  const stripSourceThreadId = stripParentThread?.id ?? activeThread?.id ?? null;
  const stripSourceActivities = stripParentThread?.activities ?? threadActivities;
  const stripSourceLatestTurnId = stripParentThread
    ? (stripParentThread.latestTurn?.turnId ?? null)
    : (activeLatestTurn?.turnId ?? null);
  const stripSourceLatestTurn = stripParentThread?.latestTurn ?? activeLatestTurn;
  const stripSourceSession = stripParentThread?.session ?? activeThread?.session;
  const stripSourceActiveTurnId = stripSourceSession?.activeTurnId ?? null;
  const stripSourceActiveTurnStartedAt =
    stripSourceLatestTurn && stripSourceActiveTurnId === stripSourceLatestTurn.turnId
      ? (stripSourceLatestTurn.startedAt ?? null)
      : null;
  const stripVisibleTurnIds = useMemo(() => {
    if (!stripParentThread) {
      return workLogVisibleTurnIds;
    }
    const turnIds = new Set<TurnId>();
    for (const message of stripParentThread.messages) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (stripParentThread.latestTurn?.turnId) {
      turnIds.add(stripParentThread.latestTurn.turnId);
    }
    return turnIds;
  }, [stripParentThread, workLogVisibleTurnIds]);
  const stripLiveTurnId = stripParentThread
    ? isLatestTurnSettled(stripParentThread.latestTurn, stripParentThread.session ?? null)
      ? null
      : (stripParentThread.latestTurn?.turnId ?? null)
    : latestTurnSettled
      ? null
      : (activeLatestTurn?.turnId ?? null);
  // Composer-strip source: routed subagent activities are omitted from the timeline
  // entries above (they render as nested threads), so the strip derives from an
  // unfiltered pass or it would structurally never see routed subagents.
  const stripRawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(stripSourceActivities, stripSourceLatestTurnId ?? undefined, {
        visibleTurnIds: stripVisibleTurnIds,
        includeRoutedSubagentActivities: true,
        activeTurnId: stripSourceActiveTurnId,
        activeTurnStartedAt: stripSourceActiveTurnStartedAt,
        latestTurnState: stripSourceLatestTurn?.state ?? null,
        latestTurnCompletedAt: stripSourceLatestTurn?.completedAt ?? null,
      }),
    [
      stripSourceActivities,
      stripSourceActiveTurnId,
      stripSourceActiveTurnStartedAt,
      stripSourceLatestTurn,
      stripSourceLatestTurnId,
      stripVisibleTurnIds,
    ],
  );
  const hasStripWorkLogSubagents = useMemo(
    () => stripRawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [stripRawWorkLogEntries],
  );
  const stripRelevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: stripRawWorkLogEntries,
          parentThreadId: stripSourceThreadId,
          enabled: hasStripWorkLogSubagents,
        }),
      [stripSourceThreadId, hasStripWorkLogSubagents, stripRawWorkLogEntries],
    ),
  );
  const stripWorkLogEntries = useMemo(
    () =>
      hasStripWorkLogSubagents
        ? enrichSubagentWorkEntries(
            stripRawWorkLogEntries,
            stripRelevantWorkLogThreads,
            stripSourceThreadId,
          )
        : stripRawWorkLogEntries,
    [
      stripSourceThreadId,
      hasStripWorkLogSubagents,
      stripRawWorkLogEntries,
      stripRelevantWorkLogThreads,
    ],
  );
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const closeAgentActivityDetail = () => {
    setOpenAgentActivityId(null);
  };
  const agentActivityTimelineState = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries),
    [workLogEntries],
  );
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);
  useEffect(() => {
    if (!openAgentActivityId || agentActivityTimelineState.detailById.has(openAgentActivityId)) {
      return;
    }
    // Async setState (post-paint) keeps this stale-detail cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [agentActivityTimelineState.detailById, openAgentActivityId]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities, activeThread?.pendingInteractions),
    [activeThread?.pendingInteractions, threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities, activeThread?.pendingInteractions),
    [activeThread?.pendingInteractions, threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingUserInputKey = activePendingUserInput
    ? pendingRequestInstanceKey(
        activePendingUserInput.requestId,
        activePendingUserInput.lifecycleGeneration,
      )
    : null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInputKey
        ? (pendingUserInputAnswersByRequestId[activePendingUserInputKey] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInputKey, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInputKey
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInputKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingQuestion = activePendingProgress?.activeQuestion ?? null;
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInputKey
    ? respondingUserInputRequestKeys.includes(activePendingUserInputKey)
    : false;
  // Task tool_use_ids the provider confirmed as backgrounded via task_updated
  // patches (last patch wins, so re-foregrounded tasks drop back out).
  const backgroundedSubagentToolUseIds = useMemo(() => {
    const toolUseIds = new Set<string>();
    for (const activity of stripSourceActivities) {
      if (activity.kind !== "task.updated") {
        continue;
      }
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const toolUseId = typeof payload?.toolUseId === "string" ? payload.toolUseId : null;
      if (!toolUseId || typeof payload?.isBackgrounded !== "boolean") {
        continue;
      }
      if (payload.isBackgrounded) {
        toolUseIds.add(toolUseId);
      } else {
        toolUseIds.delete(toolUseId);
      }
    }
    return toolUseIds;
  }, [stripSourceActivities]);
  const composerSubagentStripItems = useMemo(
    () =>
      deriveComposerSubagentStripItems({
        workEntries: stripWorkLogEntries,
        liveTurnId: stripLiveTurnId,
        backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
        viewedThreadId: stripParentThread ? (activeThread?.id ?? null) : null,
        parentRow: stripParentThread
          ? {
              threadId: stripParentThread.id,
              label: stripParentThread.title ?? null,
            }
          : null,
      }),
    [
      activeThread?.id,
      backgroundedSubagentToolUseIds,
      stripLiveTurnId,
      stripParentThread,
      stripWorkLogEntries,
    ],
  );
  // Links workflow agent rows to their subagent child threads (and models) when the
  // Task tool_use_id produced one; agents spawned without a tool call stay unlinked.
  const workflowSubagentThreadsByToolUseId = useMemo(() => {
    const refs = new Map<string, WorkflowSubagentThreadRef>();
    for (const entry of workLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (!subagent.providerThreadId) {
          continue;
        }
        refs.set(subagent.providerThreadId, {
          threadId: subagent.resolvedThreadId ?? subagent.threadId,
          model: subagent.model,
          effort: subagent.effort,
        });
      }
    }
    return refs;
  }, [workLogEntries]);
  // Persisted (per-thread) workflow run flags: pausedByUser tells the settled
  // card apart from a plain stop; dismissed retires a settled card the run's
  // activities would otherwise keep visible. Survive reloads via
  // workflowRunUiStore instead of living in component state.
  const workflowRunUiThreadState = useWorkflowRunUiThreadState(activeThreadId);
  const pausedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.pausedByUser),
    [workflowRunUiThreadState.pausedByUser],
  );
  const dismissedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.dismissed),
    [workflowRunUiThreadState.dismissed],
  );
  const workflowRunState = useMemo(
    () =>
      deriveWorkflowRunState({
        activities: threadActivities,
        subagentThreadsByToolUseId: workflowSubagentThreadsByToolUseId,
        pausedByUserTaskIds: pausedWorkflowTaskIds,
        dismissedTaskIds: dismissedWorkflowTaskIds,
      }),
    [
      threadActivities,
      workflowSubagentThreadsByToolUseId,
      pausedWorkflowTaskIds,
      dismissedWorkflowTaskIds,
    ],
  );
  const workflowNowMs = useNowMs(workflowRunState !== null && !workflowRunState.settled);
  const showPlanFollowUpPrompt = false;
  const activePendingApproval = pendingApprovals[0] ?? null;
  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const isSendBusy = localDispatch !== null && !serverAcknowledgedLocalDispatch;
  const hasLiveTurn = phase === "running";
  const hasPendingTurnStart = hasActivePendingTurnStart({
    pendingMessageId: activeThread?.pendingTurnStartMessageId,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    session: activeThread?.session,
  });
  const showThinking = hasLiveTurn || isSendBusy || hasPendingTurnStart;
  const hasControllableTurn =
    hasLiveTurn || isSendBusy || hasPendingTurnStart || phase === "connecting";
  useEffect(() => {
    if (phase === "connecting" || isSendBusy || hasPendingTurnStart) {
      return;
    }
    const pendingMessageId = pendingTurnStartMessageRef.current?.messageId;
    if (pendingMessageId) {
      cancelPendingTurnStartMessageIdsRef.current.delete(pendingMessageId);
      pendingTurnStartMessageRef.current = null;
    }
  }, [hasPendingTurnStart, isSendBusy, phase]);
  const isWorking =
    hasLiveTurn || isSendBusy || hasPendingTurnStart || isConnecting || isRevertingCheckpoint;
  const hasStreamingAssistantText =
    activeThread?.messages.some((message) => message.role === "assistant" && message.streaming) ??
    false;
  const activeTurnLayoutLive = isWorking || !latestTurnSettled;
  const [keepSettledActiveTurnLayout, setKeepSettledActiveTurnLayout] = useState(false);
  const previousActiveTurnLayoutLiveRef = useRef(activeTurnLayoutLive);
  const previousActiveTurnLayoutKeyRef = useRef<string | null>(null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(activeLatestTurn, activeThread?.session ?? null, null)
      : null;
  const activeTurnLayoutKey =
    activeThreadId === null ? null : `${activeThreadId}:${activeLatestTurn?.turnId ?? "idle"}`;
  const activeTurnInProgress = activeTurnLayoutLive || keepSettledActiveTurnLayout;
  const isComposerApprovalState = activePendingApproval !== null;
  const isComposerEditorDisabled = isLocalConnecting || isComposerApprovalState;
  const canCollapsePastedTextToDraft = shouldEnableComposerPastedTextCollapse({
    isComposerApprovalState,
    hasPendingUserInput: pendingUserInputs.length > 0,
    showPlanFollowUpPrompt,
  });
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (previousActiveTurnLayoutKeyRef.current !== activeTurnLayoutKey) {
      previousActiveTurnLayoutKeyRef.current = activeTurnLayoutKey;
      previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    const shouldStartGrace = shouldStartActiveTurnLayoutGrace({
      previousTurnLayoutLive: previousActiveTurnLayoutLiveRef.current,
      currentTurnLayoutLive: activeTurnLayoutLive,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
    });
    previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;

    if (activeTurnLayoutLive) {
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    if (!shouldStartGrace) {
      return;
    }

    setKeepSettledActiveTurnLayout(true);
    const timeoutId = window.setTimeout(() => {
      setKeepSettledActiveTurnLayout(false);
    }, ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeLatestTurn?.startedAt, activeTurnLayoutKey, activeTurnLayoutLive]);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useLayoutEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const replacedPreviewUrls = previousPreviewUrls.filter(
      (previewUrl) => !previewUrls.includes(previewUrl),
    );
    revokeBlobPreviewUrlsAfterPaint(replacedPreviewUrls);
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      // Let React swap the transcript back to persisted /attachments URLs before
      // invalidating blob previews that may still be mounted in the old row.
      if (currentPreviewUrls) {
        revokeBlobPreviewUrlsAfterPaint(currentPreviewUrls);
      }
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const serverDeliveryByMessageId = useMemo(
    () =>
      new Map(
        (activeThread?.messages ?? EMPTY_MESSAGES).flatMap((message) =>
          message.delivery === undefined ? [] : [[message.id, message.delivery] as const],
        ),
      ),
    [activeThread?.messages],
  );
  // A user-triggered queue action owns placement immediately: the same durable
  // message moves into the transcript while the server/provider handoff runs.
  // The overlay is discarded as soon as the server publishes the transition.
  const [queuedActionStateByMessageId, setQueuedActionStateByMessageId] = useState<
    ReadonlyMap<MessageId, MessageDeliveryState>
  >(() => new Map());
  useEffect(() => {
    setQueuedActionStateByMessageId((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [messageId] of current) {
        if (serverDeliveryByMessageId.get(messageId)?.state !== "queued") {
          next.delete(messageId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [serverDeliveryByMessageId]);
  const serverQueuedMessageIds = useMemo(() => {
    const ids = new Set<MessageId>();
    for (const message of activeThread?.messages ?? EMPTY_MESSAGES) {
      const visibleState = queuedActionStateByMessageId.get(message.id) ?? message.delivery?.state;
      if (message.delivery?.queued === true && visibleState === "queued") {
        ids.add(message.id);
      }
    }
    // Compatibility for pre-lifecycle snapshots only. Once a message has a
    // delivery record, that record is the sole placement authority.
    for (const messageId of activeThread?.queuedMessageIds ?? []) {
      if (
        !serverDeliveryByMessageId.has(messageId) &&
        !queuedActionStateByMessageId.has(messageId)
      ) {
        ids.add(messageId);
      }
    }
    return ids;
  }, [
    activeThread?.messages,
    activeThread?.queuedMessageIds,
    queuedActionStateByMessageId,
    serverDeliveryByMessageId,
  ]);
  useEffect(() => {
    if (!activeThread || queuedComposerTurns.length === 0) {
      return;
    }
    for (const queuedTurn of queuedComposerTurns) {
      if (queuedTurn.serverAcceptedAt === undefined) {
        continue;
      }
      const messageId = queuedComposerTurnServerMessageId(queuedTurn);
      const delivery = serverDeliveryByMessageId.get(messageId);
      if (delivery?.queued === true && delivery.state === "queued") {
        continue;
      }
      const serverMessage = activeThread.messages.find((message) => message.id === messageId);
      if (
        delivery?.state === "steering" ||
        delivery?.state === "starting" ||
        delivery?.state === "accepted" ||
        activeThread.pendingTurnStartMessageId === messageId ||
        serverMessage?.turnId != null
      ) {
        removeQueuedComposerTurnFromDraft(activeThread.id, queuedTurn.id);
      }
    }
  }, [
    activeThread,
    queuedComposerTurns,
    removeQueuedComposerTurnFromDraft,
    serverDeliveryByMessageId,
    serverQueuedMessageIds,
  ]);
  const timelineMessages = useMemo(() => {
    const messages = (serverMessages ?? []).filter(
      (message) =>
        !serverQueuedMessageIds.has(message.id) && !queuedActionStateByMessageId.has(message.id),
    );
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    let pendingMessages = optimisticUserMessages;
    if (optimisticUserMessages.length > 0) {
      // Reconcile against every durable server message before placement
      // filtering. A queue-owned message is intentionally absent from the
      // transcript array, but it must still retire its optimistic twin.
      const serverIds = new Set(
        (serverMessages ?? [])
          .filter((message) => !queuedActionStateByMessageId.has(message.id))
          .map((message) => message.id),
      );
      pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    }
    const withPending =
      pendingMessages.length === 0
        ? serverMessagesWithPreviewHandoff
        : [...serverMessagesWithPreviewHandoff, ...pendingMessages];
    return withPending;
  }, [
    serverMessages,
    serverQueuedMessageIds,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
    queuedActionStateByMessageId,
  ]);
  const promptHistory = useMemo(() => {
    const activeMessages = (activeThread?.messages ?? EMPTY_MESSAGES).filter(
      (message) =>
        !serverQueuedMessageIds.has(message.id) && !queuedActionStateByMessageId.has(message.id),
    );
    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    if (optimisticUserMessages.length === 0) {
      return derivePromptHistoryFromMessages(activeMessages);
    }
    const activeMessageIds = new Set(
      (activeThread?.messages ?? EMPTY_MESSAGES)
        .filter((message) => !queuedActionStateByMessageId.has(message.id))
        .map((message) => message.id),
    );
    const pendingOptimisticMessages = optimisticUserMessages.filter(
      (message) => !activeMessageIds.has(message.id),
    );
    return derivePromptHistoryFromMessages([...activeMessages, ...pendingOptimisticMessages]);
  }, [
    activeThread?.messages,
    optimisticUserMessages,
    queuedActionStateByMessageId,
    serverQueuedMessageIds,
  ]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, agentActivityTimelineState.timelineWorkEntries),
    [agentActivityTimelineState.timelineWorkEntries, timelineMessages],
  );
  const enteringUserMessageIds = useMemo<ReadonlySet<MessageId>>(
    () => new Set(optimisticUserMessages.map((message) => message.id)),
    [optimisticUserMessages],
  );
  // --- Pinned messages & notes (per-thread, server-synced through sidepanel commands) ---
  const pinnedMessages = activeThread?.pinnedMessages ?? EMPTY_PINNED_MESSAGES;
  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((pin) => pin.messageId)),
    [pinnedMessages],
  );
  const threadMarkers = activeThread?.threadMarkers ?? EMPTY_THREAD_MARKERS;
  const { handleTogglePinMessage } = usePinnedMessageActions({
    activeThreadId,
    pinnedMessages,
  });
  const handleTogglePinMessageGuarded = handleTogglePinMessage;
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Every empty top-level draft uses the parent-aware Pencil prompt and folder picker.
  const isCenteredEmptyLanding = timelineEntries.length === 0 && !activeThread?.parentThreadId;
  const isEmptyChatLanding =
    isCenteredEmptyLanding && Boolean(homeDir) && isContainerLandingProject;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const messagesForDiffAnchoring: {
      id: MessageId;
      role: "user" | "assistant" | "system";
      turnId: TurnId | null;
    }[] = [];
    for (const message of timelineMessages) {
      messagesForDiffAnchoring.push({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
      });
    }
    return buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: turnDiffSummaries.map((summary) => ({
        ...summary,
        checkpointTurnCount:
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      })),
      messages: messagesForDiffAnchoring,
    });
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries, timelineMessages]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const threadWorkspaceCwd = activeProject
    ? resolveSharedThreadWorkspaceCwd({
        projectCwd: activeProject.cwd,
        envMode: resolvedThreadEnvMode,
        worktreePath: resolvedThreadWorktreePath,
        workingDirectory: resolvedThreadWorkingDirectory,
      })
    : null;
  const gitCwd = threadWorkspaceCwd;
  const gitBranchSourceCwd = activeProject
    ? resolveThreadBranchSourceCwd({
        projectCwd: activeProject.cwd,
        worktreePath: resolvedThreadWorktreePath,
        workingDirectory: resolvedThreadWorkingDirectory,
      })
    : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitBranchSourceCwd));
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacPlatform(platform),
  );
  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.serverUrl
            : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" || supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      spaceId: selectedSpaceId,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (isSkillTrigger || composerTriggerKind === "slash-command" || selectedProvider === "pi") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const activeRootBranch = useMemo(
    () =>
      resolveComposerSlashRootBranch({
        branches: branchesQuery.data?.branches,
        activeProjectCwd: gitBranchSourceCwd,
        activeThreadBranch: activeThread?.branch,
      }),
    [activeThread?.branch, branchesQuery.data?.branches, gitBranchSourceCwd],
  );
  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [providerPluginsQuery.data],
  );
  const providerNativeCommands = useMemo(
    () =>
      (providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS).filter(
        (command) => !["plan", "default"].includes(command.name.toLowerCase()),
      ),
    [providerCommandsQuery.data?.commands],
  );
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerSupportsTextNativeReviewCommand(selectedProvider, providerNativeCommands),
    [providerNativeCommands, selectedProvider],
  );
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;
  const selectedModelCaps = useMemo(
    () => getModelCapabilities(selectedProvider, selectedModel),
    [selectedModel, selectedProvider],
  );
  const supportsFastSlashCommand = selectedModelCaps.supportsFastMode;
  const currentProviderModelOptions = composerModelOptions?.[selectedProvider];
  const fastModeEnabled =
    supportsFastSlashCommand &&
    (currentProviderModelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const composerPromptWithoutActiveSlashTrigger =
    composerTrigger?.kind === "slash-command"
      ? stripComposerTriggerText(prompt, composerTrigger)
      : prompt;
  const canOfferReviewCommand =
    (branchesQuery.data?.isRepo ?? true) &&
    canOfferReviewSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
    });
  const canOfferForkCommand =
    supportsThreadFork(providerComposerCapabilitiesQuery.data) &&
    isServerThread &&
    activeThread !== undefined &&
    canOfferForkSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
    });
  // Export is hidden while the thread is running so archives cannot capture a
  // partial assistant response. Same shared predicate as the server's 409
  // guard, so the composer and the export route cannot drift.
  const canOfferExportCommand =
    isServerThread &&
    activeThread !== undefined &&
    threadExportBlockedReason(activeThread) === null;
  const normalComposerMenuItems = useComposerCommandMenuItems({
    composerTrigger: effectiveComposerTrigger,
    provider: selectedProvider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferExportCommand,
    dynamicAgents,
    threadMentionSources: {
      threads: composerThreadSummaries,
      projects: composerThreadProjects,
      currentThreadId: threadId,
    },
  });
  const composerMenuItems = useMemo(() => {
    if (composerCommandPicker === "fork-target") {
      return [
        {
          id: "fork-target:worktree",
          type: "fork-target" as const,
          target: "worktree" as const,
          label: "Fork Into New Worktree",
          description: "Continue in a new worktree",
        },
        {
          id: "fork-target:local",
          type: "fork-target" as const,
          target: "local" as const,
          label: "Fork Into Local",
          description:
            activeThread?.worktreePath || activeThread?.envMode === "worktree"
              ? "Continue in this local worktree"
              : "Continue in the current local thread",
        },
      ];
    }
    if (composerCommandPicker === "review-target") {
      return [
        {
          id: "review-target:changes",
          type: "review-target" as const,
          target: "changes" as const,
          label: "Review Uncommitted Changes",
          description: "Review local uncommitted changes",
        },
        {
          id: "review-target:base-branch",
          type: "review-target" as const,
          target: "base-branch" as const,
          label: "Review Against Base Branch",
          description: "Review the current branch diff against its base",
        },
      ];
    }

    return normalComposerMenuItems;
  }, [
    activeThread?.envMode,
    activeThread?.worktreePath,
    composerCommandPicker,
    normalComposerMenuItems,
  ]);
  const composerMenuOpen = Boolean(composerTrigger || composerCommandPicker);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  // Keydown can fire as soon as the updated menu commits, before passive effects.
  useLayoutEffect(() => {
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
  }, [composerMenuOpen, composerMenuItems, activeComposerMenuItem]);
  const nonPersistedComposerImageIdSet = useMemo(() => {
    const durableBlobIds = new Set(
      durablyPersistedComposerImageIds
        .filter((attachment) => Boolean(attachment.blobKey))
        .map((attachment) => attachment.id),
    );
    return new Set(nonPersistedComposerImageIds.filter((id) => !durableBlobIds.has(id)));
  }, [durablyPersistedComposerImageIds, nonPersistedComposerImageIds]);
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const rememberCustomBinaryPathForDispatch = useCallback(
    (input: {
      threadId: Thread["id"];
      provider: ProviderKind;
      providerOptions: ProviderStartOptions | undefined;
    }) => {
      const pendingKey = getThreadProviderCustomBinaryPathKey(input.threadId, input.provider);
      const customBinaryPath = getProviderStartOptionsCustomBinaryPath(
        input.providerOptions,
        input.provider,
      );
      if (!customBinaryPath) {
        pendingCustomBinaryPathsByThreadProviderRef.current.delete(pendingKey);
        return;
      }
      pendingCustomBinaryPathsByThreadProviderRef.current.set(pendingKey, customBinaryPath);
    },
    [],
  );
  useEffect(() => {
    const provider = activeThread?.session?.provider;
    if (!activeThread || !provider) {
      return;
    }

    const sessionKey = getConfirmedCustomBinarySessionKey(activeThread, provider);
    if (!sessionKey) {
      confirmedCustomBinarySessionKeysRef.current.delete(
        getThreadProviderCustomBinaryPathKey(activeThread.id, provider),
      );
      return;
    }
    const customBinaryPath =
      pendingCustomBinaryPathsByThreadProviderRef.current.get(sessionKey) ?? null;
    if (
      !shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: confirmedCustomBinarySessionKeysRef.current.has(sessionKey),
        pendingCustomBinaryPath: customBinaryPath,
      })
    ) {
      return;
    }
    confirmedCustomBinarySessionKeysRef.current.add(sessionKey);

    pendingCustomBinaryPathsByThreadProviderRef.current.delete(sessionKey);
    if (!customBinaryPath) {
      return;
    }

    setConfirmedCustomBinaryPathsByProvider((existing) =>
      existing[provider] === customBinaryPath
        ? existing
        : {
            ...existing,
            [provider]: customBinaryPath,
          },
    );
  }, [
    activeThread,
    activeThread?.id,
    activeThread?.session?.provider,
    activeThread?.session?.status,
  ]);
  // Persist confirmations so a custom binary path that already started a session
  // stays trusted across restarts, instead of re-showing the availability warning.
  useEffect(() => {
    saveConfirmedCustomBinaryPaths(confirmedCustomBinaryPathsByProvider);
  }, [confirmedCustomBinaryPathsByProvider]);
  const providerStatuses = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
        .map((status) => {
          const customBinaryPath = getCustomBinaryPathForProvider(settings, status.provider);
          return normalizeProviderStatusForLocalConfig({
            provider: status.provider,
            status,
            customBinaryPath,
            confirmedCustomBinaryPath: confirmedCustomBinaryPathsByProvider[status.provider],
          });
        })
        .flatMap((status) => (status ? [status] : [])),
    [confirmedCustomBinaryPathsByProvider, serverConfigQuery.data?.providers, settings],
  );
  const activeProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, selectedProvider),
    [selectedProvider, providerStatuses],
  );
  const activeProviderHealthBannerDismissalKey = useMemo(
    () => getProviderHealthBannerDismissalKey(activeProviderStatus),
    [activeProviderStatus],
  );
  const visibleActiveProviderStatus =
    activeProviderHealthBannerDismissalKey &&
    dismissedProviderHealthBannerKeys.includes(activeProviderHealthBannerDismissalKey)
      ? null
      : activeProviderStatus;
  const voiceConnectionId = useMemo(() => {
    const snapshot = providerConnectionsQuery.data;
    const defaultConnectionId = snapshot?.spaceDefaults.find(
      (entry) => entry.harness === "codex",
    )?.connectionId;
    if (defaultConnectionId === undefined) return undefined;
    return snapshot?.connections.some(
      (connection) =>
        connection.id === defaultConnectionId &&
        connection.harness === "codex" &&
        connection.lifecycle === "active",
    )
      ? defaultConnectionId
      : undefined;
  }, [providerConnectionsQuery.data]);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const hasNativeUserMessages = useMemo(
    () =>
      activeThread?.messages.some(
        (message) => message.role === "user" && message.source === "native",
      ) ?? false,
    [activeThread?.messages],
  );
  const modelPickerShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "modelPicker.toggle") ??
      formatShortcutLabel({
        key: "m",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [keybindings],
  );
  const traitsPickerShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "traitsPicker.toggle"),
    [keybindings],
  );

  const shouldShowProviderHealthBanner = shouldRenderProviderHealthBanner({
    threadEntryPoint: terminalState.entryPoint,
    terminalWorkspaceTerminalTabActive: false,
  });
  const shouldRenderChatPaneContent = true;
  const secondaryChromeThreadId = activeThread?.id ?? threadId;
  // The composer is interactive application chrome and must remain available whenever
  // the Thread is visible. Deferring it behind a component-local lifecycle boundary can
  // strand the placeholder when the chat surface remounts during hydration or navigation.
  const secondaryChromeReady = true;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (getThreadFromState(useStore.getState(), targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    // Secondary chrome is deferred during thread switches; replay focus once it
    // mounts. A disabled editor (dispatch connecting, pending approval) cannot
    // take focus either, so keep the request pending until it re-enables.
    const editor = composerEditorRef.current;
    if (!secondaryChromeReady || !editor || isComposerEditorDisabled) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
    editor.focusAtEnd();
  }, [secondaryChromeReady, isComposerEditorDisabled]);
  const toggleComposerFocus = useCallback(() => {
    const editor = composerEditorRef.current;
    if (secondaryChromeReady && editor?.isFocused()) {
      pendingComposerFocusRef.current = false;
      editor.blur();
      return;
    }
    focusComposer();
  }, [focusComposer, secondaryChromeReady]);
  const scheduleComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  // External panels (diff headers, file explorer, preview) bump this nonce after
  // inserting a reference so the composer visibly receives the text.
  const composerFocusRequestNonce = useComposerFocusRequestStore(
    (store) => store.requestsByThreadId[threadId] ?? 0,
  );
  useEffect(() => {
    if (composerFocusRequestNonce > 0) {
      scheduleComposerFocus();
    }
  }, [composerFocusRequestNonce, scheduleComposerFocus]);
  useEffect(() => {
    if (!secondaryChromeReady || !pendingComposerFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusComposer, secondaryChromeReady, secondaryChromeThreadId]);
  // Keep the two composer picker menus mutually exclusive so shortcuts always open one surface.
  const handleModelPickerOpenChange = useCallback((open: boolean) => {
    setIsModelPickerOpen(open);
    if (open) {
      setIsTraitsPickerOpen(false);
    }
  }, []);
  const handleTraitsPickerOpenChange = useCallback((open: boolean) => {
    setIsTraitsPickerOpen(open);
    if (open) {
      setIsModelPickerOpen(false);
    }
  }, []);
  const appendVoiceTranscriptToComposer = useCallback(
    async (targetThreadId: ThreadId, transcript: string, voiceJobId: string) => {
      const draftStore = useComposerDraftStore.getState();
      const nextPrompt = draftStore.applyVoiceTranscript(targetThreadId, voiceJobId, transcript);
      if (!nextPrompt) {
        return;
      }
      await flushComposerDraftsDurably();
      if (targetThreadId !== threadId) {
        return;
      }
      promptRef.current = nextPrompt;
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, threadId],
  );
  const {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  } = useComposerVoiceController({
    activeProject,
    activeThreadId: activeThread?.id ?? null,
    threadId,
    connectionId: voiceConnectionId,
    pendingUserInputCount: pendingUserInputs.length,
    onTranscriptReady: appendVoiceTranscriptToComposer,
    refreshVoiceStatus: refreshProviderStatuses,
    actionArmDelayMs: VOICE_RECORDER_ACTION_ARM_DELAY_MS,
    failureCopy: {
      transcriptionFailedTitle: "Couldn't transcribe voice note",
    },
    onGuardWarning: warnVoiceGuard,
  });
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        selectionCollapsed: true,
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [
      activeThread,
      composerCursor,
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      insertComposerDraftTerminalContext,
    ],
  );
  // Collapse an oversized paste into an attachment card above the composer instead
  // of flooding the editor with raw text. The card holds the full content until the
  // user sends or clicks "Show in text field".
  const addPastedTextToDraft = useCallback(
    (text: string) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(activeThread.id, [
        createPastedTextDraft({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          text,
        }),
      ]);
    },
    [activeThread, addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: ProjectScriptRunOptions,
    ): Promise<ProjectScriptRunResult | null> => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return null;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const { shouldCreateNewTerminal, terminalId: targetTerminalId } =
        resolveProjectScriptTerminalTarget({
          baseTerminalId,
          createTerminalId: randomTerminalId,
          hasRunningTerminal: terminalState.runningTerminalIds.length > 0,
          preferNewTerminal: options?.preferNewTerminal,
          terminalOpen: terminalState.terminalOpen,
        });

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      requestTerminalFocus();

      // Keep value blocks out of the try body so React Compiler can transform
      // this callback without bailing out of ChatView.
      const runScriptInTargetTerminal = async () =>
        runProjectCommandInTerminal({
          api,
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          project: {
            cwd: targetCwd,
          },
          cwd: targetCwd,
          command: script.command,
          worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
          ...(options?.env ? { env: options.env } : {}),
        });

      try {
        const { metadata } = await runScriptInTargetTerminal();
        if (metadata) {
          storeSetTerminalMetadata(activeThreadId, targetTerminalId, {
            cliKind: metadata.cliKind,
            label: metadata.label,
          });
        }
        return { terminalId: targetTerminalId };
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
        if (options?.throwOnError) {
          throw error instanceof Error
            ? error
            : new Error(`Failed to run script "${script.name}".`);
        }
        return null;
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      requestTerminalFocus,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      storeSetTerminalMetadata,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.terminalOpen,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ContainerId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;
      const deletedScriptToastTitle = `Deleted action "${deletedName ?? "Unknown"}"`;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: deletedScriptToastTitle,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.runtime-mode.set",
              commandId: newCommandId(),
              threadId,
              runtimeMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update access mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: { threadId: ThreadId; createdAt: string; runtimeMode: RuntimeMode }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  // Scroll helpers stay list-owned so transcript updates stop bouncing through
  // a separate measurement/controller loop during streaming.
  // Guards isAtEndRef from flipping during reflow-induced scroll events that
  // fire immediately after an explicit scrollToEnd.
  const programmaticScrollUntilRef = useRef(0);
  // Smooth only the first auto-follow after a send; live stream re-sticks stay cheap.
  const animateNextAutoFollowScrollRef = useRef(false);
  const scrollToEnd = useCallback((animated = false) => {
    programmaticScrollUntilRef.current = performance.now() + 200;
    transcriptListRef.current?.scrollToEnd?.({ animated });
  }, []);
  const armTranscriptAutoFollow = useCallback((targetThreadId: ThreadId, animated = false) => {
    autoFollowThreadIdRef.current = targetThreadId;
    animateNextAutoFollowScrollRef.current = animated;
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);
  const clearTranscriptAutoFollow = useCallback(() => {
    autoFollowThreadIdRef.current = null;
    animateNextAutoFollowScrollRef.current = false;
  }, []);
  const transcriptMessageCount = useMemo(() => timelineMessages.length, [timelineMessages]);
  const latestTranscriptMessage = useMemo(() => {
    return timelineMessages.at(-1) ?? null;
  }, [timelineMessages]);
  const transcriptTailKey = latestTranscriptMessage
    ? [
        latestTranscriptMessage.id,
        latestTranscriptMessage.role,
        latestTranscriptMessage.streaming ? "streaming" : "settled",
        latestTranscriptMessage.text.length,
        latestTranscriptMessage.completedAt ?? "",
      ].join(":")
    : "empty";
  const transcriptAutoFollowSignal = buildTranscriptAutoFollowSignal({
    messageCount: transcriptMessageCount,
    tailKey: transcriptTailKey,
  });
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    if (!isAtEnd && performance.now() < programmaticScrollUntilRef.current) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onMessagesClickCaptureBase = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = transcriptListRef.current?.getScrollableNode?.();
      if (!(scrollContainer instanceof HTMLElement) || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = transcriptListRef.current?.getScrollableNode?.();
        if (!(activeScrollContainer instanceof HTMLElement) || !anchor) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const onMessagesPointerCancelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerDownBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerUpBase = useCallback(() => {}, []);
  const onMessagesScrollBase = useCallback(() => {}, []);
  const onMessagesTouchEndBase = useCallback(() => {}, []);
  const onMessagesTouchMoveBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesTouchStartBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesWheelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  useLayoutEffect(() => {
    if (
      latestTranscriptMessage?.role === "assistant" &&
      latestTranscriptMessage.streaming &&
      isAtEndRef.current &&
      activeThread?.id !== undefined
    ) {
      autoFollowThreadIdRef.current = activeThread.id;
    }
    const shouldFollowPendingTurn =
      activeThread?.id !== undefined && autoFollowThreadIdRef.current === activeThread.id;
    if (!isAtEndRef.current && !shouldFollowPendingTurn) {
      return;
    }
    // Re-apply the bottom stick only for real transcript messages; tool/work
    // rows can arrive quickly and should not churn scroll/layout work.
    const frameId = window.requestAnimationFrame(() => {
      const shouldAnimate = animateNextAutoFollowScrollRef.current;
      animateNextAutoFollowScrollRef.current = false;
      scrollToEnd(shouldAnimate);
      if (!latestTranscriptMessage?.streaming) {
        autoFollowThreadIdRef.current = null;
      }
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThread?.id, latestTranscriptMessage, scrollToEnd, transcriptAutoFollowSignal]);
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  } = useTranscriptAssistantSelectionAction({
    threadId,
    enabled:
      Boolean(activeThread) &&
      !isInactiveSplitPane &&
      pendingUserInputs.length === 0 &&
      !isComposerApprovalState,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerCancelBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  });
  const createMarkerFromPendingSelection = useCallback(
    (style: ThreadMarkerStyle, color: ThreadMarkerColor) => {
      const pendingSelection = pendingTranscriptSelectionAction;
      if (!pendingSelection || !activeThreadId) {
        return;
      }
      const messageId = MessageId.makeUnsafe(pendingSelection.selection.assistantMessageId);
      const message = timelineMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        toastManager.add({
          type: "warning",
          title: "Could not find the selected message.",
        });
        return;
      }
      const range = resolveTranscriptMarkerRange({
        messageText: message.text,
        selectedText: pendingSelection.selection.text,
      });
      if (!range) {
        toastManager.add({
          type: "warning",
          title: "Select a unique phrase to mark it.",
          description: "Try including a few more words so Penkra can find the exact place.",
        });
        return;
      }
      dismissTranscriptSelectionAction();
      window.getSelection()?.removeAllRanges();
      const sameStyleOverlappingMarkers = threadMarkers.filter(
        (marker) =>
          marker.messageId === messageId &&
          marker.style === style &&
          marker.startOffset < range.endOffset &&
          range.startOffset < marker.endOffset,
      );
      if (sameStyleOverlappingMarkers.length > 0) {
        for (const marker of sameStyleOverlappingMarkers) {
          void dispatchThreadMarkerRemove(activeThreadId, marker.id).catch((error) => {
            console.error("Failed to remove thread marker", error);
            toastManager.add({
              type: "error",
              title: "Could not remove marker.",
            });
          });
        }
        return;
      }
      void dispatchThreadMarkerAdd({
        threadId: activeThreadId,
        markerId: ThreadMarkerId.makeUnsafe(crypto.randomUUID()),
        messageId,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        selectedText: message.text.slice(range.startOffset, range.endOffset),
        style,
        color,
      }).catch((error) => {
        console.error("Failed to create thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not create marker.",
        });
      });
    },
    [
      activeThreadId,
      dismissTranscriptSelectionAction,
      pendingTranscriptSelectionAction,
      threadMarkers,
      timelineMessages,
    ],
  );
  const createHighlightFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("highlight", "yellow");
  }, [createMarkerFromPendingSelection]);
  const createUnderlineFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("underline", "blue");
  }, [createMarkerFromPendingSelection]);

  useLayoutEffect(() => {
    if (isInactiveSplitPane) return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const syncComposerFooterLayout = () => {
      const composerFormWidth = measureComposerFormWidth();
      const nextCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));
      // Tier the footer controls by MEASURED overflow: demote one step while
      // the footer row's content is wider than the row, promote back (with
      // hysteresis) when the recorded overflow width is comfortably exceeded.
      const footerRow = composerForm.querySelector<HTMLElement>("[data-chat-composer-footer]");
      if (footerRow) {
        const rowOverflows = footerRow.scrollWidth > footerRow.clientWidth + 1;
        // The leading cluster clips (overflow-hidden) in compact mode instead
        // of growing the row's scrollWidth, so check it directly — a clipped
        // "+"/access-rules cluster must also demote the tier.
        const leadingCluster = footerRow.querySelector<HTMLElement>("[data-chat-composer-leading]");
        const leadingClips =
          nextCompact &&
          leadingCluster !== null &&
          leadingCluster.scrollWidth > leadingCluster.clientWidth + 1;
        const nextStep = resolveNextComposerFooterTier({
          currentTier: composerFooterTierRef.current,
          clientWidth: footerRow.clientWidth,
          isOverflowing: rowOverflows || leadingClips,
          demotionWidths: composerFooterDemotionWidthsRef.current,
        });
        composerFooterDemotionWidthsRef.current = nextStep.demotionWidths;
        if (nextStep.tier !== composerFooterTierRef.current) {
          composerFooterTierRef.current = nextStep.tier;
          setComposerFooterTier(nextStep.tier);
        }
      }
    };
    composerFooterLayoutSyncRef.current = syncComposerFooterLayout;

    const measuredHeight = Math.ceil(composerForm.getBoundingClientRect().height);
    composerFormHeightRef.current = measuredHeight;
    if (measuredHeight > 0) {
      setSecondaryChromePlaceholderHeight((current) =>
        current === measuredHeight ? current : measuredHeight,
      );
    }
    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      syncComposerFooterLayout();

      const nextHeight = entry.contentRect.height;
      composerFormHeightRef.current = nextHeight;
      const roundedNextHeight = Math.ceil(nextHeight);
      if (roundedNextHeight > 0) {
        setSecondaryChromePlaceholderHeight((current) =>
          current === roundedNextHeight ? current : roundedNextHeight,
        );
      }
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, isInactiveSplitPane]);

  useLayoutEffect(() => {
    if (isInactiveSplitPane || typeof ResizeObserver === "undefined") return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;

    let previousHeight = composerForm.getBoundingClientRect().height;
    let pendingScrollTimeout: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextHeight = entry.contentRect.height;
      const heightDelta = nextHeight - previousHeight;
      previousHeight = nextHeight;
      if (Math.abs(heightDelta) < 0.5) return;

      const scrollContainer = transcriptListRef.current?.getScrollableNode?.();
      // A composer resize can make the virtualizer report `isAtEnd: false` after the viewport
      // has already changed. Reconstruct the pre-resize viewport so only an existing
      // tail stick is preserved; a user who was already scrolled away stays there.
      const wasNearEndBeforeResize =
        scrollContainer instanceof HTMLElement &&
        isScrollContainerNearBottom({
          scrollTop: scrollContainer.scrollTop,
          clientHeight: scrollContainer.clientHeight + heightDelta,
          scrollHeight: scrollContainer.scrollHeight,
        });
      if (!wasNearEndBeforeResize) return;

      if (pendingScrollTimeout !== null) {
        window.clearTimeout(pendingScrollTimeout);
      }
      pendingScrollTimeout = window.setTimeout(() => {
        pendingScrollTimeout = null;
        scrollToEnd(false);
      }, 0);
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
      if (pendingScrollTimeout !== null) {
        window.clearTimeout(pendingScrollTimeout);
      }
    };
  }, [
    activeThread?.id,
    isInactiveSplitPane,
    scrollToEnd,
    secondaryChromeReady,
    shouldRenderChatPaneContent,
  ]);

  useEffect(() => {
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    const settle = window.setTimeout(() => {
      setShowScrollToBottom(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen || isInactiveSplitPane) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isInactiveSplitPane, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles]);

  useEffect(() => {
    composerAssistantSelectionsRef.current = composerAssistantSelections;
  }, [composerAssistantSelections]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    composerFileCommentsRef.current = composerFileComments;
  }, [composerFileComments]);

  useEffect(() => {
    composerPastedTextsRef.current = composerPastedTexts;
  }, [composerPastedTexts]);

  useEffect(() => {
    queuedComposerTurnsRef.current = queuedComposerTurns;
  }, [queuedComposerTurns]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    // No optimistic messages → nothing to reconcile; skip the full-transcript id Set
    // this effect would otherwise rebuild on every streaming flush.
    if (optimisticUserMessages.length === 0) {
      return;
    }
    const serverIds = new Set(
      activeThread.messages
        .filter((message) => !queuedActionStateByMessageId.has(message.id))
        .map((message) => message.id),
    );
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeThread?.id,
    activeThread?.messages,
    handoffAttachmentPreviews,
    optimisticUserMessages,
    queuedActionStateByMessageId,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
    if (
      promptHistoryNavigationRef.current !== null &&
      prompt !== promptHistoryAppliedPromptRef.current
    ) {
      // Another writer (queued-turn restore or insertion)
      // replaced the prompt while a history browse was active. The new prompt
      // is authoritative: end the browse and drop the saved pre-browse draft
      // so it cannot clobber this prompt later.
      promptHistoryNavigationRef.current = null;
      expectedPromptHistoryPromptRef.current = null;
      setComposerDraftPromptHistorySavedDraft(threadId, null);
    }
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, setComposerDraftPromptHistorySavedDraft, threadId]);

  useLayoutEffect(() => {
    updateSelectedComposerSkills(composerSkills);
    updateSelectedComposerMentions(composerMentions);
  }, [
    composerMentions,
    composerSkills,
    threadId,
    updateSelectedComposerMentions,
    updateSelectedComposerSkills,
  ]);

  useEffect(() => {
    updateSelectedComposerSkills((existing) => {
      const nextSkills = filterPromptSkillReferences(prompt, existing, selectedProvider);
      return providerSkillReferencesEqual(existing, nextSkills) ? existing : nextSkills;
    });
  }, [prompt, selectedProvider, updateSelectedComposerSkills]);

  useEffect(() => {
    updateSelectedComposerMentions((existing) => {
      const nextMentions = filterPromptProviderMentionReferences(prompt, existing);
      return providerMentionReferencesEqual(existing, nextMentions) ? existing : nextMentions;
    });
  }, [prompt, updateSelectedComposerMentions]);

  // Provider references are provider-specific; keep draft restores from looking like manual switches.
  useEffect(() => {
    const previous = previousSelectedProviderRef.current;
    previousSelectedProviderRef.current = {
      threadId,
      provider: selectedProvider,
    };
    if (!previous || previous.threadId !== threadId || previous.provider === selectedProvider) {
      return;
    }
    updateSelectedComposerSkills([]);
    updateSelectedComposerMentions([]);
  }, [selectedProvider, threadId, updateSelectedComposerMentions, updateSelectedComposerSkills]);

  useLayoutEffect(() => {
    // ChatView stays mounted across thread switches, so clear thread-local overlays before paint.
    setOptimisticUserMessages((existing) => {
      if (existing.length === 0) return existing;
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setExpandedImage(null);
  }, [threadId]);

  useEffect(() => {
    dragDepthRef.current = 0;
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade. The pre-paint overlay clear (optimistic
    // messages, expanded image) lives in the layout effect above, so deferring
    // these residual resets by a tick is imperceptible.
    const settle = window.setTimeout(() => {
      setOptimisticUserMessages((existing) => {
        if (existing.length === 0) return existing;
        for (const message of existing) {
          revokeUserMessagePreviewUrls(message);
        }
        return [];
      });
      setLocalDispatch(null);
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
      setIsDragOverComposer(false);
      setExpandedImage(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [threadId]);

  useEffect(() => {
    const pendingBlobAttachments = findPendingBlobComposerAttachments({
      persistedAttachments: durablyPersistedComposerImageIds,
      images: composerImages,
    });
    if (pendingBlobAttachments.length === 0) {
      return;
    }

    let cancelled = false;
    void hydratePendingBlobComposerAttachments(pendingBlobAttachments).then((hydratedImages) => {
      if (cancelled) {
        for (const image of hydratedImages) {
          revokeBlobPreviewUrl(image.previewUrl);
        }
        return;
      }
      if (hydratedImages.length > 0) {
        addComposerDraftImages(threadId, hydratedImages);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [addComposerDraftImages, composerImages, durablyPersistedComposerImageIds, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        const hasDeferredBlobAttachment =
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.persistedAttachments.some(
              (attachment) => attachment.blobKey,
            ) ?? false;
        if (hasDeferredBlobAttachment) {
          return;
        }
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      // Stage attachments in persisted draft state first so persist middleware can write them.
      void syncComposerDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftImages ||
      composerPromptHistorySavedDraftImages.length === 0
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerPromptHistorySavedDraftImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
            ?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      void syncComposerDraftPromptHistorySavedDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerPromptHistorySavedDraftImages,
    syncComposerDraftPromptHistorySavedDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  useEffect(() => {
    if (!composerMenuOpen) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setComposerCommandPicker(null);
      setComposerHighlightedItemId(null);
      setComposerTrigger(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composerMenuOpen]);

  const envMode: DraftThreadEnvMode = isServerThread
    ? (activeThread?.envMode ?? "local")
    : (draftThread?.envMode ?? "local");

  const visibleQueuedComposerTurns = useMemo(() => {
    const visibleLocalTurns = queuedComposerTurns.filter(
      (queuedTurn) =>
        !queuedActionStateByMessageId.has(queuedComposerTurnServerMessageId(queuedTurn)),
    );
    const localMessageIds = new Set(
      visibleLocalTurns.map((queuedTurn) => queuedComposerTurnServerMessageId(queuedTurn)),
    );
    const restoredServerTurns = (activeThread?.messages ?? []).flatMap((message) => {
      const messageId = message.id;
      const legacyQueued =
        message.delivery === undefined &&
        (activeThread?.queuedMessageIds ?? []).includes(messageId) &&
        !queuedActionStateByMessageId.has(messageId);
      const lifecycleQueued =
        message.delivery?.queued === true &&
        (queuedActionStateByMessageId.get(messageId) ?? message.delivery.state) === "queued";
      if (!legacyQueued && !lifecycleQueued) return [];
      if (localMessageIds.has(messageId)) {
        return [];
      }
      if (message.role !== "user") {
        return [];
      }
      return [
        {
          id: `server:${messageId}`,
          kind: "chat" as const,
          createdAt: message.createdAt,
          serverAcceptedAt: message.createdAt,
          serverMessageId: messageId,
          previewText: message.text,
          prompt: message.text,
          images: [],
          files: [],
          assistantSelections: [],
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
          skills: message.skills ?? [],
          mentions: message.mentions ?? [],
          selectedProvider,
          selectedModel,
          selectedPromptEffort,
          modelSelection: selectedModelSelection,
          connectionId: selectedConnectionId ?? null,
          ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
          runtimeMode,
          envMode,
        },
      ];
    });
    return restoredServerTurns.length === 0
      ? visibleLocalTurns
      : [...visibleLocalTurns, ...restoredServerTurns];
  }, [
    activeThread?.messages,
    activeThread?.queuedMessageIds,
    envMode,
    providerOptionsForDispatch,
    queuedActionStateByMessageId,
    queuedComposerTurns,
    runtimeMode,
    selectedConnectionId,
    selectedModel,
    selectedModelSelection,
    selectedPromptEffort,
    selectedProvider,
  ]);

  const beginLocalDispatch = useCallback(
    (options?: { readonly expectedUserMessageId?: MessageId }) => {
      setLocalDispatch((current) =>
        resolveNextLocalDispatchSnapshot(
          options ? { current, activeThread, options } : { current, activeThread },
        ),
      );
    },
    [activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);
  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      requestTerminalFocus();
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, requestTerminalFocus, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadId) {
      activatedThreadIdRef.current = null;
      return;
    }
    if (activatedThreadIdRef.current === activeThreadId) {
      return;
    }
    activatedThreadIdRef.current = activeThreadId;
    if (terminalState.entryPoint !== "terminal") {
      return;
    }
    storeOpenTerminalThreadPage(activeThreadId);
  }, [activeThreadId, storeOpenTerminalThreadPage, terminalState.entryPoint]);

  useEffect(() => {
    if (!terminalWorkspaceOpen) {
      return;
    }

    if (terminalState.workspaceActiveTab === "terminal") {
      requestTerminalFocus();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    focusComposer,
    requestTerminalFocus,
    terminalState.workspaceActiveTab,
    terminalWorkspaceOpen,
  ]);

  const onInterrupt = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    const isPreAcceptanceStop = phase === "connecting" || isSendBusy || hasPendingTurnStart;
    const pendingMessageId = isPreAcceptanceStop
      ? (localDispatch?.expectedUserMessageId ??
        pendingTurnStartMessageRef.current?.messageId ??
        activeThread.pendingTurnStartMessageId ??
        undefined)
      : undefined;
    setComposerQueuePaused(activeThread.id, true);
    let restorePendingTurn: Promise<void> | null = null;
    if (pendingMessageId) {
      cancelPendingTurnStartMessageIdsRef.current.add(pendingMessageId);
      const pending = pendingTurnStartMessageRef.current;
      const pendingMessage = activeThread.messages.find(
        (message) => message.id === pendingMessageId,
      );
      const hasExactPendingSnapshot = pending !== null && pending.messageId === pendingMessageId;
      const restoredPrompt = hasExactPendingSnapshot
        ? pending.prompt
        : pendingMessage
          ? pendingMessage.text
          : "";
      const currentDraftPrompt =
        useComposerDraftStore.getState().draftsByThreadId[activeThread.id]?.prompt ?? "";
      if (hasExactPendingSnapshot && restorePendingTurnStartRef.current) {
        restorePendingTurn = restorePendingTurnStartRef.current(pending);
      } else if (restoredPrompt.length > 0 && currentDraftPrompt.length === 0) {
        promptRef.current = restoredPrompt;
        setComposerDraftPrompt(activeThread.id, restoredPrompt);
        setComposerCursor(collapseExpandedComposerCursor(restoredPrompt, restoredPrompt.length));
        setComposerTrigger(detectComposerTrigger(restoredPrompt, restoredPrompt.length));
        scheduleComposerFocus();
      }
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== pendingMessageId),
      );
    }
    await Promise.all([
      api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: activeThread.id,
        ...(pendingMessageId ? { pendingMessageId } : {}),
        createdAt: new Date().toISOString(),
      }),
      restorePendingTurn ?? Promise.resolve(),
    ]);
  }, [
    activeThread,
    hasPendingTurnStart,
    localDispatch?.expectedUserMessageId,
    isSendBusy,
    phase,
    scheduleComposerFocus,
    setComposerDraftPrompt,
    setComposerQueuePaused,
  ]);

  const onStopWorkflowRun = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || !workflowRunState) return;
    await api.orchestration.dispatchCommand({
      type: "thread.task.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      taskId: workflowRunState.workflowTaskId,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, workflowRunState]);

  const onBackgroundSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      // The Task tool_use lives on the strip source thread (the parent while a
      // subagent thread is open), so route the command there.
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.task.background",
        commandId: newCommandId(),
        threadId: stripSourceThreadId,
        toolUseId: item.providerThreadId,
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop goes through the interrupt seam: on a subagent thread the reactor
  // resolves the tool_use_id and stops that task instead of the whole turn.
  // Target the canonical child id derived from the strip source thread —
  // item.threadId can still be the raw tool_use_id while client-side thread
  // resolution lags, which the server would reject as an unknown thread.
  const onStopSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: localSubagentThreadId(stripSourceThreadId, item.providerThreadId),
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop-all fans out through the same per-row stop so both paths share one seam.
  const onStopAllSubagentStripItems = useCallback(async () => {
    const running = collectRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(running.map((item) => onStopSubagentStripItem(item)));
  }, [composerSubagentStripItems, onStopSubagentStripItem]);

  // Ctrl+B parity with the native CLI: send every foreground running subagent to
  // the background at once, fanning through the same per-row background dispatch.
  const onBackgroundAllForegroundSubagentStripItems = useCallback(async () => {
    const foreground = collectForegroundRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(foreground.map((item) => onBackgroundSubagentStripItem(item)));
  }, [composerSubagentStripItems, onBackgroundSubagentStripItem]);

  // Pause is the same stop command; the persisted flag makes the settled card
  // read as paused (with a resume affordance) instead of plain stopped, across
  // reloads too.
  const onPauseWorkflowRun = useCallback(async () => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunPaused(activeThreadId, workflowTaskId);
    await onStopWorkflowRun();
  }, [activeThreadId, markWorkflowRunPaused, onStopWorkflowRun, workflowRunState]);

  const onDismissWorkflowRun = useCallback(() => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunDismissed(activeThreadId, workflowTaskId);
  }, [activeThreadId, markWorkflowRunDismissed, workflowRunState]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveCommittedProviderModel({
        selectedModel: model,
        availableOptions: selectableModelOptionsByProvider[provider],
        fallback: () => resolveAppModelSelection(provider, customModelsByProvider, model),
      });
      const nextModelSelection: ModelSelection = {
        provider,
        model: resolvedModel,
      };
      const snapshot = providerConnectionsQuery.data;
      if (snapshot !== undefined) {
        const availableConnectionIds = runtimeModelsByProvider[provider].find(
          (descriptor) => descriptor.slug === resolvedModel,
        )?.availableConnectionIds;
        setSelectedConnectionByProvider((current) => {
          const reconciled = reconcileComposerConnectionSelection({
            snapshot,
            provider,
            model: resolvedModel,
            ...(availableConnectionIds === undefined ? {} : { availableConnectionIds }),
            current: {
              specified: Object.prototype.hasOwnProperty.call(current, provider),
              connectionId: current[provider],
            },
          });
          const next = { ...current };
          if (reconciled.specified) next[provider] = reconciled.connectionId ?? null;
          else delete next[provider];
          return next;
        });
      }
      setComposerDraftModelSelectionAndSticky(activeThread.id, nextModelSelection);
      if (provider === "cursor") {
        setComposerDraftProviderModelOptions(activeThread.id, provider, undefined, {
          persistSticky: true,
          model: resolvedModel,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelectionAndSticky,
      setComposerDraftProviderModelOptions,
      customModelsByProvider,
      providerConnectionsQuery.data,
      runtimeModelsByProvider,
      selectableModelOptionsByProvider,
      setSelectedConnectionByProvider,
    ],
  );

  useEffect(() => {
    if (surfaceMode === "split" && !isFocusedPane) {
      return;
    }

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      // Mirror terminal interrupt semantics without stealing regular copy shortcuts.
      if (
        hasControllableTurn &&
        isMacPlatform(navigator.platform) &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        eventTargetsComposer(event, composerFormRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onInterrupt();
        return;
      }
      // Ctrl+B mirrors the native CLI: background all foreground running
      // subagents. Literal Ctrl on every platform, but stays out of the
      // terminal, where Ctrl+B is real shell input (readline cursor-back,
      // tmux prefix), and out of text-editing surfaces, where Ctrl+B is the
      // native macOS "move cursor back" binding. Silent no-op (event
      // untouched) when nothing qualifies.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b" &&
        !isTerminalFocused() &&
        !isEditableEventTarget(event) &&
        collectForegroundRunningSubagentStripItems(composerSubagentStripItems).length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onBackgroundAllForegroundSubagentStripItems();
        return;
      }
      const composerPickerShortcutActive =
        !isTerminalFocused() &&
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        !isComposerApprovalState &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      const shortcutContext = {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
        terminalWorkspaceTerminalOnly: false,
        terminalWorkspaceTerminalTabActive: false,
        terminalWorkspaceChatTabActive: false,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "composer.focus.toggle") {
        if (isComposerApprovalState || isVoiceRecording || isVoiceTranscribing) return;
        event.preventDefault();
        event.stopPropagation();
        toggleComposerFocus();
        return;
      }

      if (command === "modelPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleModelPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "model.next" || command === "model.previous") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = command === "model.next" ? "next" : "previous";
        const providerOptions = selectableModelOptionsByProvider[selectedProvider] ?? [];
        const nextSlug = resolveCycledModelSlug({
          currentModel: selectedModel,
          options: providerOptions,
          favoriteSlugs: readFavoriteModelSlugs(selectedProvider),
          direction,
        });
        if (!nextSlug) return;
        onProviderModelSelect(selectedProvider, nextSlug as ModelSlug);
        return;
      }

      if (command === "traitsPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleTraitsPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "chat.split") {
        event.preventDefault();
        event.stopPropagation();
        if (surfaceMode === "single" && onSplitSurface) {
          onSplitSurface();
        }
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    activeThreadId,
    runProjectScript,
    keybindings,
    onInterrupt,
    onSplitSurface,
    composerSubagentStripItems,
    onBackgroundAllForegroundSubagentStripItems,
    isFocusedPane,
    hasControllableTurn,
    handleModelPickerOpenChange,
    handleTraitsPickerOpenChange,
    isComposerApprovalState,
    isVoiceRecording,
    isVoiceTranscribing,
    surfaceMode,
    scheduleComposerFocus,
    toggleComposerFocus,
    activeThread,
    selectedProvider,
    selectedModel,
    selectableModelOptionsByProvider,
    onProviderModelSelect,
  ]);

  // Preserve the original "single mic button" contract:
  // first click starts recording, the next click submits/transcribes.
  const toggleComposerVoiceRecording = useCallback(() => {
    if (isVoiceTranscribing) {
      return;
    }
    if (isVoiceRecording) {
      void submitComposerVoiceRecording();
      return;
    }
    void startComposerVoiceRecording();
  }, [
    isVoiceRecording,
    isVoiceTranscribing,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
  ]);

  // --- Composer attachment entry points -------------------------------------
  const addComposerImages = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      const { images: nextImages, error } = buildComposerImageAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      addComposerImage,
      addComposerImagesToDraft,
      pendingUserInputs.length,
      setThreadError,
    ],
  );

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const addComposerFiles = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }

      const { files: nextFiles, error } = buildComposerFileAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      if (nextFiles.length > 0) {
        addComposerFilesToDraft(nextFiles);
      }
      setThreadError(activeThreadId, error);
    },
    [activeThreadId, addComposerFilesToDraft, pendingUserInputs.length, setThreadError],
  );

  const removeComposerFile = (fileId: string) => {
    discardPromptHistoryNavigationForComposerMutation();
    removeComposerDraftFile(threadId, fileId);
  };

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    addImages: addComposerImages,
    fileSupport: {
      genericFiles: "accept",
      addFiles: addComposerFiles,
    },
    appendReferenceText: (referenceText) => appendComposerPromptText(threadId, referenceText),
    appendPathMentions: (paths) => {
      for (const absolutePath of paths) {
        appendComposerPromptText(threadId, formatComposerMentionToken(absolutePath));
      }
    },
    dragDepthRef,
    focusComposer,
    setIsDragOverComposer,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "thread",
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, hasLiveTurn, isConnecting, isRevertingCheckpoint, isSendBusy, setThreadError],
  );

  const onUndoTurnFiles = useCallback(
    async (turnCounts: readonly number[]) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint || turnCounts.length === 0) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before undoing file changes.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          "Undo the latest file changes shown in this card?",
          "Earlier file changes will remain available to undo.",
          "Messages and provider conversation history will be kept.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const turnCount = Math.max(...turnCounts);
      const requestedAt = new Date().toISOString();
      setPendingFileUndo({
        threadId: activeThread.id,
        turnCounts,
        existingFailureActivityIds: activeThread.activities
          .filter((activity) => activity.kind === "checkpoint.revert.failed")
          .map((activity) => activity.id),
      });
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "files",
          createdAt: requestedAt,
        });
      } catch (err) {
        setPendingFileUndo(null);
        setIsRevertingCheckpoint(false);
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to undo file changes.",
        );
      }
    },
    [activeThread, hasLiveTurn, isConnecting, isRevertingCheckpoint, isSendBusy, setThreadError],
  );

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [clearComposerDraftContent, updateSelectedComposerMentions, updateSelectedComposerSkills],
  );

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.prompt;
      const restoredImages = queuedTurn.images.map(cloneComposerImageAttachment);
      const restoredFiles = queuedTurn.files;
      const restoredAssistantSelections = queuedTurn.assistantSelections;
      const restoredFileComments = queuedTurn.fileComments;
      promptRef.current = nextPrompt;
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
      // Editing a queued turn should recreate the same draft state the user queued.
      setDraftThreadContext(activeThread.id, {
        runtimeMode: queuedTurn.runtimeMode,
        envMode: queuedTurn.envMode,
      });
      if (restoredImages.length > 0) {
        addComposerImagesToDraft(restoredImages);
      }
      if (restoredFiles.length > 0) {
        addComposerFilesToDraft(restoredFiles);
      }
      for (const selection of restoredAssistantSelections) {
        addComposerAssistantSelectionToDraft(selection);
      }
      for (const comment of restoredFileComments) {
        addComposerFileCommentToDraft(comment);
      }
      if (queuedTurn.terminalContexts.length > 0) {
        addComposerTerminalContextsToDraft(queuedTurn.terminalContexts);
      }
      if (queuedTurn.pastedTexts.length > 0) {
        addComposerPastedTextsToDraft(queuedTurn.pastedTexts);
      }
      updateSelectedComposerSkills(queuedTurn.skills);
      updateSelectedComposerMentions(queuedTurn.mentions);
      setComposerDraftModelSelection(activeThread.id, queuedTurn.modelSelection);
      setSelectedConnectionByProvider((current) => ({
        ...current,
        [queuedTurn.selectedProvider]: queuedTurn.connectionId,
      }));
      setComposerDraftRuntimeMode(activeThread.id, queuedTurn.runtimeMode);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      activeThread,
      addComposerAssistantSelectionToDraft,
      addComposerFileCommentToDraft,
      addComposerFilesToDraft,
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      addComposerPastedTextsToDraft,
      clearComposerDraftContent,
      scheduleComposerFocus,
      setDraftThreadContext,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
      setSelectedConnectionByProvider,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const restorePendingTurnStart = useCallback(
    async (pendingTurn: QueuedComposerChatTurn) => {
      if (!activeThread) {
        return;
      }
      const liveDraft = useComposerDraftStore.getState().draftsByThreadId[activeThread.id];
      const livePrompt = composerEditorRef.current?.readSnapshot().value ?? liveDraft?.prompt ?? "";
      const liveImages = liveDraft?.images ?? [];
      const liveFiles = liveDraft?.files ?? [];
      const liveAssistantSelections = liveDraft?.assistantSelections ?? [];
      const liveFileComments = liveDraft?.fileComments ?? [];
      const liveTerminalContexts = liveDraft?.terminalContexts ?? [];
      const livePastedTexts = liveDraft?.pastedTexts ?? [];
      const liveSkills = liveDraft?.skills ?? [];
      const liveMentions = liveDraft?.mentions ?? [];
      const liveSendState = deriveComposerSendState({
        prompt: livePrompt,
        imageCount: liveImages.length,
        fileCount: liveFiles.length,
        assistantSelectionCount: liveAssistantSelections.length,
        fileCommentCount: liveFileComments.length,
        terminalContexts: liveTerminalContexts,
        pastedTexts: livePastedTexts,
      });
      const liveMatchesPendingTurn =
        livePrompt === pendingTurn.prompt &&
        liveImages.length === pendingTurn.images.length &&
        liveImages.every((image, index) => image.id === pendingTurn.images[index]?.id) &&
        liveFiles.length === pendingTurn.files.length &&
        liveFiles.every((file, index) => file.id === pendingTurn.files[index]?.id) &&
        liveAssistantSelections.length === pendingTurn.assistantSelections.length &&
        liveAssistantSelections.every(
          (selection, index) => selection.id === pendingTurn.assistantSelections[index]?.id,
        ) &&
        liveFileComments.length === pendingTurn.fileComments.length &&
        liveTerminalContexts.length === pendingTurn.terminalContexts.length &&
        livePastedTexts.length === pendingTurn.pastedTexts.length;
      const shouldQueueLiveDraft = liveSendState.hasSendableContent && !liveMatchesPendingTurn;
      const resolvedLiveConnectionId = resolveSelectedConnection(
        selectedModelSelection.provider,
        selectedModelSelection.model,
      );
      const liveConnectionId =
        resolvedLiveConnectionId === undefined
          ? threadProviderBindingQuery.data?.binding?.connectionId
          : resolvedLiveConnectionId;
      if (shouldQueueLiveDraft && liveConnectionId === undefined) {
        setThreadError(activeThread.id, "Choose a Connection before restoring this message.");
        return;
      }

      // Restore the cancelled turn immediately. Any newer draft was captured
      // above and is appended to the paused queue after image previews become
      // durable, so neither composer state can overwrite the other.
      restoreQueuedTurnToComposer(pendingTurn);

      if (!shouldQueueLiveDraft) {
        return;
      }
      const queuedImages = await Promise.all(
        liveImages.map(async (image) => {
          try {
            return {
              ...image,
              previewUrl: await readFileAsDataUrl(image.file),
            };
          } catch {
            return image;
          }
        }),
      );
      enqueueQueuedComposerTurn(activeThread.id, {
        id: randomUUID(),
        kind: "chat",
        createdAt: new Date().toISOString(),
        previewText: buildQueuedComposerPreviewText({
          trimmedPrompt: liveSendState.trimmedPrompt,
          images: queuedImages,
          files: liveFiles,
          assistantSelections: liveAssistantSelections,
          terminalContexts: liveSendState.sendableTerminalContexts,
          fileComments: liveFileComments,
          pastedTexts: liveSendState.sendablePastedTexts,
        }),
        prompt: livePrompt,
        images: queuedImages,
        files: liveFiles,
        assistantSelections: liveAssistantSelections,
        fileComments: liveFileComments,
        terminalContexts: liveSendState.sendableTerminalContexts,
        pastedTexts: liveSendState.sendablePastedTexts,
        skills: liveSkills,
        mentions: liveMentions,
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        modelSelection: selectedModelSelection,
        connectionId: liveConnectionId ?? null,
        ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
        runtimeMode,
        envMode,
      });
    },
    [
      activeThread,
      enqueueQueuedComposerTurn,
      envMode,
      providerOptionsForDispatch,
      resolveSelectedConnection,
      restoreQueuedTurnToComposer,
      runtimeMode,
      selectedModel,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      setThreadError,
      threadProviderBindingQuery.data?.binding?.connectionId,
    ],
  );
  useLayoutEffect(() => {
    restorePendingTurnStartRef.current = restorePendingTurnStart;
    return () => {
      if (restorePendingTurnStartRef.current === restorePendingTurnStart) {
        restorePendingTurnStartRef.current = null;
      }
    };
  }, [restorePendingTurnStart]);

  const cancelQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn): Promise<boolean> => {
      let resolvedQueuedTurn = queuedTurn;
      const pendingDispatch = getQueuedComposerTurnDispatchInFlight(threadId, queuedTurn.id);
      if (pendingDispatch) {
        try {
          await pendingDispatch;
        } catch {
          return false;
        }
        resolvedQueuedTurn =
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.queuedTurns.find(
              (candidate) => candidate.id === queuedTurn.id,
            ) ?? queuedTurn;
      }
      const messageId = queuedComposerTurnServerMessageId(resolvedQueuedTurn);
      const delivery = serverDeliveryByMessageId.get(messageId);
      const isServerAccepted =
        resolvedQueuedTurn.serverAcceptedAt !== undefined ||
        delivery !== undefined ||
        (activeThread?.queuedMessageIds ?? []).includes(messageId);
      if (!isServerAccepted) {
        removeQueuedComposerTurnFromDraft(threadId, resolvedQueuedTurn.id);
        return true;
      }
      const api = readNativeApi();
      if (!api) {
        return false;
      }
      // Cancel/edit owns the row immediately. Keep the durable server message
      // suppressed while the cancellation command and its projection catch up,
      // otherwise the draft row briefly disappears and is reconstructed from
      // the still-queued server snapshot.
      setQueuedActionStateByMessageId((current) => {
        const next = new Map(current);
        next.set(messageId, "accepted");
        return next;
      });
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.cancel-queued",
          commandId: newCommandId(),
          threadId,
          messageId,
          createdAt: new Date().toISOString(),
        });
        removeQueuedComposerTurnFromDraft(threadId, resolvedQueuedTurn.id);
        setThreadError(threadId, null);
        return true;
      } catch (error) {
        setQueuedActionStateByMessageId((current) => {
          const next = new Map(current);
          next.delete(messageId);
          return next;
        });
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to cancel queued message.",
        );
        return false;
      }
    },
    [
      activeThread?.queuedMessageIds,
      removeQueuedComposerTurnFromDraft,
      serverDeliveryByMessageId,
      setQueuedActionStateByMessageId,
      setThreadError,
      threadId,
    ],
  );

  const removeQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      void cancelQueuedComposerTurn(queuedTurn);
    },
    [cancelQueuedComposerTurn],
  );

  // These handlers are declared later because they depend on composer controls
  // established below. Route event-time calls through a ref so the earlier send
  // handler does not capture later-declared bindings and bail out React Compiler.
  const lateComposerSendHandlersRef = useRef<LateComposerSendHandlers | null>(null);

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: "queue" | "steer" = "queue",
    queuedTurn?: QueuedComposerChatTurn,
  ): Promise<boolean> => {
    e?.preventDefault();
    const api = readNativeApi();
    const lateSendHandlers = lateComposerSendHandlersRef.current;
    if (!api || !lateSendHandlers || !activeThread || isVoiceTranscribing) {
      return false;
    }
    if (activePendingProgress) {
      const activeQuestion = activePendingProgress.activeQuestion;
      const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
      const livePendingAnswerText = liveComposerSnapshot?.value ?? promptRef.current;
      const currentDraftAnswer =
        activePendingUserInputKey && activeQuestion
          ? pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
              activeQuestion.id
            ]
          : undefined;
      const answerOverrides =
        activeQuestion && livePendingAnswerText.trim().length > 0
          ? {
              [activeQuestion.id]: setPendingUserInputCustomAnswer(
                currentDraftAnswer,
                livePendingAnswerText,
              ),
            }
          : undefined;
      if (activePendingUserInputKey && answerOverrides) {
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
          ...answerOverrides,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: nextRequestAnswers,
        }));
      }
      return lateSendHandlers.advanceActivePendingUserInput(answerOverrides);
    }
    const queuedChatTurn = queuedTurn ?? null;
    const liveComposerSnapshot =
      queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
    const promptForSend =
      queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
    let composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    // Legacy blob-backed images can exist without a hydrated live image right
    // after reload. Hydrate them before a live send so they are not dropped.
    if (queuedChatTurn === null) {
      const pendingBlobAttachments = findPendingBlobComposerAttachments({
        persistedAttachments:
          useComposerDraftStore.getState().draftsByThreadId[activeThread.id]
            ?.persistedAttachments ?? [],
        images: composerImagesForSend,
      });
      if (pendingBlobAttachments.length > 0) {
        const hydratedPendingImages =
          await hydratePendingBlobComposerAttachments(pendingBlobAttachments);
        if (hydratedPendingImages.length > 0) {
          composerImagesForSend = [...composerImagesForSend, ...hydratedPendingImages];
        }
      }
    }
    const composerFilesForSend = queuedChatTurn?.files ?? composerFiles;
    const composerAssistantSelectionsForSend =
      queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
    const composerFileCommentsForSend = queuedChatTurn?.fileComments ?? composerFileComments;
    const composerTerminalContextsForSend =
      queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
    const composerPastedTextsForSend = queuedChatTurn?.pastedTexts ?? composerPastedTexts;
    const selectedComposerSkillsForSend =
      queuedChatTurn?.skills ?? selectedComposerSkillsRef.current;
    const selectedComposerMentionsForSend =
      queuedChatTurn?.mentions ?? selectedComposerMentionsRef.current;
    const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
    const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
    const selectedPromptEffortForSend =
      queuedChatTurn?.selectedPromptEffort ?? selectedPromptEffort;
    const selectedModelSelectionForSend = queuedChatTurn?.modelSelection ?? selectedModelSelection;
    let selectedConnectionIdForSend =
      queuedChatTurn === null
        ? resolveSelectedConnection(
            selectedModelSelectionForSend.provider,
            selectedModelSelectionForSend.model,
          )
        : queuedChatTurn.connectionId;
    if (selectedConnectionIdForSend === undefined && queuedChatTurn === null) {
      // A managed login may complete while Settings is closing or unmounted,
      // before its cache invalidation reaches this already-mounted composer.
      // Re-read the authoritative Space snapshot at the admission boundary;
      // this selects only the exact persisted default/route and never guesses.
      const availableConnectionIds = runtimeModelsByProvider[
        selectedModelSelectionForSend.provider
      ].find(
        (descriptor) => descriptor.slug === selectedModelSelectionForSend.model,
      )?.availableConnectionIds;
      selectedConnectionIdForSend = await resolveComposerConnectionAtAdmission({
        snapshot: providerConnectionsQuery.data,
        refreshSnapshot: async () => (await providerConnectionsQuery.refetch()).data,
        refreshAvailableConnectionIds: async () =>
          (
            await api.provider.listModels({
              provider: selectedModelSelectionForSend.provider,
              ...(selectedModelSelectionForSend.provider === "opencode" && providerModelDiscoveryCwd
                ? { cwd: providerModelDiscoveryCwd }
                : {}),
            })
          ).models.find((model) => model.slug === selectedModelSelectionForSend.model)
            ?.availableConnectionIds,
        provider: selectedModelSelectionForSend.provider,
        model: selectedModelSelectionForSend.model,
        ...(availableConnectionIds === undefined ? {} : { availableConnectionIds }),
        explicitSelection: {
          specified: Object.prototype.hasOwnProperty.call(
            selectedConnectionByProvider,
            selectedModelSelectionForSend.provider,
          ),
          connectionId: selectedConnectionByProvider[selectedModelSelectionForSend.provider],
        },
        startedThreadBinding: {
          loaded: threadProviderBindingQuery.data !== undefined,
          connectionId: threadProviderBindingQuery.data?.binding?.connectionId,
        },
        hasThreadStarted,
      });
    }
    // A first turn may omit the Connection and let the server resolve the
    // Space's persisted default (or declared anonymous route). Once a harness
    // has started, however, the exact durable binding remains mandatory.
    if (selectedConnectionIdForSend === undefined && hasThreadStarted) {
      setThreadError(activeThread.id, "Choose a Connection before sending this message.");
      return false;
    }
    const providerOptionsForDispatchForSend =
      queuedChatTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch;
    const runtimeModeForSend = queuedChatTurn?.runtimeMode ?? runtimeMode;
    const envModeForSend = queuedChatTurn?.envMode ?? envMode;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      sendablePastedTexts: sendableComposerPastedTexts,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImagesForSend.length,
      fileCount: composerFilesForSend.length,
      assistantSelectionCount: composerAssistantSelectionsForSend.length,
      fileCommentCount: composerFileCommentsForSend.length,
      terminalContexts: composerTerminalContextsForSend,
      pastedTexts: composerPastedTextsForSend,
    });
    const trimmedPromptForSend = trimmed;
    const hasNoStructuredComposerContext =
      composerImagesForSend.length === 0 &&
      composerFilesForSend.length === 0 &&
      composerAssistantSelectionsForSend.length === 0 &&
      composerFileCommentsForSend.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      sendableComposerPastedTexts.length === 0 &&
      // Provider mentions are structured turn metadata.
      selectedComposerMentionsForSend.length === 0;
    const hasPromptOnlySendableContent = hasNoStructuredComposerContext;
    if (hasPromptOnlySendableContent) {
      const handledSlashCommand =
        await lateSendHandlers.handleStandaloneSlashCommand(trimmedPromptForSend);
      if (handledSlashCommand) {
        return true;
      }
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return false;
    }
    if (!activeProject) return false;
    if (
      (phase === "connecting" || phase === "running" || isSendBusy || hasPendingTurnStart) &&
      dispatchMode === "queue" &&
      queuedChatTurn === null
    ) {
      clearComposerInput(activeThread.id);
      scheduleComposerFocus();
      const queuedImagesForPersistence = await Promise.all(
        composerImagesForSend.map(async (image) => {
          try {
            return {
              ...image,
              previewUrl: await readFileAsDataUrl(image.file),
            };
          } catch {
            return image;
          }
        }),
      );
      setComposerQueuePaused(activeThread.id, false);
      enqueueQueuedComposerTurn(activeThread.id, {
        id: randomUUID(),
        kind: "chat",
        createdAt: new Date().toISOString(),
        previewText: buildQueuedComposerPreviewText({
          trimmedPrompt: trimmed,
          images: queuedImagesForPersistence,
          files: composerFilesForSend,
          assistantSelections: composerAssistantSelectionsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          fileComments: composerFileCommentsForSend,
          pastedTexts: sendableComposerPastedTexts,
        }),
        prompt: promptForSend,
        images: queuedImagesForPersistence,
        files: composerFilesForSend,
        assistantSelections: composerAssistantSelectionsForSend,
        fileComments: composerFileCommentsForSend,
        terminalContexts: sendableComposerTerminalContexts,
        pastedTexts: sendableComposerPastedTexts,
        skills: selectedComposerSkillsForSend,
        mentions: selectedComposerMentionsForSend,
        selectedProvider: selectedProviderForSend,
        selectedModel: selectedModelForSend,
        selectedPromptEffort: selectedPromptEffortForSend,
        modelSelection: selectedModelSelectionForSend,
        connectionId: selectedConnectionIdForSend ?? null,
        ...(providerOptionsForDispatchForSend
          ? { providerOptionsForDispatch: providerOptionsForDispatchForSend }
          : {}),
        runtimeMode: runtimeModeForSend,
        envMode: envModeForSend,
      });
      return true;
    }
    // A follow-up can be captured while the preceding send is still waiting
    // for provider admission. Queue admission above is deliberately allowed in
    // that window; only a second direct dispatch must be rejected.
    if (sendInFlightRef.current) {
      return false;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || !hasNativeUserMessages;
    const firstSendCreatedAt = new Date();
    let firstComposerImageNameForTitle: string | null = null;
    if (composerImagesForSend.length > 0) {
      firstComposerImageNameForTitle = composerImagesForSend[0]?.name ?? null;
    }
    let titleSeed = trimmedPromptForSend;
    if (!titleSeed) {
      if (firstComposerImageNameForTitle) {
        titleSeed = `Image: ${firstComposerImageNameForTitle}`;
      } else if (composerFilesForSend.length > 0) {
        titleSeed = `File: ${composerFilesForSend[0]?.name ?? "attachment"}`;
      } else if (composerAssistantSelectionsForSend.length > 0) {
        titleSeed = formatAssistantSelectionTitleSeed(composerAssistantSelectionsForSend.length);
      } else if (sendableComposerTerminalContexts.length > 0) {
        titleSeed = formatTerminalContextLabel(sendableComposerTerminalContexts[0]!);
      } else if (composerFileCommentsForSend.length > 0) {
        titleSeed = formatFileCommentTitleSeed(composerFileCommentsForSend.length);
      } else if (sendableComposerPastedTexts.length > 0) {
        titleSeed =
          formatPastedTextTitleSeed(sendableComposerPastedTexts) ?? GENERIC_CHAT_THREAD_TITLE;
      } else {
        titleSeed = GENERIC_CHAT_THREAD_TITLE;
      }
    }
    // Keep the optimistic label short while the server asks Codex for a better summary.
    const title = buildPromptThreadTitleFallback(titleSeed);
    const currentStoreState = useStore.getState();
    const activeSpaceIdForSend = readActiveSpaceId();
    const threadSpaceIdForSend = requireNewThreadSpaceId(activeSpaceIdForSend);
    const firstSendTarget = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot,
      createdAt: firstSendCreatedAt,
      isFirstMessage,
      isHomeChatContainer,
      isStudioContainer,
      projects: currentStoreState.projects,
      selectedWorkspaceRoot: null,
      title,
      titleSeed,
    });
    let {
      targetProjectId: targetProjectIdForSend,
      targetProjectKind: targetProjectKindForSend,
      targetProjectDefaultModelSelection: targetProjectDefaultModelSelectionForSend,
    } = firstSendTarget.kind === "create-project"
      ? {
          targetProjectId: activeProject.id,
          targetProjectKind: activeProject.kind,
          targetProjectDefaultModelSelection: activeProject.defaultModelSelection ?? null,
        }
      : firstSendTarget.target;
    let nextRuntimeModeForSend = runtimeModeForSend;
    const nextThreadEnvMode = "local" as const;
    const nextThreadBranch = null;
    const nextThreadWorktreePath = null;
    const nextAssociatedWorktreePath = null;
    const nextAssociatedWorktreeBranch = null;
    const nextAssociatedWorktreeRef = null;

    if (isFirstMessage && isContainerLandingProject && firstSendTarget.kind !== "current") {
      if (firstSendTarget.kind === "create-project") {
        const projectId = newProjectId();
        const createdAt = firstSendCreatedAt.toISOString();
        const createProjectSpaceFields =
          firstSendTarget.creation.kind === "project" ? { spaceId: activeSpaceIdForSend } : {};
        try {
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            kind: firstSendTarget.creation.kind,
            title: firstSendTarget.creation.title,
            workspaceRoot: firstSendTarget.creation.workspaceRoot,
            createWorkspaceRootIfMissing: firstSendTarget.creation.createWorkspaceRootIfMissing,
            defaultModelSelection: firstSendTarget.creation.defaultModelSelection,
            // Managed chat rows stay global; folder mentions create ordinary projects.
            ...createProjectSpaceFields,
            createdAt,
          });
          targetProjectIdForSend = projectId;
          targetProjectKindForSend = firstSendTarget.creation.kind;
          targetProjectDefaultModelSelectionForSend =
            firstSendTarget.creation.defaultModelSelection;
        } catch (error) {
          const description =
            error instanceof Error ? error.message : "Failed to create the selected folder.";
          if (!isDuplicateProjectCreateError(description)) {
            throw error;
          }

          // If the server already knows this workspace root, reuse that project and continue.
          const { snapshot, project: recoveredProject } =
            await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: firstSendTarget.creation.workspaceRoot,
              loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
            });
          if (!snapshot || !recoveredProject || recoveredProject.workspaceRoot === null) {
            throw error;
          }

          syncServerShellSnapshot(snapshot);
          targetProjectIdForSend = recoveredProject.id;
          targetProjectKindForSend = recoveredProject.kind ?? firstSendTarget.creation.kind;
          targetProjectDefaultModelSelectionForSend =
            recoveredProject.defaultModelSelection ??
            firstSendTarget.creation.defaultModelSelection;
        }
      }

      clearProjectDraftThreadId(targetProjectIdForSend);
      setDraftThreadContext(threadIdForSend, {
        projectId: targetProjectIdForSend,
        envMode: "local",
        worktreePath: null,
        branch: null,
      });
    }
    const messageIdForSend = newMessageId();
    const isFollowUpToActiveTurn =
      phase === "connecting" || phase === "running" || isSendBusy || hasPendingTurnStart;

    setComposerQueuePaused(threadIdForSend, false);
    sendInFlightRef.current = true;
    if (!isFollowUpToActiveTurn) {
      beginLocalDispatch({ expectedUserMessageId: messageIdForSend });
    }

    const composerImagesSnapshot = [...composerImagesForSend];
    const composerFilesSnapshot = [...composerFilesForSend];
    const composerAssistantSelectionsSnapshot = [...composerAssistantSelectionsForSend];
    const composerFileCommentsSnapshot = [...composerFileCommentsForSend];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerPastedTextsSnapshot = [...sendableComposerPastedTexts];
    const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
    const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
    // Trailing blocks are appended innermost-to-outermost: assistant selections,
    // terminal contexts, file comments, then pasted text (outermost). The display
    // extractors unwrap them in the reverse order.
    const messageTextForSend = appendPastedTextsToPrompt(
      appendFileCommentsToPrompt(
        appendTerminalContextsToPrompt(
          appendAssistantSelectionsToPrompt(promptForSend, composerAssistantSelectionsSnapshot),
          composerTerminalContextsSnapshot,
        ),
        composerFileCommentsSnapshot,
      ),
      composerPastedTextsSnapshot,
    );
    const messageCreatedAt = new Date().toISOString();
    if (!isFollowUpToActiveTurn) {
      pendingTurnStartMessageRef.current = {
        id: messageIdForSend,
        kind: "chat",
        createdAt: messageCreatedAt,
        previewText: buildQueuedComposerPreviewText({
          trimmedPrompt: trimmedPromptForSend,
          images: composerImagesSnapshot,
          files: composerFilesSnapshot,
          assistantSelections: composerAssistantSelectionsSnapshot,
          terminalContexts: composerTerminalContextsSnapshot,
          fileComments: composerFileCommentsSnapshot,
          pastedTexts: composerPastedTextsSnapshot,
        }),
        messageId: messageIdForSend,
        prompt: promptForSend,
        images: composerImagesSnapshot,
        files: composerFilesSnapshot,
        assistantSelections: composerAssistantSelectionsSnapshot,
        fileComments: composerFileCommentsSnapshot,
        terminalContexts: composerTerminalContextsSnapshot,
        pastedTexts: composerPastedTextsSnapshot,
        skills: composerSkillsSnapshot,
        mentions: composerMentionsSnapshot,
        selectedProvider: selectedProviderForSend,
        selectedModel: selectedModelForSend,
        selectedPromptEffort: selectedPromptEffortForSend,
        modelSelection: selectedModelSelectionForSend,
        connectionId: selectedConnectionIdForSend ?? null,
        ...(providerOptionsForDispatchForSend
          ? { providerOptionsForDispatch: providerOptionsForDispatchForSend }
          : {}),
        runtimeMode: runtimeModeForSend,
        envMode: envModeForSend,
      };
    }
    const throwIfPendingTurnStartCancelled = () => {
      if (cancelPendingTurnStartMessageIdsRef.current.has(messageIdForSend)) {
        throw new PendingTurnStartCancelled();
      }
    };
    const outgoingTextSeed =
      messageTextForSend || (composerImagesSnapshot.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: selectedProviderForSend,
      model: selectedModelForSend,
      effort: selectedPromptEffortForSend,
      text: outgoingTextSeed,
    });
    const mentionedSkillsForSend = filterPromptSkillReferences(
      outgoingMessageText,
      selectedComposerSkillsForSend,
      selectedProviderForSend,
    );
    const mentionedPluginMentionsForSend = filterPromptProviderMentionReferences(
      outgoingMessageText,
      selectedComposerMentionsForSend,
    );
    const turnAttachmentsPromise = stageUploadComposerAttachments({
      threadId: threadIdForSend,
      images: composerImagesSnapshot,
      files: composerFilesSnapshot,
      assistantSelections: composerAssistantSelectionsSnapshot,
    });
    const optimisticAttachments = [
      ...composerAssistantSelectionsSnapshot,
      ...composerImagesSnapshot.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      })),
      ...composerFilesSnapshot.map((file) => ({
        type: "file" as const,
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })),
    ];
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        dispatchMode,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
        ...(mentionedPluginMentionsForSend.length > 0
          ? { mentions: mentionedPluginMentionsForSend }
          : {}),
        createdAt: messageCreatedAt,
        streaming: false,
        source: "native",
      },
    ]);
    // Mark the transcript as anchored before the optimistic row lands so the
    // re-snap effect on row count change pulls us to the new tail.
    armTranscriptAutoFollow(threadIdForSend, true);

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    // Queued turns are dispatched from their captured snapshot, so this send path
    // must not clear a separate live draft the user may already be editing.
    if (queuedChatTurn === null) {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      clearComposerDraftContent(threadIdForSend, { preservePreviewUrls: true });
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      // A clicked submit button steals focus; return it after the controlled
      // draft reset so rapid follow-up typing lands in the composer.
      scheduleComposerFocus();
    }

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    await (async () => {
      throwIfPendingTurnStartCancelled();
      const threadCreateModelSelection: ModelSelection = buildModelSelection(
        selectedModelSelectionForSend.provider,
        selectedModelSelectionForSend.model ||
          selectedModelForSend ||
          targetProjectDefaultModelSelectionForSend?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelectionForSend.options,
      );

      if (isLocalDraftThread) {
        const promotionResult = await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            projectId: targetProjectIdForSend,
            spaceId: threadSpaceIdForSend,
            title,
            modelSelection: threadCreateModelSelection,
            runtimeMode: nextRuntimeModeForSend,
            envMode: nextThreadEnvMode,
            branch: nextThreadBranch,
            worktreePath: nextThreadWorktreePath,
            workingDirectory: resolvedThreadWorkingDirectory,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            createdAt: activeThread.createdAt,
          },
          api,
          { force: true },
        );
        createdServerThreadForLocalDraft = promotionResult === "created";
        throwIfPendingTurnStartCancelled();
        if (targetProjectKindForSend === "chat") {
          await api.orchestration.dispatchCommand({
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId: targetProjectIdForSend,
            title,
          });
        }
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          runtimeMode: nextRuntimeModeForSend,
        });
        throwIfPendingTurnStartCancelled();
      }

      if (!isFollowUpToActiveTurn) {
        beginLocalDispatch();
      }
      const stagedTurnAttachments = await turnAttachmentsPromise;
      throwIfPendingTurnStartCancelled();
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: selectedModelSelectionForSend.provider,
        providerOptions: providerOptionsForDispatchForSend,
      });
      // The resolver returns the protocol's exact revision zero for an
      // unstarted thread and the authoritative managed-binding revision for a
      // continuation.
      const bindingRevisionForSend = await resolveThreadBindingRevisionAtAdmission();
      await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
        api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachments,
            ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
            ...(mentionedPluginMentionsForSend.length > 0
              ? { mentions: mentionedPluginMentionsForSend }
              : {}),
          },
          modelSelection: selectedModelSelectionForSend,
          ...(selectedConnectionIdForSend === undefined
            ? {}
            : { connectionId: selectedConnectionIdForSend }),
          ...(bindingRevisionForSend === undefined
            ? {}
            : { bindingRevision: bindingRevisionForSend }),
          ...(providerOptionsForDispatchForSend
            ? { providerOptions: providerOptionsForDispatchForSend }
            : {}),
          assistantDeliveryMode,
          dispatchMode,
          runtimeMode: nextRuntimeModeForSend,
          createdAt: messageCreatedAt,
        }),
      );
      await queryClient.invalidateQueries({
        queryKey: providerConnectionQueryKeys.thread(threadIdForSend),
      });
      setSelectedConnectionByProvider((current) => {
        const next = { ...current };
        delete next[selectedModelSelectionForSend.provider];
        return next;
      });
      turnStartSucceeded = true;
      if (cancelPendingTurnStartMessageIdsRef.current.delete(messageIdForSend)) {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          pendingMessageId: messageIdForSend,
          createdAt: new Date().toISOString(),
        });
      }
    })().catch(async (err: unknown) => {
      const wasCancelled = err instanceof PendingTurnStartCancelled;
      // Uploads start in parallel with workspace/session preparation. If any
      // earlier step fails, settle that promise and release every staged blob.
      await turnAttachmentsPromise.then(
        (staged) => staged.cleanup(),
        () => undefined,
      );
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        // This rollback cleans up a retryable draft promotion; do not tombstone the draft id.
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        queuedChatTurn === null &&
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerFilesRef.current.length === 0 &&
        composerAssistantSelectionsRef.current.length === 0 &&
        composerFileCommentsRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerPastedTextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageAttachment));
        addComposerFilesToDraft(composerFilesSnapshot);
        for (const selection of composerAssistantSelectionsSnapshot) {
          addComposerAssistantSelectionToDraft(selection);
        }
        for (const comment of composerFileCommentsSnapshot) {
          addComposerFileCommentToDraft(comment);
        }
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        addComposerPastedTextsToDraft(composerPastedTextsSnapshot);
        updateSelectedComposerSkills(composerSkillsSnapshot);
        updateSelectedComposerMentions(composerMentionsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      if (!wasCancelled) {
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send message.",
        );
      }
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
    cancelPendingTurnStartMessageIdsRef.current.delete(messageIdForSend);
    return turnStartSucceeded;
  };

  const onRespondToApproval = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      lifecycleGeneration?: string,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);

      setRespondingRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      // Durably persist "always allow" client-side so the next turn (after an
      // idle-stop or runtime restart) keeps full-access instead of asking again.
      // The server's session override only covers the current live turn.
      const durableRuntimeMode = resolveRuntimeModeAfterApprovalDecision(runtimeMode, decision);
      if (durableRuntimeMode) {
        setComposerDraftRuntimeMode(activeThreadId, durableRuntimeMode);
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestKeys((existing) => existing.filter((key) => key !== requestKey));
    },
    [activeThreadId, runtimeMode, setComposerDraftRuntimeMode, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
      lifecycleGeneration?: string,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);
      const dispatchAnswers = hasCompletePendingUserInputAnswers(answers)
        ? answers
        : omitNullPendingUserInputAnswers(answers);

      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers: dispatchAnswers,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestKeys((existing) => existing.filter((key) => key !== requestKey));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onCancelActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingIsResponding) {
      return;
    }
    promptRef.current = "";
    setPrompt("");
    setComposerCursor(0);
    setComposerTrigger(null);
    void onRespondToUserInput(
      activePendingUserInput.requestId,
      {},
      activePendingUserInput.lifecycleGeneration,
    );
  }, [activePendingIsResponding, activePendingUserInput, onRespondToUserInput, setPrompt]);

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInputKey) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInputKey],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput || !activePendingUserInputKey) {
        return null;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return null;
      }
      const nextDraftAnswer = togglePendingUserInputOptionSelection(
        question,
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        optionLabel,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
      return nextDraftAnswer;
    },
    [activePendingUserInput, activePendingUserInputKey],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInputKey) {
        return;
      }
      promptRef.current = value;
      const nextDraftAnswer = setPendingUserInputCustomAnswer(
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        value,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInputKey],
  );

  const onAdvanceActivePendingUserInput = useCallback(
    (answerOverrides?: Record<string, PendingUserInputDraftAnswer>): boolean => {
      if (!activePendingUserInput || !activePendingUserInputKey || !activePendingProgress) {
        return false;
      }
      const pendingDraftAnswers =
        answerOverrides && Object.keys(answerOverrides).length > 0
          ? {
              ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
              ...answerOverrides,
            }
          : (pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey] ??
            activePendingDraftAnswers);
      if (answerOverrides && Object.keys(answerOverrides).length > 0) {
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: pendingDraftAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: pendingDraftAnswers,
        }));
      }
      const resolvedAnswers = buildPendingUserInputAnswers(
        activePendingUserInput.questions,
        pendingDraftAnswers,
      );
      if (activePendingProgress.isLastQuestion) {
        if (resolvedAnswers) {
          void onRespondToUserInput(
            activePendingUserInput.requestId,
            resolvedAnswers,
            activePendingUserInput.lifecycleGeneration,
          );
          return true;
        }
        return false;
      }
      const activeQuestionId = activePendingProgress.activeQuestion?.id ?? null;
      const hasActiveOverride = activeQuestionId
        ? answerOverrides?.[activeQuestionId] !== undefined
        : false;
      if (!activePendingProgress.canAdvance && !hasActiveOverride) {
        return false;
      }
      setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
      return true;
    },
    [
      activePendingDraftAnswers,
      activePendingProgress,
      activePendingUserInput,
      activePendingUserInputKey,
      onRespondToUserInput,
      setActivePendingUserInputQuestionIndex,
    ],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onEditUserMessage = useCallback(
    async (messageId: MessageId, text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeThread || !isServerThread || isRevertingCheckpoint) {
        return false;
      }
      const editTarget = resolveTailUserMessageEditTarget({
        messages: activeThread.messages,
        messageId,
        activeTurnId:
          activeThread.session?.orchestrationStatus === "running"
            ? (activeThread.session.activeTurnId ?? null)
            : null,
      });
      if (!editTarget.editable) {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      const originalMessage = activeThread.messages[editTarget.messageIndex];
      if (!originalMessage || originalMessage.role !== "user") {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      if (isSendBusy || isConnecting || sendInFlightRef.current) {
        setThreadError(activeThread.id, "Wait for the current send to start before editing.");
        return false;
      }
      if (selectedConnectionId === undefined) {
        setThreadError(activeThread.id, "Choose a Connection before resending this message.");
        return false;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const messageCreatedAt = new Date().toISOString();
      const editedTextWithOriginalContext = appendOriginalComposerPromptBlocks({
        editedPrompt: text,
        originalPrompt: originalMessage.text,
      });
      const outgoingMessageText = formatOutgoingComposerPrompt({
        provider: selectedProvider,
        model: selectedModel,
        effort: selectedPromptEffort,
        text: editedTextWithOriginalContext,
      });
      return await (async () => {
        await persistThreadSettingsForNextTurn({
          threadId: activeThread.id,
          createdAt: messageCreatedAt,
          runtimeMode,
        });
        const bindingRevisionForSend = await resolveThreadBindingRevisionAtAdmission();
        if (bindingRevisionForSend === undefined) {
          throw new Error("Could not load the thread's current provider binding.");
        }
        await api.orchestration.dispatchCommand({
          type: "thread.message.edit-and-resend",
          commandId: newCommandId(),
          threadId: activeThread.id,
          messageId,
          text: outgoingMessageText,
          modelSelection: selectedModelSelection,
          connectionId: selectedConnectionId ?? null,
          bindingRevision: bindingRevisionForSend,
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode,
          runtimeMode,
          createdAt: messageCreatedAt,
        });
        return true;
      })()
        .catch((err: unknown) => {
          setThreadError(
            activeThread.id,
            err instanceof Error ? err.message : "Failed to edit message.",
          );
          return false;
        })
        .finally(() => {
          setIsRevertingCheckpoint(false);
        });
    },
    [
      activeThread,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      providerOptionsForDispatch,
      runtimeMode,
      selectedModel,
      selectedModelSelection,
      selectedConnectionId,
      resolveThreadBindingRevisionAtAdmission,
      selectedPromptEffort,
      selectedProvider,
      setThreadError,
      assistantDeliveryMode,
    ],
  );

  const onSendRef = useRef(onSend);
  // The queued dispatcher can run from the same commit's follow-up work, so do
  // not leave a passive-effect window where it sees the previous callbacks.
  useLayoutEffect(() => {
    onSendRef.current = onSend;
  });

  const dispatchQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn, dispatchMode: "queue" | "steer"): Promise<boolean> => {
      return onSendRef.current(undefined, dispatchMode, queuedTurn);
    },
    [],
  );

  // Resuming a workflow is a normal composer turn instructing the agent to
  // re-invoke the Workflow tool against the persisted script; completed agent()
  // calls replay from cache, so a paused run picks up where it stopped. Sent as
  // a pre-built chat turn so it takes the exact send path a queued turn does.
  const onResumeWorkflowRun = useCallback(async () => {
    if (
      !workflowRunState?.scriptPath ||
      !workflowRunState.runId ||
      selectedConnectionId === undefined
    ) {
      return;
    }
    const { workflowTaskId } = workflowRunState;
    const prompt = buildWorkflowResumePrompt(workflowRunState.scriptPath, workflowRunState.runId);
    const sent = await onSendRef.current(undefined, "queue", {
      id: randomUUID(),
      kind: "chat",
      createdAt: new Date().toISOString(),
      previewText: prompt,
      prompt,
      images: [],
      files: [],
      assistantSelections: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      skills: [],
      mentions: [],
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      modelSelection: selectedModelSelection,
      connectionId: selectedConnectionId,
      ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
      runtimeMode,
      envMode,
    });
    if (sent && activeThreadId) {
      markWorkflowRunDismissed(activeThreadId, workflowTaskId);
    }
  }, [
    activeThreadId,
    envMode,
    markWorkflowRunDismissed,
    providerOptionsForDispatch,
    runtimeMode,
    selectedModel,
    selectedModelSelection,
    selectedConnectionId,
    selectedPromptEffort,
    selectedProvider,
    workflowRunState,
  ]);

  const onSteerQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn) => {
      const previousQueue = queuedComposerTurnsRef.current;
      const queuedIndex = previousQueue.findIndex((entry) => entry.id === queuedTurn.id);
      if (queuedIndex < 0) {
        return;
      }
      setComposerQueuePaused(threadId, false);
      let resolvedQueuedTurn = queuedTurn;
      const pendingDispatch = getQueuedComposerTurnDispatchInFlight(threadId, queuedTurn.id);
      if (pendingDispatch) {
        try {
          await pendingDispatch;
        } catch {
          return;
        }
        resolvedQueuedTurn =
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.queuedTurns.find(
              (candidate) => candidate.id === queuedTurn.id,
            ) ?? queuedTurn;
      }
      const messageId = queuedComposerTurnServerMessageId(resolvedQueuedTurn);
      const delivery = serverDeliveryByMessageId.get(messageId);
      const isServerAccepted =
        resolvedQueuedTurn.serverAcceptedAt !== undefined ||
        delivery !== undefined ||
        (activeThread?.queuedMessageIds ?? []).includes(messageId);
      if (isServerAccepted) {
        const api = readNativeApi();
        if (!api) {
          return;
        }
        setOptimisticUserMessages((existing) =>
          existing.some((message) => message.id === messageId)
            ? existing
            : [
                ...existing,
                {
                  id: messageId,
                  role: "user",
                  text: resolvedQueuedTurn.prompt,
                  dispatchMode: "steer",
                  ...(resolvedQueuedTurn.skills.length > 0
                    ? { skills: resolvedQueuedTurn.skills }
                    : {}),
                  ...(resolvedQueuedTurn.mentions.length > 0
                    ? { mentions: resolvedQueuedTurn.mentions }
                    : {}),
                  createdAt: resolvedQueuedTurn.createdAt,
                  streaming: false,
                  source: "native",
                },
              ],
        );
        armTranscriptAutoFollow(threadId, true);
        setQueuedActionStateByMessageId((current) => {
          const next = new Map(current);
          next.set(messageId, "steering");
          return next;
        });
        try {
          await api.orchestration.dispatchCommand({
            type: "thread.turn.steer-queued",
            commandId: newCommandId(),
            threadId,
            messageId,
            createdAt: new Date().toISOString(),
          });
          setThreadError(threadId, null);
        } catch (error) {
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== messageId),
          );
          setQueuedActionStateByMessageId((current) => {
            const next = new Map(current);
            next.delete(messageId);
            return next;
          });
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Failed to steer queued message.",
          );
        }
        return;
      }
      removeQueuedComposerTurnFromDraft(threadId, resolvedQueuedTurn.id);
      const succeeded = await dispatchQueuedComposerTurn(resolvedQueuedTurn, "steer");
      if (succeeded) {
        return;
      }
      insertQueuedComposerTurn(threadId, resolvedQueuedTurn, queuedIndex);
    },
    [
      dispatchQueuedComposerTurn,
      insertQueuedComposerTurn,
      activeThread?.queuedMessageIds,
      serverDeliveryByMessageId,
      removeQueuedComposerTurnFromDraft,
      setQueuedActionStateByMessageId,
      setOptimisticUserMessages,
      setThreadError,
      setComposerQueuePaused,
      threadId,
    ],
  );

  const onEditQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      void cancelQueuedComposerTurn(queuedTurn).then((cancelled) => {
        if (cancelled) {
          restoreQueuedTurnToComposer(queuedTurn);
        }
      });
    },
    [cancelQueuedComposerTurn, restoreQueuedTurnToComposer],
  );

  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const selectedProviderModelOptions = composerModelOptions?.[selectedProvider];
  const composerTraitSelection = getComposerTraitSelection(
    selectedProvider,
    selectedModel,
    prompt,
    selectedProviderModelOptions,
    selectedRuntimeModel,
  );
  const runtimeUsageContextWindow = useMemo(
    () =>
      activeContextWindow ??
      (selectedProvider === "claudeAgent"
        ? deriveSelectedContextWindowSnapshot(composerTraitSelection.contextWindow)
        : null),
    [activeContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const contextWindowSelectionStatus = useMemo(
    () =>
      deriveContextWindowSelectionStatus({
        activeSnapshot: runtimeUsageContextWindow,
        selectedValue:
          selectedProvider === "claudeAgent" ? composerTraitSelection.contextWindow : null,
      }),
    [runtimeUsageContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const composerFooterControlsPlan = useMemo(
    () => composerFooterPlanForTier(composerFooterTier, Boolean(runtimeUsageContextWindow)),
    [composerFooterTier, runtimeUsageContextWindow],
  );
  const useSplitComposerPickerControls = isLocalDraftThread && !hasThreadStarted;
  // The displayed labels changed (model switch, effort change, picker layout):
  // recorded overflow widths no longer apply, so reset to the richest tier and
  // let the measured-overflow loop demote again before paint if needed.
  const composerFooterModelLabel = resolveProviderModelLabel({
    provider: selectedProvider,
    lockedProvider,
    model: selectedModelForPickerWithCustomFallback,
    modelOptionsByProvider,
  });
  const composerFooterTraitsSummary = resolveTraitsTriggerSummary({
    provider: selectedProvider,
    model: selectedModelForPickerWithCustomFallback,
    prompt,
    modelOptions: selectedProviderModelOptions,
    ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
    runtimeAgents: dynamicAgents,
  });
  const composerFooterPlanInputsKey = [
    composerFooterModelLabel,
    composerFooterTraitsSummary.summaryText,
    Boolean(runtimeUsageContextWindow),
    useSplitComposerPickerControls,
  ].join(":");
  useLayoutEffect(() => {
    composerFooterDemotionWidthsRef.current = [];
    composerFooterTierRef.current = 0;
    setComposerFooterTier(0);
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterPlanInputsKey]);
  // After a tier renders, re-measure before paint: a still-overflowing footer
  // demotes another step until it fits (bounded by COMPOSER_FOOTER_MAX_TIER).
  useLayoutEffect(() => {
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterTier]);
  const isComposerModelEffortPickerOpen = isModelPickerOpen || isTraitsPickerOpen;
  const handleComposerModelEffortPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        handleModelPickerOpenChange(true);
      } else {
        setIsModelPickerOpen(false);
        setIsTraitsPickerOpen(false);
      }
    },
    [handleModelPickerOpenChange],
  );
  const composerPickerControls = useSplitComposerPickerControls ? (
    <>
      <ModelSelectorEmptyThread>
        <ProviderModelPicker
          compact={isComposerFooterCompact}
          hideLabel={!composerFooterControlsPlan.showModelLabel}
          provider={selectedProvider}
          model={selectedModelForPickerWithCustomFallback}
          lockedProvider={lockedProvider}
          providers={providerStatuses}
          managedProviders={[...configuredProviderKinds]}
          modelOptionsByProvider={selectableModelOptionsByProvider}
          unavailableModelProviders={unavailableModelProviders}
          hiddenProviders={composerHiddenProviders}
          providerOrder={settings.providerOrder}
          onProviderModelChange={onProviderModelSelect}
          {...(hasThreadStarted
            ? {
                connections: selectedModelConnections,
                ...(selectedConnectionId === undefined ? {} : { selectedConnectionId }),
                onConnectionChange: handleConnectionChange,
                onManageConnections: handleManageConnections,
              }
            : {})}
          onSelectionCommitted={scheduleComposerFocus}
          open={isModelPickerOpen}
          onOpenChange={handleModelPickerOpenChange}
          shortcutLabel={modelPickerShortcutLabel}
          triggerClassName="!h-[25px] rounded-lg px-2 py-0 sm:!h-[25px] sm:px-2"
        />
      </ModelSelectorEmptyThread>
      <EffortSelectorEmptyThread>
        <TraitsPicker
          provider={selectedProvider}
          threadId={threadId}
          model={selectedModelForPickerWithCustomFallback}
          runtimeModel={selectedRuntimeModel}
          runtimeModels={runtimeModelsByProvider[selectedProvider]}
          runtimeAgents={dynamicAgents}
          modelOptions={selectedProviderModelOptions}
          prompt={prompt}
          onPromptChange={setPromptFromTraits}
          open={isTraitsPickerOpen}
          onOpenChange={handleTraitsPickerOpenChange}
          onSelectionCommitted={scheduleComposerFocus}
          shortcutLabel={traitsPickerShortcutLabel}
          hideLabel={!composerFooterControlsPlan.showTraitsLabel}
          menuClassName="w-[200px] min-w-[200px]"
          pencilMenuComponentId="e4cfzr"
          triggerClassName="!h-[25px] gap-[5px] rounded-lg px-2 py-0 sm:!h-[25px] sm:px-2"
        />
      </EffortSelectorEmptyThread>
    </>
  ) : (
    <ComposerModelEffortPicker
      compact={isComposerFooterCompact}
      hideModelLabel={!composerFooterControlsPlan.showModelLabel}
      hideStatusLabel={!composerFooterControlsPlan.showTraitsLabel}
      provider={selectedProvider}
      model={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      providers={providerStatuses}
      managedProviders={[...configuredProviderKinds]}
      modelOptionsByProvider={selectableModelOptionsByProvider}
      unavailableModelProviders={unavailableModelProviders}
      hiddenProviders={composerHiddenProviders}
      providerOrder={settings.providerOrder}
      threadId={threadId}
      runtimeModel={selectedRuntimeModel}
      runtimeModels={runtimeModelsByProvider[selectedProvider]}
      runtimeAgents={dynamicAgents}
      modelOptions={selectedProviderModelOptions}
      prompt={prompt}
      onPromptChange={setPromptFromTraits}
      onProviderModelChange={onProviderModelSelect}
      {...(hasThreadStarted
        ? {
            connections: selectedModelConnections,
            ...(selectedConnectionId === undefined ? {} : { selectedConnectionId }),
            onConnectionChange: handleConnectionChange,
            onManageConnections: handleManageConnections,
          }
        : {})}
      onSelectionCommitted={scheduleComposerFocus}
      open={isComposerModelEffortPickerOpen}
      onOpenChange={handleComposerModelEffortPickerOpenChange}
      shortcutLabel={modelPickerShortcutLabel}
    />
  );
  const ComposerFooterActions = useSplitComposerPickerControls
    ? ComposerActionsEmptyThread
    : ComposerActions;
  const toggleFastMode = useCallback(() => {
    if (!composerTraitSelection.caps.supportsFastMode) {
      scheduleComposerFocus();
      return;
    }
    setComposerDraftProviderModelOptions(
      threadId,
      selectedProvider,
      buildNextProviderOptions(selectedProvider, selectedProviderModelOptions, {
        fastMode: !composerTraitSelection.fastModeEnabled,
      }),
      { persistSticky: true },
    );
    scheduleComposerFocus();
  }, [
    composerTraitSelection.caps.supportsFastMode,
    composerTraitSelection.fastModeEnabled,
    scheduleComposerFocus,
    selectedProvider,
    selectedProviderModelOptions,
    setComposerDraftProviderModelOptions,
    threadId,
  ]);
  const handleResetWorkspaceToHome = useCallback(() => {
    if (!isLocalDraftThread) return;
    setDraftThreadContext(threadId, { workingDirectory: null });
    scheduleComposerFocus();
  }, [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId]);

  const handleSelectWorkspaceRoot = useCallback(
    (workspaceRoot: string) => {
      if (!isLocalDraftThread) return;
      setDraftThreadContext(threadId, { workingDirectory: workspaceRoot });
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; cursorOffset?: number },
    ): number | false => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      let nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      // Apply cursor offset if specified (e.g., -1 to position inside parentheses)
      if (options?.cursorOffset !== undefined) {
        nextCursor = Math.max(0, nextCursor + options.cursorOffset);
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInputKey) {
        const nextDraftAnswer = setPendingUserInputCustomAnswer(
          pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
            activePendingQuestion.id
          ],
          next.text,
        );
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
          [activePendingQuestion.id]: nextDraftAnswer,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: nextRequestAnswers,
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return nextCursor;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInputKey, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      selectionCollapsed: true,
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: {
      value: string;
      cursor: number;
      expandedCursor: number;
      selectionCollapsed: boolean;
    };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  // Shared insertion path for picker selections (mentions, plugins, skills,
  // agents, provider-native commands, local folders). Guarantees the replacement
  // is flanked by a leading space when landing next to a non-whitespace char and
  // absorbs an existing trailing space so we don't end up with double spaces.
  const applyComposerTriggerReplacement = useCallback(
    (params: {
      snapshot: { value: string };
      trigger: ComposerTrigger;
      base: string;
      cursorOffset?: number;
      onApplied?: () => void;
    }): number | false => {
      const { snapshot, trigger, base, cursorOffset, onApplied } = params;
      const replacement = ensureLeadingSpaceForReplacement(
        snapshot.value,
        trigger.rangeStart,
        base,
      );
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const options: { expectedText: string; cursorOffset?: number } = {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      };
      if (cursorOffset !== undefined) {
        options.cursorOffset = cursorOffset;
      }
      const applied = applyPromptReplacement(
        trigger.rangeStart,
        replacementRangeEnd,
        replacement,
        options,
      );
      if (applied !== false) {
        onApplied?.();
        setComposerHighlightedItemId(null);
      }
      return applied;
    },
    [applyPromptReplacement],
  );

  // Replaces the active `@...` token with a completed absolute folder mention.
  const handleSelectLocalDirectoryMention = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(absolutePath)} `,
      });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  // Rewrites the active `@...` mention to an absolute folder path with a trailing separator
  // so the local-folder picker stays open and the user can keep browsing by clicking or typing.
  // Paths that need quoting (spaces, parentheses, …) are written as an unclosed
  // `@"...` so detectComposerTrigger keeps matching while the user descends (#351).
  const handleNavigateLocalFolder = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      const separator = absolutePath.includes("\\") ? "\\" : "/";
      const withTrailingSeparator = absolutePath.endsWith(separator)
        ? absolutePath
        : `${absolutePath}${separator}`;
      const base = composerMentionPathNeedsQuoting(withTrailingSeparator)
        ? `@"${withTrailingSeparator}`
        : `@${withTrailingSeparator}`;
      applyComposerTriggerReplacement({ snapshot, trigger, base });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  const setComposerPromptValue = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [setPrompt],
  );

  const clearComposerSlashDraft = useCallback(() => {
    promptRef.current = "";
    clearComposerDraftContent(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    scheduleComposerFocus();
  }, [clearComposerDraftContent, scheduleComposerFocus, threadId]);

  const slashEditorActions = useMemo(
    () => ({
      resolveActiveComposerTrigger,
      applyPromptReplacement,
      clearComposerSlashDraft,
      setComposerPromptValue,
      scheduleComposerFocus,
      setComposerHighlightedItemId,
    }),
    [
      applyPromptReplacement,
      clearComposerSlashDraft,
      resolveActiveComposerTrigger,
      scheduleComposerFocus,
      setComposerPromptValue,
    ],
  );

  const {
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferExportCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd: composerSkillCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    selectedConnectionId,
    environmentMode: envMode ?? null,
    runtimeMode,
    threadId,
    syncServerShellSnapshot,
    navigateToThread: (nextThreadId, options) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        ...(options?.splitViewId ? { search: () => ({ splitViewId: options.splitViewId }) } : {}),
      }),
    handleClearConversation: async () => {
      if (!activeProject) {
        toastManager.add({
          type: "warning",
          title: "Clear is unavailable",
          description: "Open a folder before starting a fresh thread.",
        });
        return;
      }
      await handleNewThread(activeProject.id, { entryPoint: "chat" });
    },
    openForkTargetPicker: () => {
      setComposerCommandPicker("fork-target");
      setComposerHighlightedItemId("fork-target:worktree");
    },
    openReviewTargetPicker: () => {
      setComposerCommandPicker("review-target");
      setComposerHighlightedItemId("review-target:changes");
    },
    setComposerDraftProviderModelOptions,
    editorActions: slashEditorActions,
  });

  useLayoutEffect(() => {
    lateComposerSendHandlersRef.current = {
      advanceActivePendingUserInput: onAdvanceActivePendingUserInput,
      handleStandaloneSlashCommand,
    };
  });

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      if (item.type === "fork-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleForkTargetSelection(item.target);
        return;
      }
      if (item.type === "review-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleReviewTargetSelection(item.target);
        return;
      }
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.path)} `,
        });
        return;
      }
      if (item.type === "local-root") {
        handleNavigateLocalFolder(localFolderBrowseRootPath ?? "/");
        return;
      }
      if (item.type === "slash-command") {
        handleSlashCommandSelection(item);
        return;
      }
      if (item.type === "provider-native-command") {
        if (selectedProvider === "codex" && item.command.toLowerCase() === "review") {
          setComposerCommandPicker("review-target");
          setComposerHighlightedItemId("review-target:changes");
          scheduleComposerFocus();
          return;
        }
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `/${item.command} `,
        });
        return;
      }
      if (item.type === "skill") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
          onApplied: () => {
            updateSelectedComposerSkills((existing) => {
              const nextSkill = {
                name: item.skill.name,
                path: item.skill.path,
              } satisfies ProviderSkillReference;
              return existing.some(
                (skill) => skill.name === nextSkill.name && skill.path === nextSkill.path,
              )
                ? existing
                : [...existing, nextSkill];
            });
          },
        });
        return;
      }
      if (item.type === "plugin" || item.type === "thread") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.mention.name)} `,
          onApplied: () => {
            updateSelectedComposerMentions((existing) => {
              const nextMention = item.mention;
              const nextWithoutSameName = existing.filter(
                (mention) => mention.name !== nextMention.name,
              );
              return [...nextWithoutSameName, nextMention];
            });
          },
        });
        return;
      }
      if (item.type === "model") {
        onProviderModelSelect(item.provider, item.model);
        applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
        return;
      }
      if (item.type === "agent") {
        // Insert @alias() and position cursor inside the parentheses.
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `@${item.alias}()`,
          cursorOffset: -1,
        });
      }
    },
    [
      applyComposerTriggerReplacement,
      scheduleComposerFocus,
      handleForkTargetSelection,
      handleNavigateLocalFolder,
      handleReviewTargetSelection,
      handleSlashCommandSelection,
      onProviderModelSelect,
      setComposerCommandPicker,
      localFolderBrowseRootPath,
      selectedProvider,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        providerPluginsQuery.isLoading ||
        providerPluginsQuery.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingQuestion && activePendingUserInput) {
        const interruptedNavigation = promptHistoryNavigationRef.current;
        if (interruptedNavigation !== null) {
          // An active question ended the history browse while the persisted
          // prompt still held a recalled entry; put the real draft back.
          promptHistoryNavigationRef.current = null;
          restoreComposerDraftPromptHistorySavedDraft(threadId);
          promptRef.current = interruptedNavigation.draft;
          setPrompt(interruptedNavigation.draft);
        }
        expectedPromptHistoryPromptRef.current = null;
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      const expectedPromptHistoryPrompt = expectedPromptHistoryPromptRef.current;
      if (expectedPromptHistoryPrompt !== null) {
        if (nextPrompt === expectedPromptHistoryPrompt) {
          expectedPromptHistoryPromptRef.current = null;
        } else {
          // The user edited past the recalled entry: the edited text is the
          // draft now, so the saved pre-browse draft must not be restored.
          promptHistoryNavigationRef.current = null;
          expectedPromptHistoryPromptRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      } else if (!applyingPromptHistoryNavigationRef.current) {
        const activePromptHistoryNavigation = promptHistoryNavigationRef.current;
        if (
          activePromptHistoryNavigation !== null &&
          !promptStillMatchesActiveHistoryBrowse({
            state: activePromptHistoryNavigation,
            history: promptHistory,
            nextPrompt,
            appliedPrompt: promptHistoryAppliedPromptRef.current,
          })
        ) {
          promptHistoryNavigationRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (composerCommandPicker !== null && nextPrompt.trim().length > 0) {
        setComposerCommandPicker(null);
      }
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      composerCommandPicker,
      onChangeActivePendingUserInputCustomAnswer,
      promptHistory,
      restoreComposerDraftPromptHistorySavedDraft,
      setPrompt,
      setComposerDraftPromptHistorySavedDraft,
      setComposerDraftTerminalContexts,
      setComposerCommandPicker,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => {
    if (key === "Slash" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      const slashTriggerText =
        trigger && (trigger.kind === "slash-command" || trigger.kind === "slash-model")
          ? snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd)
          : null;

      if (slashTriggerText === "/" && snapshot.expandedCursor === trigger?.rangeEnd) {
        // Pressing `/` again on a lone `/` dismisses the picker. Only wipe the
        // draft when the slash IS the whole prompt; a mid-line slash (e.g. after
        // an existing chip) must keep surrounding content, so let it type through.
        if (trigger.rangeStart === 0 && trigger.rangeEnd === snapshot.value.length) {
          clearComposerSlashDraft();
          return true;
        }
        return false;
      }
      return false;
    }

    const { snapshot, trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive && isLocalFolderBrowserOpen) {
      if (key === "ArrowDown") {
        localDirectoryMenuRef.current?.moveHighlight("down");
        return true;
      }
      if (key === "ArrowUp") {
        localDirectoryMenuRef.current?.moveHighlight("up");
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        localDirectoryMenuRef.current?.activateHighlighted();
        return true;
      }
    }

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (
      shouldHandlePromptHistoryNavigationKey({
        key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        menuIsActive,
        hasActivePendingProgress: Boolean(activePendingProgress),
        isComposerApprovalState,
        pendingUserInputCount: pendingUserInputs.length,
      })
    ) {
      const direction = key === "ArrowUp" ? "older" : "newer";
      const previousNavigationState = promptHistoryNavigationRef.current;
      const result = resolvePromptHistoryNavigation({
        direction,
        history: promptHistory,
        currentPrompt: snapshot.value,
        // Line-boundary math needs raw string offsets; the collapsed cursor
        // undercounts inline token chips (mentions, links, slash commands).
        currentExpandedCursor: snapshot.expandedCursor,
        selectionCollapsed: snapshot.selectionCollapsed,
        state: previousNavigationState,
      });
      if (result.handled) {
        promptHistoryNavigationRef.current = result.state;
        if (result.state === null) {
          restoreComposerDraftPromptHistorySavedDraft(threadId);
        } else if (previousNavigationState === null) {
          setComposerDraftPromptHistorySavedDraft(
            threadId,
            captureComposerPromptHistorySavedDraft({
              threadId,
              draft: composerDraft,
              prompt: result.state.draft,
            }),
          );
        }
        applyingPromptHistoryNavigationRef.current = true;
        expectedPromptHistoryPromptRef.current = result.prompt;
        promptHistoryAppliedPromptRef.current = result.prompt;
        promptRef.current = result.prompt;
        setPrompt(result.prompt);
        setComposerCursor(collapseExpandedComposerCursor(result.prompt, result.expandedCursor));
        // Recalled text replaces the whole prompt; suppress trigger detection
        // so an entry ending in a mention/slash token cannot pop a menu that
        // would capture the next arrow keypress.
        setComposerTrigger(null);
        window.requestAnimationFrame(() => {
          applyingPromptHistoryNavigationRef.current = false;
        });
        return true;
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      if (promptHistoryNavigationRef.current !== null) {
        // Sending commits the recalled text as the prompt; drop the saved
        // draft here (not just in the send path) so it cannot linger and
        // resurrect a stale draft if the send is rejected.
        promptHistoryNavigationRef.current = null;
        setComposerDraftPromptHistorySavedDraft(threadId, null);
      }
      expectedPromptHistoryPromptRef.current = null;
      const dispatchMode =
        (event.metaKey || event.ctrlKey) && hasLiveTurn && !sendInFlightRef.current
          ? "steer"
          : "queue";
      void onSend(undefined, dispatchMode);
      return true;
    }
    return false;
  };
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onScrollToBottom = useCallback(() => {
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    scrollToEnd(true);
  }, [scrollToEnd]);
  const onNavigateToThread = useCallback(
    (nextThreadId: ThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) => parseChatRouteSearch(previous),
      });
    },
    [navigate],
  );
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const dismissActiveThreadError = useCallback(() => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
  }, [activeThread, setThreadError]);
  const dismissActiveProviderHealthBanner = useCallback(() => {
    if (!activeProviderHealthBannerDismissalKey) return;
    setDismissedProviderHealthBannerKeys((current) => {
      if (current.includes(activeProviderHealthBannerDismissalKey)) {
        return current;
      }
      return [activeProviderHealthBannerDismissalKey, ...current].slice(
        0,
        MAX_DISMISSED_PROVIDER_HEALTH_BANNERS,
      );
    });
  }, [activeProviderHealthBannerDismissalKey, setDismissedProviderHealthBannerKeys]);
  const dismissActiveRateLimitBanner = useCallback(() => {
    if (!activeRateLimitBannerDismissalKey) return;
    setDismissedRateLimitBannerKey(activeRateLimitBannerDismissalKey);
  }, [activeRateLimitBannerDismissalKey]);

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col text-[var(--color-text-foreground-secondary)]",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        {!isElectron && (
          <header className={cn(CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, "px-3 py-2 md:hidden")}>
            <div className="flex items-center gap-2">
              <SidebarHeaderTrigger className="size-7 shrink-0" />
              <span className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] font-medium text-[var(--color-text-foreground)]">
                Threads
              </span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "drag-region px-5",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <SidebarHeaderNavigationControls />
            <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/50">
              No active thread
            </span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)]">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const activeThreadDisplayTitle = resolveActiveThreadTitle({
    title: activeThread.title,
    subagentTitle: activeThread.parentThreadId
      ? resolveSubagentPresentationForThread({
          thread: activeThread,
          threads: threadLineageThreads,
        }).fullLabel
      : null,
    isHomeChat: isChatProject,
    isEmpty: timelineEntries.length === 0,
  });

  const runtimeUsageControlsProps = {
    runtimeMode,
    onRuntimeModeChange: handleRuntimeModeChange,
    contextWindow: runtimeUsageContextWindow,
    cumulativeCostUsd: activeCumulativeCostUsd,
    activeContextWindowLabel: contextWindowSelectionStatus.activeLabel,
    pendingContextWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
  };
  // Pencil's narrow variants hide lower-priority actions in place. Controls
  // never relocate into the removed legacy toolbar row below the composer.
  const renderComposerLeadingControls = (options: { iconOnly: boolean }) => (
    <>
      <span className="inline-flex shrink-0" data-pencil-action="attach">
        <ComposerExtrasMenu
          supportsFastMode={composerTraitSelection.caps.supportsFastMode}
          fastModeEnabled={composerTraitSelection.fastModeEnabled}
          onAddPhotos={addComposerImages}
          onToggleFastMode={toggleFastMode}
        />
      </span>
      {!isVoiceRecording && !isVoiceTranscribing ? (
        <span className="inline-flex shrink-0 @max-[390px]:hidden" data-pencil-action="access">
          <RuntimeUsageControls
            {...runtimeUsageControlsProps}
            className="shrink-0"
            hideLabel={options.iconOnly}
          />
        </span>
      ) : null}
    </>
  );
  const idleComposerVoiceControl =
    showVoiceNotesControl &&
    pendingUserInputs.length === 0 &&
    !isVoiceRecording &&
    !isVoiceTranscribing ? (
      <span className="inline-flex shrink-0 @max-[280px]:hidden" data-pencil-action="voice">
        <ComposerVoiceButton
          disabled={isComposerApprovalState || isConnecting || isSendBusy}
          isRecording={isVoiceRecording}
          isTranscribing={isVoiceTranscribing}
          durationLabel={voiceRecordingDurationLabel}
          onClick={toggleComposerVoiceRecording}
        />
      </span>
    ) : null;
  const showEmptyLandingProjectPicker =
    isCenteredEmptyLanding && isLocalDraftThread && activeProject?.kind === "project";
  const emptyLandingProjectChip =
    !isEmptyChatLanding && !showEmptyLandingProjectPicker && activeProjectDisplayName ? (
      <span className="inline-flex h-[26px] min-w-0 shrink items-center gap-[7px] overflow-hidden rounded-full px-1.5 text-[length:var(--app-font-size-ui,12px)] font-medium text-[var(--color-text-foreground)]">
        <FolderClosed className="size-[15px] shrink-0" />
        <span className="min-w-0 truncate">{activeProjectDisplayName}</span>
      </span>
    ) : null;
  const showEmptyLandingControls =
    isCenteredEmptyLanding &&
    isLocalDraftThread &&
    (isEmptyChatLanding || showEmptyLandingProjectPicker || emptyLandingProjectChip !== null);
  const emptyLandingControls = showEmptyLandingControls ? (
    <DraftFolderBar
      folderPicker={
        isEmptyChatLanding ? (
          <ProjectPicker
            align="start"
            side="top"
            recentProjectId={activeProject!.id}
            recentSpaceId={isHomeChatContainer ? selectedSpaceId : null}
            selectedWorkspaceRoot={resolvedThreadWorkingDirectory}
            onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
            onResetToHome={handleResetWorkspaceToHome}
            variant="draft-bar"
          />
        ) : showEmptyLandingProjectPicker ? (
          <ProjectPicker
            align="start"
            side="top"
            recentProjectId={activeProject.id}
            recentSpaceId={null}
            selectedWorkspaceRoot={resolvedThreadWorkingDirectory}
            onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
            onResetToHome={handleResetWorkspaceToHome}
            variant="draft-bar"
          />
        ) : (
          emptyLandingProjectChip
        )
      }
    />
  ) : null;

  const showComposerWorkflowRunCard = workflowRunState !== null;
  const showComposerSubagentStrip = composerSubagentStripItems.length > 0;

  const composerSection =
    secondaryChromeReady && shouldRenderChatPaneContent ? (
      <div
        className={cn(isCenteredEmptyLanding ? "w-full overflow-visible" : "contents")}
        data-empty-landing-composer-block={isCenteredEmptyLanding ? "true" : undefined}
      >
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 w-full overflow-visible"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
        >
          <ComposerColumnFrame>
            {/* A bare wrapper keeps the normal-flow panels' -mb-px seam onto the input shell
                via margin collapse. */}
            <div>
              {workflowRunState ? (
                <WorkflowRunCard
                  workflowRun={workflowRunState}
                  nowMs={workflowNowMs}
                  compact={workflowRunCardCompact}
                  onCompactChange={setWorkflowRunCardCompact}
                  onOpenThread={onNavigateToThread}
                  onStop={onStopWorkflowRun}
                  onPause={onPauseWorkflowRun}
                  onResume={onResumeWorkflowRun}
                  onDismiss={onDismissWorkflowRun}
                  attachedToPrevious={false}
                />
              ) : null}
              {showComposerSubagentStrip ? (
                <ComposerSubagentStrip
                  items={composerSubagentStripItems}
                  compact={subagentStripCompact}
                  onCompactChange={setSubagentStripCompact}
                  onOpenThread={onNavigateToThread}
                  onBackgroundItem={onBackgroundSubagentStripItem}
                  onStopItem={onStopSubagentStripItem}
                  onStopAll={onStopAllSubagentStripItems}
                  attachedToPrevious={showComposerWorkflowRunCard}
                />
              ) : null}
              <ComposerQueuedHeader
                queuedTurns={visibleQueuedComposerTurns}
                onSteer={onSteerQueuedComposerTurn}
                onRemove={removeQueuedComposerTurn}
                onEdit={onEditQueuedComposerTurn}
                cwd={threadWorkspaceCwd ?? undefined}
                attachedToPrevious={showComposerWorkflowRunCard || showComposerSubagentStrip}
              />
              {/* Pending approvals and AskUserQuestion prompts both render as a detached
                  card floating just above the composer (padding gives the measured gap),
                  instead of a banner fused into the composer surface. An approval takes
                  precedence and suppresses the question card while one is active. */}
              {activePendingApproval ? (
                <div className="pb-2">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                    isResponding={respondingRequestKeys.includes(
                      pendingRequestInstanceKey(
                        activePendingApproval.requestId,
                        activePendingApproval.lifecycleGeneration,
                      ),
                    )}
                    onRespond={onRespondToApproval}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="pb-2">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    isResponding={activePendingIsResponding}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onToggleActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onPrevious={onPreviousActivePendingUserInputQuestion}
                    onCancel={onCancelActivePendingUserInput}
                  />
                </div>
              ) : null}
            </div>
            <ComposerDefault
              layoutMode="application"
              draftBar={emptyLandingControls}
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerMenuOpen && !isComposerApprovalState && "overflow-visible",
              )}
              surfaceClassName={cn(
                composerProviderState.composerSurfaceClassName,
                composerMenuOpen && !isComposerApprovalState
                  ? "overflow-visible"
                  : "overflow-hidden",
              )}
            >
              <div
                className={cn(
                  COMPOSER_EDITOR_PADDING_CLASS_NAME,
                  composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                {composerMenuOpen && !isComposerApprovalState ? (
                  <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                    {isLocalFolderBrowserOpen ? (
                      <ComposerLocalDirectoryMenu
                        mentionQuery={mentionTriggerQuery}
                        rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                        homeDir={serverConfigQuery.data?.homeDir ?? null}
                        onSelectEntry={(absolutePath) =>
                          handleSelectLocalDirectoryMention(absolutePath)
                        }
                        onNavigateFolder={handleNavigateLocalFolder}
                        handleRef={localDirectoryMenuRef}
                      />
                    ) : (
                      <ComposerCommandMenu
                        items={composerMenuItems}
                        resolvedTheme={resolvedTheme}
                        isLoading={isComposerMenuLoading}
                        triggerKind={
                          composerCommandPicker !== null
                            ? "slash-command"
                            : effectiveComposerTriggerKind
                        }
                        activeItemId={activeComposerMenuItem?.id ?? null}
                        onHighlightedItemChange={onComposerMenuItemHighlighted}
                        onSelect={onSelectComposerItem}
                      />
                    )}
                  </div>
                ) : null}
                {!isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  (composerAssistantSelections.length > 0 ||
                    composerFileComments.length > 0 ||
                    composerPastedTexts.length > 0 ||
                    composerFiles.length > 0 ||
                    composerImages.length > 0) && (
                    <ComposerReferenceAttachments
                      assistantSelections={composerAssistantSelections}
                      fileComments={composerFileComments}
                      pastedTexts={composerPastedTexts}
                      files={composerFiles}
                      images={composerImages}
                      nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                      onExpandImage={setExpandedImage}
                      onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                      onRemoveFileComments={clearComposerFileCommentsFromDraft}
                      onRemovePastedText={removeComposerPastedTextFromDraft}
                      onShowPastedTextInField={showComposerPastedTextInField}
                      onRemoveFile={removeComposerFile}
                      onRemoveImage={removeComposerImage}
                    />
                  )}
                <ComposerPromptEditor
                  ref={composerEditorRef}
                  value={
                    isComposerApprovalState
                      ? ""
                      : activePendingProgress
                        ? activePendingProgress.customAnswer
                        : prompt
                  }
                  cursor={composerCursor}
                  terminalContexts={
                    !isComposerApprovalState && pendingUserInputs.length === 0
                      ? composerTerminalContexts
                      : []
                  }
                  mentionReferences={selectedComposerMentions}
                  onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                  onChange={onPromptChange}
                  onCommandKeyDown={onComposerCommandKey}
                  onPaste={onComposerPaste}
                  {...(canCollapsePastedTextToDraft
                    ? { onCollapsePastedText: addPastedTextToDraft }
                    : {})}
                  placeholder={
                    isComposerApprovalState
                      ? "Resolve this approval request to continue"
                      : activePendingProgress
                        ? activePendingProgress.activeQuestion?.options.length === 0
                          ? "Type your answer to continue"
                          : "Type your own answer, or leave this blank to use the selected option"
                        : activeThread?.parentThreadId
                          ? "Message this subagent while it works"
                          : hasLiveTurn
                            ? "Ask for follow-up changes"
                            : "Do something"
                  }
                  disabled={isComposerEditorDisabled}
                />
              </div>
              {/* Bottom toolbar — hidden while an approval takes over the composer,
                    since the approve/decline actions live in the detached approval card
                    floating above (see ComposerPendingApprovalPanel). */}
              {activePendingApproval ? null : (
                <div
                  data-chat-composer-footer="true"
                  className={cn("@container", COMPOSER_FOOTER_ROW_CLASS_NAME)}
                >
                  <ComposerFooterActions
                    applicationLeading={renderComposerLeadingControls({
                      iconOnly: false,
                    })}
                    applicationTrailingExpands={isVoiceRecording || isVoiceTranscribing}
                    applicationTrailing={
                      <>
                        {!isVoiceRecording && !isVoiceTranscribing ? composerPickerControls : null}
                        {!isVoiceRecording && !isVoiceTranscribing ? (
                          <span
                            className="inline-flex shrink-0 @max-[280px]:hidden"
                            data-pencil-action="mode"
                          >
                            <ComposerQuickSettings
                              onSelect={() => handleComposerModelEffortPickerOpenChange(true)}
                            />
                          </span>
                        ) : null}
                        {showVoiceNotesControl && (isVoiceRecording || isVoiceTranscribing) ? (
                          <VoiceRecorderShared
                            disabled={isComposerApprovalState || isConnecting || isSendBusy}
                            isTranscribing={isVoiceTranscribing}
                            durationLabel={voiceRecordingDurationLabel}
                            waveformLevels={voiceWaveformLevels}
                            onCancel={() => {
                              if (isVoiceRecording) {
                                void submitComposerVoiceRecording();
                                return;
                              }
                              cancelComposerVoiceRecording();
                            }}
                            onSubmit={() => {
                              void submitComposerVoiceRecording();
                            }}
                          />
                        ) : null}
                        {activePendingProgress ? (
                          <Button
                            type="submit"
                            size="sm"
                            className="rounded-full px-4"
                            disabled={
                              activePendingIsResponding ||
                              (activePendingProgress.isLastQuestion
                                ? !activePendingResolvedAnswers
                                : !activePendingProgress.canAdvance)
                            }
                          >
                            {activePendingIsResponding
                              ? "Submitting..."
                              : activePendingProgress.isLastQuestion
                                ? "Submit answers"
                                : "Next question"}
                          </Button>
                        ) : hasControllableTurn ? (
                          <>
                            {idleComposerVoiceControl}
                            <ButtonSend
                              type="button"
                              visualState="stop"
                              onClick={() => void onInterrupt()}
                              aria-label="Stop generation"
                              title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                            />
                          </>
                        ) : pendingUserInputs.length === 0 &&
                          !isVoiceRecording &&
                          !isVoiceTranscribing ? (
                          <>
                            {idleComposerVoiceControl}
                            <ButtonSend
                              type="submit"
                              disabled={
                                isSendBusy ||
                                isConnecting ||
                                isVoiceTranscribing ||
                                !composerSendState.hasSendableContent
                              }
                              aria-label={
                                isConnecting
                                  ? "Connecting"
                                  : isVoiceTranscribing
                                    ? "Transcribing voice note"
                                    : isSendBusy
                                      ? "Sending"
                                      : "Send message"
                              }
                            />
                          </>
                        ) : null}
                      </>
                    }
                  />
                </div>
              )}
            </ComposerDefault>
          </ComposerColumnFrame>
        </form>
      </div>
    ) : (
      <div
        aria-hidden="true"
        className="w-full overflow-visible"
        data-chat-composer-form="deferred"
      >
        <div
          className={cn(
            COMPOSER_INPUT_SURFACE_CLASS_NAME,
            COMPOSER_COLUMN_FRAME_CLASS_NAME,
            "min-h-[100px] shadow-none",
          )}
          style={{ height: secondaryChromePlaceholderHeight }}
        />
      </div>
    );

  return (
    <ThreadScreen3Rails
      layoutMode="application"
      className={cn(CHAT_BACKGROUND_CLASS_NAME)}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* Subtle accent tint over the whole pane while a file is dragged anywhere over it,
          signalling that dropping it will attach the file to the composer. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-50 transition-opacity duration-150",
          "bg-info/8 ring-1 ring-inset ring-info/30",
          isDragOverComposer ? "opacity-100" : "opacity-0",
        )}
      />
      {/* Top bar */}
      <TopBarThreadAdapter
        className={cn(
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          "flex items-center",
          isElectron && "drag-region",
          // The editor-rail chat header sits in the editor's second row (inside the
          // right-side chat pane), not flush against the window edges — the editor's
          // own top bar already reserves both desktop window-control gutters. Applying
          // them here just leaves redundant empty space on the sides.
          desktopTopBarTrafficLightGutterClassName,
          desktopTopBarWindowControlsGutterClassName,
        )}
        harness={activeThread.session?.provider ?? activeThread.modelSelection.provider}
        leftRailCollapsed={!leftRailOpen}
        onRestoreLeftRail={() => setLeftRailOpen(true)}
        pinned={activeThread.isPinned ?? false}
        title={activeThreadDisplayTitle}
      />

      {/* Error banner */}
      <ProviderHealthBanner
        status={shouldShowProviderHealthBanner ? visibleActiveProviderStatus : null}
        onDismiss={dismissActiveProviderHealthBanner}
      />
      <ThreadErrorBanner error={activeThread.error} onDismiss={dismissActiveThreadError} />
      <RateLimitBanner
        rateLimitStatus={visibleActiveRateLimitStatus}
        onDismiss={dismissActiveRateLimitBanner}
      />
      {/* Main content area with optional plan sidebar */}
      <ThreadShell>
        {/* Chat column */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {shouldRenderChatPaneContent && isCenteredEmptyLanding ? (
              <ThreadScreenEmpty className={CHAT_COLUMN_GUTTER_CLASS_NAME}>
                <div
                  className={cn(
                    "@container flex flex-col items-center gap-[18px] text-center select-none",
                    CHAT_COLUMN_FRAME_CLASS_NAME,
                  )}
                  data-pencil-node="eofeR"
                >
                  <PenkraMark aria-label="Penkra logo" className="size-8" />
                  <FolderPromptShared folderName={emptyLandingParentName} />
                  <div aria-hidden="true" className="h-[22px] w-full shrink-0" />
                  <div className="w-full">{composerSection}</div>
                </div>
              </ThreadScreenEmpty>
            ) : null}

            {shouldRenderChatPaneContent && !isCenteredEmptyLanding ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatTranscriptPane
                    activeThreadId={activeThread.id}
                    activeTurnId={activeThread.session?.activeTurnId ?? null}
                    agentActivityDetail={openAgentActivityDetail}
                    hasMessages={timelineEntries.length > 0}
                    isWorking={showThinking}
                    activeTurnInProgress={activeTurnInProgress}
                    activeTurnStartedAt={activeWorkStartedAt}
                    listRef={transcriptListRef}
                    pinnedMessageIds={pinnedMessageIds}
                    canPinMessage={CAN_PIN_ANY_MESSAGE}
                    onTogglePinMessage={handleTogglePinMessageGuarded}
                    threadMarkers={threadMarkers}
                    enteringUserMessageIds={enteringUserMessageIds}
                    crossTaskOrigin={crossTaskOrigin}
                    timelineEntries={timelineEntries}
                    turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                    onOpenThread={onNavigateToThread}
                    subagentToolTraceByThreadId={subagentToolTraceByThreadId}
                    revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                    onRevertUserMessage={onRevertUserMessage}
                    onUndoTurnFiles={onUndoTurnFiles}
                    onEditUserMessage={onEditUserMessage}
                    isRevertingCheckpoint={isRevertingCheckpoint}
                    onExpandTimelineImage={onExpandTimelineImage}
                    followLiveOutput={hasStreamingAssistantText}
                    onIsAtEndChange={onIsAtEndChange}
                    markdownCwd={threadWorkspaceCwd ?? undefined}
                    resolvedTheme={resolvedTheme}
                    chatFontSizePx={settings.chatFontSizePx}
                    timestampFormat={timestampFormat}
                    workspaceRoot={threadWorkspaceCwd ?? undefined}
                    emptyStateProjectName={activeProjectDisplayName}
                    onMessagesScroll={onMessagesScroll}
                    onMessagesClickCapture={onMessagesClickCapture}
                    onMessagesMouseUp={onMessagesMouseUp}
                    onMessagesWheel={onMessagesWheel}
                    onMessagesPointerDown={onMessagesPointerDown}
                    onMessagesPointerUp={onMessagesPointerUp}
                    onMessagesPointerCancel={onMessagesPointerCancel}
                    onMessagesTouchStart={onMessagesTouchStart}
                    onMessagesTouchMove={onMessagesTouchMove}
                    onMessagesTouchEnd={onMessagesTouchEnd}
                    onOpenAgentActivity={setOpenAgentActivityId}
                    onCloseAgentActivityDetail={closeAgentActivityDetail}
                    scrollButtonVisible={showScrollToBottom}
                    onScrollToBottom={onScrollToBottom}
                  />
                </div>

                <div
                  className={cn(
                    "relative z-10 -mt-5 w-full shrink-0 overflow-visible pt-0 sm:pt-0",
                    CHAT_COLUMN_GUTTER_CLASS_NAME,
                    "pb-3 sm:pb-4",
                  )}
                >
                  {composerSection}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {/* end chat column */}
      </ThreadShell>
      {/* end horizontal flex container */}

      <ComposerSlashStatusDialog
        open={isSlashStatusDialogOpen}
        onOpenChange={setIsSlashStatusDialogOpen}
        selectedModel={selectedModel}
        fastModeEnabled={fastModeEnabled}
        selectedPromptEffort={selectedPromptEffort}
        contextWindow={activeContextWindow}
        cumulativeCostUsd={activeCumulativeCostUsd}
        rateLimitStatus={activeRateLimitStatus}
        activeContextWindowLabel={contextWindowSelectionStatus.activeLabel}
        pendingContextWindowLabel={contextWindowSelectionStatus.pendingSelectedLabel}
      />
      {isInactiveSplitPane ? null : (
        <TranscriptSelectionActionLayer
          action={pendingTranscriptSelectionAction}
          onHighlight={createHighlightFromPendingSelection}
          onUnderline={createUnderlineFromPendingSelection}
          onAddToChat={commitTranscriptAssistantSelection}
        />
      )}
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </ThreadScreen3Rails>
  );
}
