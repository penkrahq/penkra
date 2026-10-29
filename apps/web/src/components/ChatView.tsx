import { Schema } from "effect";
import { KEYBINDINGS } from "@penkra/shared/keybindings";
import { loadThread, useThreadList, getThreadListById, useThreadSummary } from "../threadListStore";
import { useThreadStop } from "../hooks/useThreadStop";
import { useProviderCatalog } from "../hooks/useProviderCatalog";
import { useAttachmentPreviewHandoffs } from "../hooks/useAttachmentPreviewHandoffs";
import {
  CleanCoreQueuedMessage,
  CleanCoreSavedPrompt,
  SavedRestoreDraftNotEmptyError,
  SAVED_PROMPT_RESTORE_NONEMPTY_DRAFT_ERROR,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
  QueuedEditDraftNotEmptyError,
  type CleanCoreThreadSummary,
  type CleanCoreThreadItem,
  type CleanCoreUserSendMessageInput,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  type ModelSelection,
  type ModelSlug,
  type ProviderKind,
  type ProviderConnectionId,
  type ProjectEntry,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  type CleanCoreAnswerThreadQuestionInput,
  type ServerProviderStatus,
  ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  RuntimeMode,
} from "@penkra/contracts";
import { getModelCapabilities, normalizeModelSlug } from "@penkra/shared/model";
import { threadExportBlockedReason } from "@penkra/shared/threadExport";
import { pendingRequestInstanceKey } from "@penkra/shared/threadSummary";
import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
} from "@penkra/shared/chatThreads";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import {
  providerComposerCapabilitiesQueryOptions,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { providerConnectionsQueryOptions } from "~/lib/providerConnectionsReactQuery";
import {
  pruneUnavailableComposerConnectionSelections,
  resolveAnonymousModelDiscoveryRoute,
  resolveComposerConnectionAtAdmission,
} from "~/lib/providerConnectionCapabilities";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { saveDefaultConnection } from "~/lib/connectionDefaults";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import {
  isThreadReadAcknowledgementDeferred,
  releaseThreadReadAcknowledgement,
} from "../threadReadAcknowledgement";
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
import {
  markChatScrollWrite,
  nextChatScrollDiagnosticInstanceId,
  recordChatScrollDiagnostic,
} from "../chatScrollDiagnostics";
import {
  recordChatComposerContinueDiagnostic,
  recordChatLifecycleDiagnostic,
  recordChatLifecycleUiDiagnostic,
} from "../chatLifecycleDiagnostics";
import { useThreadResourceOpener } from "../lib/threadResourceOpener";
import { useSpacesUiStore } from "../spacesUiStore";
import { registerDesktopThreadLiveHandlers } from "../desktopThreadApiBroker";
import {
  buildComposerFileAttachmentsFromFiles,
  buildComposerImageAttachmentsFromFiles,
  stageUploadComposerAttachments,
  effectiveComposerAttachmentCount,
  findPendingBlobComposerAttachments,
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
} from "../lib/composerSend";
import { persistComposerAsset } from "../lib/composerAssetStore";
import { splitComposerDropzoneFiles, useComposerDropzone } from "../hooks/useComposerDropzone";
import {
  buildTranscriptAutoFollowSignal,
  derivePromptHistoryFromMessages,
  promptStillMatchesActiveHistoryBrowse,
  type PromptHistoryNavigationState,
  resolveActiveThreadTitle,
  resolveCommittedProviderModel,
  resolveCycledModelSlug,
  resolvePromptHistoryNavigation,
  shouldShowComposerContinue,
  shouldRenderTranscriptDuringHydration,
  shouldHandlePromptHistoryNavigationKey,
  shouldEnableComposerPastedTextCollapse,
  shouldConsumePendingCustomBinaryConfirmation,
} from "./ChatView.logic";
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
import { hasUnseenThreadCompletion } from "../threadCompletion";
import {
  canOfferReviewSlashCommand,
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
} from "../composerSlashCommands";
import {
  derivePhase,
  deriveActiveWorkStartedAt,
  deriveVisibleWorkLogSequenceFloor,
  deriveWorkLogEntries,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  isSessionActiveLatestTurn,
  PROVIDER_OPTIONS,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {} from "../rightDockStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { DEFAULT_RUNTIME_MODE, type ChatMessage, type Thread } from "../types";
import { useTheme } from "../hooks/useTheme";
import {
  buildSearchableModelOptions,
  useComposerCommandMenuItems,
} from "../hooks/useComposerCommandMenuItems";
import { invalidateProviderData } from "../lib/providerDataRefresh";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { PenkraMark } from "./foundations/penkra-mark-shared/PenkraMark";
import {
  formatShortcutLabel,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import { Button } from "./ui/button";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import { newCommandId, newMessageId } from "~/lib/utils";
import { readNativeApi, ensureNativeApi } from "~/nativeApi";
import { applyThreadCreationResponse, promoteThreadCreate } from "~/lib/threadCreatePromotion";
import {} from "~/lib/threadBootstrap";
import { readFavoriteModelSlugs } from "~/lib/modelFavorites";
import {
  getCustomBinaryPathForProvider,
  getProviderStartOptions,
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "../appSettings";
import { toAttachmentPreviewUrl } from "../lib/wsHttpUrl";
import {} from "../lib/editableEventTarget";
import { useComposerDraftSync } from "../composerDraftSync";
import { selectComposerThreadDraft } from "../composerDraftDomain";
import { useThreadItems } from "../useThreadItems";
import { mergeBySeq } from "../threadItemsStore";
import {
  threadItemsToTimelineEntries,
  threadItemToChatMessage,
  isVisibleThreadMessageItem,
  threadItemToActivity,
  threadItemsToPendingUserInputs,
} from "./chat/threadItemMappers";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerAssistantSelectionAttachment,
  type PersistedComposerImageAttachment,
  type ComposerSubmission,
  captureComposerPromptHistorySavedDraft,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../composerDraftStore";

import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import { useWorkflowRunUiStore, useWorkflowRunUiThreadState } from "../workflowRunUiStore";
import { appendComposerPromptText } from "../lib/chatReferences";
import {
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
  formatAssistantSelectionTitleSeed,
} from "../lib/assistantSelections";
import {
  appendFileCommentsToPrompt,
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
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
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
import { ChatPerformanceBoundary, measureChatPerformanceWork } from "~/chatPerformanceDiagnostics";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import { ThreadDetailHydrationState } from "./chat/ThreadDetailHydrationState";
import { ComposerDefault } from "./middle-panel/composer-default/ComposerDefault";
import { ThreadScreen3Rails } from "./middle-panel/thread-screen-3-rails/ThreadScreen3Rails";
import { ThreadScreenEmpty } from "./middle-panel/thread-screen-empty/ThreadScreenEmpty";
import { ThreadShell } from "./middle-panel/thread-shell/ThreadShell";
import { FolderTabs } from "./middle-panel/folder-tabs/FolderTabs";
import type { TranscriptVirtualListRef } from "./chat/TranscriptVirtualList";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  ProviderModelPicker,
  resolveProviderModelLabel,
} from "./chat/ProviderModelPicker";
import { ComposerModelEffortPicker } from "./chat/ComposerModelEffortPicker";
import { ComposerConnectionControl } from "./chat/ComposerConnectionControl";
import { resolveTraitsTriggerSummary, TraitsPicker } from "./chat/TraitsPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";

import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { ComposerSavedPrompts } from "./chat/ComposerSavedPrompts";
import { ComposerPendingUserInputPanel } from "./middle-panel/composer-user-question/ComposerPendingUserInputPanel";
import { ButtonSend } from "./middle-panel/button-send/ButtonSend";
import { ComposerActions } from "./middle-panel/composer-actions/ComposerActions";
import { ComposerActionsEmptyThread } from "./middle-panel/composer-actions-empty-thread/ComposerActionsEmptyThread";
import { EffortSelectorEmptyThread } from "./middle-panel/effort-selector-empty-thread/EffortSelectorEmptyThread";
import { FolderPromptShared } from "./middle-panel/folder-prompt-shared/FolderPromptShared";
import { ModelSelectorEmptyThread } from "./middle-panel/model-selector-empty-thread/ModelSelectorEmptyThread";
import { ComposerVoiceButton } from "./chat/ComposerVoiceButton";
import { VoiceRecorderShared } from "./middle-panel/voice-recorder-shared/VoiceRecorderShared";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ExpandedImageOverlay } from "./chat/ExpandedImageOverlay";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { WorkflowRunCard } from "./chat/WorkflowRunCard";
import {
  buildWorkflowResumePrompt,
  deriveWorkflowRunState,
  type WorkflowSubagentThreadRef,
} from "./chat/WorkflowRunCard.logic";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
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
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import {
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  deriveComposerSendState,
  revokeBlobPreviewUrl,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useFeatureFlags } from "../featureFlags";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { buildModelSelection } from "../providerModelOptions";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];

function failChatOperation(message: string): never {
  throw new Error(message);
}

const COMPOSER_INPUT_BURST_IDLE_MS = 50;

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
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
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

function formatPastedTextTitleSeed(pastedTexts: ReadonlyArray<PastedTextDraft>): string | null {
  const firstPastedText = pastedTexts[0];
  if (!firstPastedText) {
    return null;
  }
  return pastedTexts.length === 1
    ? pastedTextTitle(firstPastedText.text)
    : `${pastedTexts.length} pasted texts`;
}

// Coalesce mention-path input to keep filesystem discovery from running per keystroke.
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
}

interface LateComposerSendHandlers {
  readonly advanceActivePendingUserInput: (
    answerOverrides?: Record<string, PendingUserInputDraftAnswer>,
  ) => boolean;
  readonly handleStandaloneSlashCommand: (trimmedPrompt: string) => Promise<boolean>;
}

export default function ChatView(props: ChatViewProps) {
  const row = useThreadSummary(props.threadId);
  const localDraft = useComposerDraftStore((state) => state.draftThreadsByThreadId[props.threadId]);
  const hasServerThread = useStore(
    (state) => state.threadShellById?.[props.threadId] !== undefined,
  );
  const awaitingCreationResponse = localDraft !== undefined && !hasServerThread;
  const [rowReadState, setRowReadState] = useState<{
    state: "loading" | "failed" | "missing";
    error?: unknown;
  }>({ state: "loading" });
  const shellReads = useRef(new Map<ThreadId, Promise<void>>());
  const readRow = useCallback(() => {
    setRowReadState({ state: "loading" });
    void loadThread(props.threadId)
      .then((loaded) => {
        if (loaded === null) setRowReadState({ state: "missing" });
      })
      .catch((error: unknown) => {
        console.error(
          `Thread row read failed thread=${props.threadId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        setRowReadState({ state: "failed", error });
      });
  }, [props.threadId]);
  useEffect(() => {
    if (hasServerThread && row === null) readRow();
  }, [props.threadId, hasServerThread, row === null, readRow]);
  const readShell = useCallback(() => {
    setRowReadState({ state: "loading" });
    let request = shellReads.current.get(props.threadId);
    if (request === undefined) {
      request = ensureNativeApi()
        .cleanCore.getThreadShell({ threadId: props.threadId })
        .then((shell) => {
          if (shell === null) {
            setRowReadState({ state: "missing" });
            return;
          }
          useStore.getState().syncServerThreadShell(props.threadId, shell);
        });
      shellReads.current.set(props.threadId, request);
    }
    void request.catch((error: unknown) => {
      shellReads.current.delete(props.threadId);
      console.error(
        `Thread shell read failed thread=${props.threadId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      setRowReadState({ state: "failed", error });
      toastManager.add({
        type: "error",
        title: "Could not load thread",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [props.threadId]);
  useEffect(() => {
    if (row !== null && !hasServerThread && !awaitingCreationResponse) readShell();
  }, [props.threadId, row !== null, hasServerThread, awaitingCreationResponse, readShell]);
  if (
    (hasServerThread && row === null) ||
    (row !== null && !hasServerThread && !awaitingCreationResponse)
  )
    return (
      <div data-p29-thread-hydration className="flex min-h-0 flex-1 items-center justify-center">
        <ThreadDetailHydrationState
          state={rowReadState.state}
          error={rowReadState.error}
          onRetry={row === null ? readRow : readShell}
        />
      </div>
    );
  return (
    <ChatViewContent
      {...props}
      context={
        row === null || awaitingCreationResponse ? { kind: "draft" } : { kind: "persisted", row }
      }
    />
  );
}

type ChatViewThreadContext = { kind: "draft" } | { kind: "persisted"; row: CleanCoreThreadSummary };

function ChatViewContent({
  threadId,
  paneScopeId: paneScopeIdProp,
  context,
}: ChatViewProps & { context: ChatViewThreadContext }) {
  const canonicalThread = context.kind === "persisted" ? context.row : null;
  const canonicalRows = useThreadList();
  // Keep defaults out of the parameter list. Assignment-pattern parameters make
  // React Compiler skip this component, which turns every composer keystroke
  // into a full long-thread render.
  const paneScopeId = paneScopeIdProp ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const setStoreThreadError = useStore((store) => store.setError);
  const { settings, serverSettings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { open: leftRailOpen, setOpen: setLeftRailOpen } = useSidebar();
  const setComposerDraftModelSelectionAndSticky = useComposerDraftStore(
    (store) => store.setModelSelectionAndSticky,
  );
  const stickyConnectionByProvider = useComposerDraftStore(
    (store) => store.stickyConnectionByProvider,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const threadResourceOpener = useThreadResourceOpener();
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
  const [admittingThreadIds, setAdmittingThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const admittingThreadsRef = useRef(new Set<string>());
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const durablyPersistedComposerImageIds = composerDraft.persistedAttachments;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  // Keep the one per-thread composer draft on the clean core (0.14.4 design 2.6).
  const applyServerThreadDraft = useComposerDraftStore((store) => store.applyServerThreadDraft);
  const {
    refresh: refreshCommittedDraft,
    draftUpdatedAt: readDraftUpdatedAt,
    flush: flushCommittedDraft,
  } = useComposerDraftSync({
    threadId: canonicalThread === null ? null : threadId,
    draft: composerDraft,
    applyServerDraft: applyServerThreadDraft,
  });
  const setComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.setPromptHistorySavedDraft,
  );
  const restoreComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.restorePromptHistorySavedDraft,
  );
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
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
  const getDraftThreadByFolderId = useComposerDraftStore((store) => store.getDraftThreadByFolderId);
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
  const serverThreadShell = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const transcriptListRef = useRef<TranscriptVirtualListRef | null>(null);
  const preservePageAnchor = useCallback((turnId: string | null) => {
    transcriptListRef.current?.preserveAnchorBelowBoundary(
      turnId === null ? "outline-boundary" : `turn-boundary:${turnId}`,
    );
  }, []);
  const {
    state: threadItemsState,
    loadOlder: loadOlderItems,
    loadOlderTurn,
    setExpandedTurns,
    reload: retryThreadDetailHydration,
    error: threadItemsError,
  } = useThreadItems(
    canonicalRows.some((row) => row.id === threadId) ? threadId : null,
    preservePageAnchor,
  );
  const [acceptedFirstMessage, setAcceptedFirstMessage] = useState<CleanCoreThreadItem | null>(
    null,
  );
  useEffect(() => {
    if (
      acceptedFirstMessage !== null &&
      (acceptedFirstMessage.threadId !== threadId ||
        threadItemsState.items.some((item) => item.sourceId === acceptedFirstMessage.sourceId))
    )
      setAcceptedFirstMessage(null);
  }, [threadId, threadItemsState.items, acceptedFirstMessage]);
  const threadItems = useMemo(
    () =>
      mergeBySeq(threadItemsState.items, [
        ...Object.values(threadItemsState.turns),
        ...Object.values(threadItemsState.finals),
        ...Object.values(threadItemsState.details).flatMap((detail) => detail.items),
        ...(acceptedFirstMessage?.threadId === threadId &&
        !threadItemsState.items.some((item) => item.sourceId === acceptedFirstMessage.sourceId)
          ? [acceptedFirstMessage]
          : []),
      ]),
    [threadItemsState, acceptedFirstMessage, threadId],
  );
  const serverThread = useMemo(
    () =>
      serverThreadShell === undefined
        ? undefined
        : {
            ...serverThreadShell,
            messages: threadItems.filter(isVisibleThreadMessageItem).map(threadItemToChatMessage),
            activities: threadItems
              .filter(
                (item) => item.kind !== "user" && item.kind !== "text" && item.kind !== "turn",
              )
              .map(threadItemToActivity),
          },
    [serverThreadShell, threadItems],
  );
  const selectMentionSources = useMemo(() => createComposerThreadMentionSourcesSelector(), []);
  const composerThreadSummaries = selectMentionSources(useThreadList());
  const composerThreadFolders = useStore((state) => state.folders);
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
  const fallbackDraftFolderId = draftThread?.folderId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftFolderId), [fallbackDraftFolderId]),
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
  const promptRefThreadId = useRef(threadId);
  useLayoutEffect(() => {
    promptRefThreadId.current = threadId;
  }, [threadId]);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const composerAssistantSelectionsRef = useRef<ComposerAssistantSelectionAttachment[]>(
    composerAssistantSelections,
  );
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const composerFileCommentsRef = useRef<FileCommentDraft[]>(composerFileComments);
  const composerPastedTextsRef = useRef<PastedTextDraft[]>(composerPastedTexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [continueInFlight, setContinueInFlight] = useState<{
    threadId: ThreadId;
    turnId: TurnId;
    requestedAt: string;
    sessionUpdatedAt: string | null;
  } | null>(null);
  const [isLocalConnecting, _setIsLocalConnecting] = useState(false);
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
  const [composerCommandPicker, setComposerCommandPicker] = useState<null | "review-target">(null);
  const [secondaryChromePlaceholderHeight, setSecondaryChromePlaceholderHeight] = useState(88);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
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
  const [pickerThreadId, setPickerThreadId] = useState(threadId);
  if (pickerThreadId !== threadId) {
    setPickerThreadId(threadId);
    setComposerCommandPicker(null);
    setIsModelPickerOpen(false);
    setIsTraitsPickerOpen(false);
  }
  const transcriptControllerDiagnosticInstanceIdRef = useRef<number | null>(null);
  if (transcriptControllerDiagnosticInstanceIdRef.current === null) {
    transcriptControllerDiagnosticInstanceIdRef.current = nextChatScrollDiagnosticInstanceId();
  }
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
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);
  const dragDepthRef = useRef(0);
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

  const pendingPromptPersistenceRef = useRef<{
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly cursor: number;
    readonly expandedCursor: number;
    readonly cursorAdjacentToMention: boolean;
  } | null>(null);
  const promptPersistenceTimeoutRef = useRef<number | null>(null);
  const cancelPendingPromptPersistence = useCallback(() => {
    if (promptPersistenceTimeoutRef.current !== null) {
      window.clearTimeout(promptPersistenceTimeoutRef.current);
      promptPersistenceTimeoutRef.current = null;
    }
    pendingPromptPersistenceRef.current = null;
  }, []);
  const flushPendingPromptPersistence = useCallback(
    (targetThreadId?: ThreadId) => {
      const pending = pendingPromptPersistenceRef.current;
      if (
        pending === null ||
        (targetThreadId !== undefined && pending.threadId !== targetThreadId)
      ) {
        return false;
      }
      if (promptPersistenceTimeoutRef.current !== null) {
        window.clearTimeout(promptPersistenceTimeoutRef.current);
        promptPersistenceTimeoutRef.current = null;
      }
      pendingPromptPersistenceRef.current = null;
      setComposerDraftPrompt(pending.threadId, pending.prompt);
      if (pending.threadId === threadId) {
        setComposerCursor(pending.cursor);
        setComposerTrigger(
          pending.cursorAdjacentToMention
            ? null
            : detectComposerTrigger(pending.prompt, pending.expandedCursor),
        );
      }
      return true;
    },
    [setComposerDraftPrompt, threadId],
  );
  const schedulePromptPersistence = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      pendingPromptPersistenceRef.current = {
        threadId,
        prompt: nextPrompt,
        cursor: nextCursor,
        expandedCursor,
        cursorAdjacentToMention,
      };
      if (promptPersistenceTimeoutRef.current !== null) {
        window.clearTimeout(promptPersistenceTimeoutRef.current);
      }
      // Lexical can report one accessibility, dictation, or type-text insertion
      // as hundreds of character updates. Wait for that input burst to settle
      // before projecting it into controlled React/store state; a paint-time
      // projection can otherwise rewrite Lexical with an intermediate value.
      // promptRef and Lexical remain immediate for send and command handlers.
      promptPersistenceTimeoutRef.current = window.setTimeout(
        flushPendingPromptPersistence,
        COMPOSER_INPUT_BURST_IDLE_MS,
      );
    },
    [flushPendingPromptPersistence, threadId],
  );
  useEffect(() => {
    return () => {
      if (promptPersistenceTimeoutRef.current !== null) {
        window.clearTimeout(promptPersistenceTimeoutRef.current);
        promptPersistenceTimeoutRef.current = null;
      }
      const pending = pendingPromptPersistenceRef.current;
      pendingPromptPersistenceRef.current = null;
      if (pending) {
        setComposerDraftPrompt(pending.threadId, pending.prompt);
      }
    };
  }, [setComposerDraftPrompt]);
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      cancelPendingPromptPersistence();
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [cancelPendingPromptPersistence, setComposerDraftPrompt, threadId],
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
  const runtimeMode =
    composerDraft.runtimeMode ??
    (context.kind === "persisted"
      ? Schema.decodeUnknownSync(RuntimeMode)(context.row.runtimeMode)
      : (parentScopedDraftThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE));
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const threadDetailHydration =
    !isServerThread || threadItemsState.loaded
      ? "ready"
      : threadItemsError !== null
        ? "failed"
        : "loading";
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeSessionTurnId = activeThread?.session?.activeTurnId ?? null;
  const activeSessionTurnStartedAt =
    activeLatestTurn && isSessionActiveLatestTurn(activeLatestTurn, activeThread?.session ?? null)
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
    () =>
      measureChatPerformanceWork("transcript-context", () =>
        deriveLatestContextWindowSnapshot(threadActivities),
      ),
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
  // `latestTurnSettled` is also false when there is no turn at all, so require a
  // durable turn identity. Do not require `startedAt`: the first-turn request is
  // projected as a running latest turn before the provider start timestamp arrives.
  const latestTurnLive = activeLatestTurn !== null && !latestTurnSettled;
  const activeFolderId = activeThread?.folderId ?? draftThread?.folderId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeFolderId), [activeFolderId]),
  );
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const selectedSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const emptyLandingSpaceId =
    activeThread?.spaceId ?? draftThread?.spaceId ?? activeProject?.spaceId ?? selectedSpaceId;
  const emptyLandingSpaceName = useStore(
    (state) => state.spaces.find((space) => space.id === emptyLandingSpaceId)?.name?.trim() || null,
  );
  const isContainerLandingProject = false;
  const activeProjectDisplayName = activeProject?.name;
  const activeFolderName = activeProject?.name.trim() || null;
  const emptyLandingParentName = activeFolderName || emptyLandingSpaceName || "this space";
  const isChatProject = isContainerLandingProject;

  useEffect(() => {
    const viewedThreadId = activeThread?.id;
    return () => {
      if (viewedThreadId) releaseThreadReadAcknowledgement(viewedThreadId);
    };
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (isThreadReadAcknowledgementDeferred(activeThread.id)) return;
    if (
      !hasUnseenThreadCompletion({
        latestTurn: activeLatestTurn,
        lastVisitedAt: canonicalThread?.lastVisitedAt,
      })
    ) {
      return;
    }

    const visitedAt = new Date().toISOString();
    void markThreadVisited(activeThread.id, visitedAt).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to mark thread as read",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [
    activeThread?.id,
    canonicalThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    markThreadVisited,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId =
    composerDraft.activeProvider ?? serverThread?.modelSelection.provider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const providerConnectionsQuery = useQuery(providerConnectionsQueryOptions());
  useEffect(() => {
    if (hasThreadStarted || providerConnectionsQuery.data === undefined) return;
    useComposerDraftStore.setState((state) => {
      const stickyConnectionByProvider = pruneUnavailableComposerConnectionSelections({
        snapshot: providerConnectionsQuery.data!,
        selections: state.stickyConnectionByProvider,
      });
      return stickyConnectionByProvider === state.stickyConnectionByProvider
        ? state
        : { stickyConnectionByProvider };
    });
  }, [hasThreadStarted, providerConnectionsQuery.data]);
  const selectedConnectionByProvider = (() => {
    const defaults = { ...stickyConnectionByProvider };
    if (serverSettings) {
      for (const provider of Object.keys(serverSettings.providers) as ProviderKind[]) {
        const connectionId = serverSettings.providers[provider].defaultConnectionId;
        if (connectionId !== undefined) defaults[provider] = connectionId;
      }
    }
    if (serverThread?.connectionId !== undefined)
      defaults[serverThread.modelSelection.provider] = serverThread.connectionId;
    return { ...defaults, ...composerDraft.connectionSelectionByProvider };
  })();
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
      opencode: resolveHint("opencode"),
    };
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    composerDraft.modelSelectionByProvider,
  ]);
  const discoveryRouteByProvider = useMemo(() => {
    const snapshot = providerConnectionsQuery.data;
    if (snapshot === undefined) return {};
    const result: Partial<
      Record<
        ProviderKind,
        {
          connectionId: ProviderConnectionId | null;
          internalProviderId: string | null;
        }
      >
    > = {};
    for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
      const explicitlySelected = Object.prototype.hasOwnProperty.call(
        selectedConnectionByProvider,
        provider,
      );
      let connectionId: ProviderConnectionId | null | undefined;
      if (explicitlySelected) {
        connectionId = selectedConnectionByProvider[provider];
      } else if (hasThreadStarted) {
        connectionId =
          serverThread?.modelSelection.provider === provider
            ? serverThread.connectionId
            : undefined;
      } else {
        const anonymous = snapshot.anonymousRoutes.find((route) => route.harness === provider);
        connectionId =
          anonymous !== undefined
            ? null
            : snapshot.connections.find(
                (connection) =>
                  connection.harness === provider && connection.lifecycle === "active",
              )?.id;
      }
      if (connectionId === undefined) continue;
      if (connectionId === null) {
        const route = resolveAnonymousModelDiscoveryRoute({
          snapshot,
          provider,
          modelHint: composerModelHintByProvider[provider],
        });
        if (route !== undefined) {
          result[provider] = {
            connectionId: null,
            internalProviderId: route.internalProviderId,
          };
        }
        continue;
      }
      const connection = snapshot.connections.find(
        (candidate) =>
          candidate.id === connectionId &&
          candidate.harness === provider &&
          candidate.lifecycle === "active",
      );
      if (connection === undefined) continue;
      const method = snapshot.authenticationMethods.find(
        (candidate) =>
          candidate.harness === provider &&
          candidate.authenticationTargetId === connection.authenticationTargetId &&
          candidate.authenticationMethodId === connection.authenticationMethodId,
      );
      result[provider] = {
        connectionId,
        internalProviderId: method?.internalProviderIds[0] ?? null,
      };
    }
    return result;
  }, [
    composerModelHintByProvider,
    hasThreadStarted,
    providerConnectionsQuery.data,
    selectedConnectionByProvider,
    serverThread,
  ]);
  const {
    customModelsByProvider,
    modelOptionsByProvider,
    unavailableModelProviders,
    runtimeModelsByProvider,
  } = useProviderModelCatalog({
    selectedProvider,
    discoveryEnabled: isModelPickerOpen,
    modelHintByProvider: composerModelHintByProvider,
    routeByProvider: discoveryRouteByProvider,
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
        const authorized = isManagedHarness
          ? options.filter((option) => discoveredModelSlugs.has(option.slug))
          : options;
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
    return buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch);
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);
  const resolveSelectedConnection = useCallback(
    (provider: ProviderKind, _model: string): ProviderConnectionId | null | undefined =>
      discoveryRouteByProvider[provider]?.connectionId,
    [discoveryRouteByProvider],
  );
  const selectedConnectionId = resolveSelectedConnection(
    selectedProvider,
    selectedModelSelection.model,
  );
  const folderCatalog = useProviderCatalog(
    selectedConnectionId === undefined || activeFolderId === null
      ? null
      : {
          provider: selectedProvider,
          connectionId: selectedConnectionId,
          folderId: activeFolderId,
        },
    ["commands", "skills", "plugins", "agents"],
    composerTrigger !== null || composerCommandPicker !== null,
  );
  const dynamicAgents = useMemo(
    () =>
      (folderCatalog.data?.agents ?? []).filter(
        (agent) =>
          agent.availableConnectionIds === undefined ||
          (selectedConnectionId !== undefined &&
            agent.availableConnectionIds.includes(selectedConnectionId)),
      ),
    [folderCatalog.data?.agents, selectedConnectionId],
  );
  const composerConnectionCandidates = useMemo(() => {
    const snapshot = providerConnectionsQuery.data;
    if (snapshot === undefined) return [];
    return snapshot.connections.filter(
      (connection) => connection.harness === selectedProvider && connection.lifecycle === "active",
    );
  }, [providerConnectionsQuery.data, selectedProvider]);
  const handleConnectionChange = (connectionId: ProviderConnectionId | null) => {
    void invalidateProviderData(queryClient);
    useComposerDraftStore
      .getState()
      .setConnectionSelection(threadId, selectedProvider, connectionId);
    void saveDefaultConnection(selectedProvider, connectionId)
      .then((settings) => queryClient.setQueryData(serverQueryKeys.settings(), settings))
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Could not save default Connection",
          description: String(error),
        }),
      );
    useComposerDraftStore.setState((state) => ({
      stickyConnectionByProvider: {
        ...state.stickyConnectionByProvider,
        [selectedProvider]: connectionId,
      },
    }));
  };
  const handleManageConnections = useCallback(() => {
    void navigate({ to: "/settings", search: { section: "providers" } });
  }, [navigate]);
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
  const workLogVisibleSequenceFloor = useMemo(
    () => deriveVisibleWorkLogSequenceFloor(activeThread?.messages ?? EMPTY_MESSAGES),
    [activeThread?.messages],
  );
  const rawWorkLogEntries = useMemo(
    () =>
      measureChatPerformanceWork("transcript-work-log", () =>
        deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined, {
          visibleTurnIds: workLogVisibleTurnIds,
          ...(workLogVisibleSequenceFloor === undefined
            ? {}
            : { visibleSequenceFloor: workLogVisibleSequenceFloor }),
          activeTurnId: activeSessionTurnId,
          activeTurnStartedAt: activeSessionTurnStartedAt,
          latestTurnState: activeLatestTurn?.state ?? null,
          latestTurnCompletedAt: activeLatestTurn?.completedAt ?? null,
        }),
      ),
    [
      activeLatestTurn,
      activeSessionTurnId,
      activeSessionTurnStartedAt,
      threadActivities,
      workLogVisibleSequenceFloor,
      workLogVisibleTurnIds,
    ],
  );
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const closeAgentActivityDetail = () => {
    setOpenAgentActivityId(null);
  };
  const agentActivityTimelineState = useMemo(
    () =>
      measureChatPerformanceWork("transcript-agent-activity", () =>
        deriveAgentActivityTimelineState(rawWorkLogEntries),
      ),
    [rawWorkLogEntries],
  );
  const [agentActivityThreadId, setAgentActivityThreadId] = useState(activeThread?.id);
  if (agentActivityThreadId !== activeThread?.id) {
    setAgentActivityThreadId(activeThread?.id);
    setOpenAgentActivityId(null);
  } else if (
    openAgentActivityId !== null &&
    !agentActivityTimelineState.detailById.has(openAgentActivityId)
  ) {
    setOpenAgentActivityId(null);
  }
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  const pendingUserInputs = useMemo(
    () =>
      measureChatPerformanceWork("transcript-pending-interactions", () =>
        threadItemsToPendingUserInputs(threadItems),
      ),
    [threadItems],
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
  // Links workflow agent rows to their subagent child threads (and models) when the
  // Task tool_use_id produced one; agents spawned without a tool call stay unlinked.
  const workflowSubagentThreadsByToolUseId = useMemo(() => {
    const refs = new Map<string, WorkflowSubagentThreadRef>();
    for (const entry of rawWorkLogEntries) {
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
  }, [rawWorkLogEntries]);
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
      measureChatPerformanceWork("transcript-workflow", () =>
        deriveWorkflowRunState({
          activities: threadActivities,
          subagentThreadsByToolUseId: workflowSubagentThreadsByToolUseId,
          pausedByUserTaskIds: pausedWorkflowTaskIds,
          dismissedTaskIds: dismissedWorkflowTaskIds,
        }),
      ),
    [
      threadActivities,
      workflowSubagentThreadsByToolUseId,
      pausedWorkflowTaskIds,
      dismissedWorkflowTaskIds,
    ],
  );
  const workflowNowMs = useNowMs(workflowRunState !== null && !workflowRunState.settled);
  const showPlanFollowUpPrompt = false;
  const isSendBusy = admittingThreadIds.has(threadId);
  const hasLiveTurn = context.kind === "persisted" && context.row.state === "running";
  const isTurnWorking = hasLiveTurn;
  const isWorking = hasLiveTurn;
  const showThinking = isWorking;
  const hasControllableTurn = isTurnWorking;
  const activeTurnLayoutLive = isWorking || !latestTurnSettled;
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(activeLatestTurn, activeThread?.session ?? null, null)
      : null;
  const latestLifecycleMessage = activeThread?.messages.at(-1) ?? null;
  useEffect(() => {
    if (!activeThreadId) return;
    recordChatLifecycleDiagnostic({
      threadId: activeThreadId,
      isServerThread,
      isLocalDraftThread,
      threadDetailSyncState: threadItemsState.loaded
        ? "synced"
        : threadItemsError !== null
          ? "failed"
          : null,
      threadDetailHydration,
      projectedMessageCount: activeThread?.messages.length ?? 0,
      draftPromotedTo: draftThread?.promotedTo ?? null,
      threadWorkStatus: activeThread?.workStatus ?? null,
      sessionStatus: activeThread?.session?.status ?? null,
      sessionUpdatedAt: activeThread?.session?.updatedAt ?? null,
      threadUpdatedAt: activeThread?.updatedAt ?? null,
      orchestrationStatus: activeThread?.session?.orchestrationStatus ?? null,
      activeTurnId: activeThread?.session?.activeTurnId ?? null,
      latestTurnId: activeLatestTurn?.turnId ?? null,
      latestTurnState: activeLatestTurn?.state ?? null,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
      latestTurnCompletedAt: activeLatestTurn?.completedAt ?? null,
      projectedPendingTurnStartMessageId: activeThread?.pendingTurnStartMessageId ?? null,
      phase,
      hasLiveTurnTail,
      latestTurnSettledByProvider,
      latestTurnSettled,
      latestTurnLive,
      hasLiveTurn,
      isSendBusy,
      isConnecting,
      isTurnWorking,
      isWorking,
      showThinking,
      activeWorkStartedAt,
      streamingAssistantMessageCount:
        activeThread?.messages.filter(
          (message) => message.role === "assistant" && message.streaming,
        ).length ?? 0,
      latestMessageId: latestLifecycleMessage?.id ?? null,
      latestMessageRole: latestLifecycleMessage?.role ?? null,
      latestMessageCreatedAt: latestLifecycleMessage?.createdAt ?? null,
      latestMessageStreaming:
        latestLifecycleMessage?.role === "assistant" && latestLifecycleMessage.streaming === true,
    });
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    activeLatestTurn?.state,
    activeLatestTurn?.turnId,
    activeThread?.messages,
    activeThread?.pendingTurnStartMessageId,
    activeThread?.session?.activeTurnId,
    activeThread?.session?.orchestrationStatus,
    activeThread?.session?.status,
    activeThread?.session?.updatedAt,
    activeThread?.updatedAt,
    activeThread?.workStatus,
    activeThreadId,
    activeWorkStartedAt,
    draftThread?.promotedTo,
    hasLiveTurn,
    hasLiveTurnTail,
    isConnecting,
    isLocalDraftThread,
    isSendBusy,
    isServerThread,
    isTurnWorking,
    isWorking,
    latestTurnLive,
    latestTurnSettled,
    latestTurnSettledByProvider,
    latestLifecycleMessage?.createdAt,
    latestLifecycleMessage?.id,
    latestLifecycleMessage?.role,
    latestLifecycleMessage?.streaming,
    phase,
    showThinking,
    threadDetailHydration,
    threadItemsState.loaded,
    threadItemsError,
  ]);
  const activeTurnInProgress = activeTurnLayoutLive;
  const isComposerEditorDisabled = isLocalConnecting;
  const canCollapsePastedTextToDraft = shouldEnableComposerPastedTextCollapse({
    hasPendingUserInput: pendingUserInputs.length > 0,
    showPlanFollowUpPrompt,
  });
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

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
  const serverMessages = activeThread?.messages;
  const [queuedComposerActionInFlightIds, setQueuedComposerActionInFlightIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const runQueuedActionWhilePending = useCallback(
    <A,>(
      queuedTurn: Pick<CleanCoreQueuedMessage, "messageId">,
      _action: "steer" | "delete" | "edit",
      operation: () => Promise<A>,
    ): Promise<A | undefined> => {
      if (queuedComposerActionInFlightIds.has(queuedTurn.messageId))
        return Promise.resolve(undefined);
      setQueuedComposerActionInFlightIds((current) => new Set(current).add(queuedTurn.messageId));
      return operation().finally(() => {
        setQueuedComposerActionInFlightIds((current) => {
          const next = new Set(current);
          next.delete(queuedTurn.messageId);
          return next;
        });
      });
    },
    [queuedComposerActionInFlightIds],
  );
  const canonicalThreadForTimeline = useThreadSummary(activeThreadId);
  const serverQueuedMessageIds = useMemo(
    () =>
      new Set<MessageId>(
        canonicalThreadForTimeline === null
          ? []
          : Schema.decodeUnknownSync(Schema.Array(CleanCoreQueuedMessage))(
              JSON.parse(canonicalThreadForTimeline.queue),
            ).map((message) => message.messageId),
      ),
    [canonicalThreadForTimeline],
  );
  const timelineMessages = useMemo(
    () => (serverMessages ?? []).filter((message) => !serverQueuedMessageIds.has(message.id)),
    [serverMessages, serverQueuedMessageIds],
  );
  const promptHistory = useMemo(
    () => derivePromptHistoryFromMessages(timelineMessages),
    [timelineMessages],
  );
  const timelineEntries = useMemo(
    () =>
      measureChatPerformanceWork("transcript-timeline", () =>
        threadItemsToTimelineEntries(threadItems),
      ),
    [threadItems],
  );
  const shouldRenderTranscriptSurface = shouldRenderTranscriptDuringHydration({
    hydration: threadDetailHydration,
    messageCount: timelineEntries.length,
    isWorking,
  });
  const visibleTimelineEntries = timelineEntries;
  const renderedMessages = useMemo(
    () =>
      visibleTimelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    [visibleTimelineEntries],
  );
  const handoffAttachmentPreviews = useAttachmentPreviewHandoffs({
    threadId,
    serverMessages: serverMessages ?? EMPTY_MESSAGES,
    renderedMessages,
  });
  useEffect(() => {
    if (!activeThreadId) return;
    recordChatLifecycleUiDiagnostic({
      event: shouldRenderTranscriptSurface
        ? "transcript-surface-visible"
        : "hydration-surface-visible",
      threadId: activeThreadId,
      activeTurnId: activeThread?.session?.activeTurnId ?? null,
      activeTurnStartedAt: activeWorkStartedAt,
      isWorking,
      threadDetailHydration,
      visibleTimelineEntryIds: visibleTimelineEntries.map((entry) => entry.id),
      visibleWorkEntryIds: agentActivityTimelineState.timelineWorkEntries.map((entry) => entry.id),
      visibleWorkLogSequenceFloor: workLogVisibleSequenceFloor ?? null,
    });
  }, [
    activeThread?.session?.activeTurnId,
    activeThreadId,
    activeWorkStartedAt,
    isWorking,
    shouldRenderTranscriptSurface,
    threadDetailHydration,
    visibleTimelineEntries,
    agentActivityTimelineState.timelineWorkEntries,
    workLogVisibleSequenceFloor,
  ]);
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Every empty draft uses the Pencil prompt.
  const isCenteredEmptyLanding = threadDetailHydration === "ready" && timelineEntries.length === 0;

  const workspaceCwd = activeProject?.cwd ?? null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacPlatform(platform),
  );
  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: workspaceCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      folderCatalog.data?.plugins?.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [folderCatalog.data?.plugins],
  );
  const providerNativeCommands = useMemo(
    () =>
      (folderCatalog.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS).filter(
        (command) => !["plan", "default"].includes(command.name.toLowerCase()),
      ),
    [folderCatalog.data?.commands],
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
  const providerSkills = folderCatalog.data?.skills ?? EMPTY_PROVIDER_SKILLS;
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
  const canOfferReviewCommand = canOfferReviewSlashCommand({
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
    canOfferExportCommand,
    dynamicAgents,
    threadMentionSources: {
      threads: composerThreadSummaries,
      folders: composerThreadFolders,
      currentThreadId: threadId,
    },
  });
  const composerMenuItems = useMemo(() => {
    if (composerCommandPicker === "review-target") {
      return [
        {
          id: "review-target:changes",
          type: "review-target" as const,
          target: "changes" as const,
          label: "Review Uncommitted Changes",
          description: "Review local uncommitted changes",
        },
      ];
    }

    return normalComposerMenuItems;
  }, [composerCommandPicker, normalComposerMenuItems]);
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
  const keybindings = KEYBINDINGS;
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
    const savedConnectionId = stickyConnectionByProvider.codex;
    if (savedConnectionId !== null && savedConnectionId !== undefined) {
      return snapshot?.connections.some(
        (connection) =>
          connection.id === savedConnectionId &&
          connection.harness === "codex" &&
          connection.lifecycle === "active",
      )
        ? savedConnectionId
        : undefined;
    }
    return snapshot?.connections.find(
      (connection) => connection.harness === "codex" && connection.lifecycle === "active",
    )?.id;
  }, [providerConnectionsQuery.data, stickyConnectionByProvider.codex]);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
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

  const continueInFlightRef = useRef(false);
  const pendingContinueCommandIdRef = useRef<string | null>(null);
  const [hiddenContinueTurnId, setHiddenContinueTurnId] = useState<TurnId | null>(null);
  useEffect(() => {
    const commandId = pendingContinueCommandIdRef.current;
    if (commandId === null) return;
    const failed = threadActivities.some(
      (activity) =>
        activity.kind === "provider.turn.start.failed" &&
        activity.payload !== null &&
        typeof activity.payload === "object" &&
        "responseCommandId" in activity.payload &&
        activity.payload.responseCommandId === commandId,
    );
    if (!failed || activeThreadId === null) return;
    pendingContinueCommandIdRef.current = null;
    continueInFlightRef.current = false;
    setContinueInFlight(null);
    setThreadError(activeThreadId, "Couldn't continue this turn.");
  }, [activeThreadId, setThreadError, threadActivities]);
  useEffect(() => {
    if (!continueInFlight) return;
    if (
      activeThreadId !== continueInFlight.threadId ||
      activeLatestTurn?.turnId !== continueInFlight.turnId ||
      activeLatestTurn?.state === "running" ||
      activeLatestTurn?.requestedAt !== continueInFlight.requestedAt ||
      (activeThread?.session?.updatedAt ?? null) !== continueInFlight.sessionUpdatedAt
    ) {
      continueInFlightRef.current = false;
      setContinueInFlight(null);
    }
  }, [activeLatestTurn, activeThread?.session?.updatedAt, activeThreadId, continueInFlight]);
  const canShowContinue = shouldShowComposerContinue({
    thread: activeThread,
    isServerThread,
    hydration: threadDetailHydration,
    model: context.kind === "persisted" ? context.row.model : undefined,
    hiddenTurnId: hiddenContinueTurnId,
    continueInFlight: continueInFlight !== null,
    sendBusy: isSendBusy,
    connecting: isConnecting,
    hasSendableContent: composerSendState.hasSendableContent,
  });
  const unresolvedContinueInteractionCount = pendingUserInputs.length;
  const continueHiddenForTurn =
    activeLatestTurnId !== null && activeLatestTurnId === hiddenContinueTurnId;
  useEffect(() => {
    if (activeThreadId === null) return;
    recordChatComposerContinueDiagnostic({
      threadId: activeThreadId,
      turnId: activeLatestTurnId,
      turnState: activeLatestTurn?.state ?? null,
      sessionStatus: activeThread?.session?.status ?? null,
      orchestrationStatus: activeThread?.session?.orchestrationStatus ?? null,
      activeTurnId: activeSessionTurnId,
      isServerThread,
      hydration: threadDetailHydration,
      bindingModelAvailable: serverThread?.modelSelection.model != null,
      archived: activeThread?.archivedAt != null,
      queuedMessageCount: activeThread?.queuedMessageIds?.length ?? 0,
      pendingTurnStart: activeThread?.pendingTurnStartMessageId != null,
      pendingInteractionCount: unresolvedContinueInteractionCount,
      hasPendingUserInput: activeThread?.hasPendingUserInput === true,
      hiddenTurn: continueHiddenForTurn,
      continueInFlight: continueInFlight !== null,
      sendBusy: isSendBusy,
      connecting: isConnecting,
      hasSendableContent: composerSendState.hasSendableContent,
      canShowContinue,
    });
  }, [
    activeLatestTurn?.state,
    activeLatestTurnId,
    activeSessionTurnId,
    activeThread?.archivedAt,
    activeThread?.hasPendingUserInput,
    activeThread?.pendingTurnStartMessageId,
    activeThread?.queuedMessageIds?.length,
    activeThread?.session?.orchestrationStatus,
    activeThread?.session?.status,
    activeThreadId,
    serverThread?.modelSelection.model,
    canShowContinue,
    composerSendState.hasSendableContent,
    continueHiddenForTurn,
    continueInFlight,
    isConnecting,
    isSendBusy,
    isServerThread,
    threadDetailHydration,
    unresolvedContinueInteractionCount,
  ]);
  const onContinue = useCallback(async () => {
    if (!canShowContinue || !activeThread || !activeLatestTurn || context.kind !== "persisted")
      return;
    if (continueInFlightRef.current) return;
    const api = readNativeApi();
    if (!api) return;
    continueInFlightRef.current = true;
    const target = {
      threadId: activeThread.id,
      turnId: activeLatestTurn.turnId,
      requestedAt: activeLatestTurn.requestedAt,
      sessionUpdatedAt: activeThread.session?.updatedAt ?? null,
    };
    setContinueInFlight(target);
    const commandId = newCommandId();
    pendingContinueCommandIdRef.current = commandId;
    try {
      await api.cleanCore.updateThread({
        update: {
          action: "resume",
          threadId: target.threadId,
          messageId: newMessageId(),
          runtimeMode,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      pendingContinueCommandIdRef.current = null;
      continueInFlightRef.current = false;
      setContinueInFlight(null);
      const errorCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      recordChatLifecycleUiDiagnostic({
        event: "composer-continue-rejected",
        threadId: target.threadId,
        activeTurnId: activeSessionTurnId,
        activeTurnStartedAt: activeLatestTurn.startedAt,
        isWorking,
        commandId,
        targetTurnId: target.turnId,
        errorCode,
      });
      if (errorCode === "THREAD_CONTINUE_STALE") {
        setHiddenContinueTurnId(target.turnId);
      }
      setThreadError(target.threadId, "Couldn't continue this turn.");
    }
  }, [
    activeLatestTurn,
    activeSessionTurnId,
    activeThread,
    context,
    canShowContinue,
    isWorking,
    runtimeMode,
    setThreadError,
  ]);
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
  const voiceSendIntentRef = useRef<{ threadId: ThreadId } | null>(null);
  const [voiceMessageToSend, setVoiceMessageToSend] = useState<{
    threadId: ThreadId;
    prompt: string;
  } | null>(null);
  const appendVoiceTranscriptToComposer = useCallback(
    async (targetThreadId: ThreadId, transcript: string, voiceJobId: string) => {
      const draftStore = useComposerDraftStore.getState();
      const nextPrompt = draftStore.applyVoiceTranscript(targetThreadId, voiceJobId, transcript);
      if (!nextPrompt) {
        return;
      }
      if (targetThreadId !== threadId) {
        return;
      }
      promptRef.current = nextPrompt;
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
      if (voiceSendIntentRef.current?.threadId === targetThreadId) {
        setVoiceMessageToSend({ threadId: targetThreadId, prompt: nextPrompt });
      }
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
  const sendComposerVoiceRecording = () => {
    const intent = { threadId };
    voiceSendIntentRef.current = intent;
    void submitComposerVoiceRecording().finally(() => {
      if (voiceSendIntentRef.current === intent) voiceSendIntentRef.current = null;
    });
  };
  useLayoutEffect(() => {
    return () => {
      voiceSendIntentRef.current = null;
    };
  }, [threadId]);
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
  // Auto-follow keys on the clean-core message items (user/text seq/updated rows),
  // the transcript's only source; work rows must not re-stick the transcript.
  const transcriptAutoFollowSignal = useMemo(() => {
    const messageItems = threadItems.filter(isVisibleThreadMessageItem);
    const tail = messageItems.at(-1);
    return buildTranscriptAutoFollowSignal({
      messageCount: messageItems.length,
      tailKey: tail
        ? [tail.sourceId, tail.kind, tail.status, tail.text?.length ?? 0, tail.updatedAt].join(":")
        : "empty",
    });
  }, [threadItems]);
  const recordTranscriptControllerDiagnostic = useCallback(
    (event: string, detail?: Readonly<Record<string, unknown>>) => {
      const element = transcriptListRef.current?.getScrollableNode?.();
      recordChatScrollDiagnostic({
        instanceId: transcriptControllerDiagnosticInstanceIdRef.current!,
        event,
        dataCount: transcriptMessageCount,
        anchorRevision: transcriptAutoFollowSignal,
        ...(element === undefined ? {} : { element }),
        ...(detail === undefined ? {} : { detail }),
      });
    },
    [transcriptAutoFollowSignal, transcriptMessageCount],
  );
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (isAtEndRef.current === isAtEnd) return;
      if (!isAtEnd && performance.now() < programmaticScrollUntilRef.current) {
        recordTranscriptControllerDiagnostic("controller:at-end-change-ignored", {
          requestedIsAtEnd: false,
          programmaticGuardRemainingMs: Math.max(
            0,
            programmaticScrollUntilRef.current - performance.now(),
          ),
        });
        return;
      }
      isAtEndRef.current = isAtEnd;
      recordTranscriptControllerDiagnostic("controller:at-end-changed", {
        isAtEnd,
      });
      if (isAtEnd) {
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      } else {
        showScrollDebouncer.current.maybeExecute();
      }
    },
    [recordTranscriptControllerDiagnostic],
  );
  useLayoutEffect(() => {
    // MessagesTimeline remounts per thread. Resolve its initial placement before
    // the auto-follow layout effect below: a remembered detached viewport must
    // never inherit the previous thread's tail-follow ownership.
    clearTranscriptAutoFollow();
    const initialState = transcriptListRef.current?.getState?.();
    isAtEndRef.current = initialState?.isAtEnd ?? true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(!isAtEndRef.current);
  }, [activeThread?.id, clearTranscriptAutoFollow]);
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

        const beforeTop = activeScrollContainer.scrollTop;
        const requestedTop = beforeTop + delta;
        activeScrollContainer.scrollTop += delta;
        markChatScrollWrite(activeScrollContainer, {
          owner: "controller:interaction-anchor",
          requestedTop,
          beforeTop,
          afterTop: activeScrollContainer.scrollTop,
        });
        recordTranscriptControllerDiagnostic("controller:scroll-write:interaction-anchor", {
          delta,
          beforeTop,
          requestedTop,
          afterTop: activeScrollContainer.scrollTop,
        });
      });
    },
    [cancelPendingInteractionAnchorAdjustment, recordTranscriptControllerDiagnostic],
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
    const wasAtEnd = isAtEndRef.current;
    const guardRemainingMs = Math.max(0, programmaticScrollUntilRef.current - performance.now());
    programmaticScrollUntilRef.current = 0;
    clearTranscriptAutoFollow();
    isAtEndRef.current = false;
    showScrollDebouncer.current.maybeExecute();
    recordTranscriptControllerDiagnostic("controller:reader-detached", {
      source: "touch-move",
      wasAtEnd,
      programmaticGuardRemainingMs: guardRemainingMs,
    });
  }, [clearTranscriptAutoFollow, recordTranscriptControllerDiagnostic]);
  const onMessagesTouchStartBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesWheelBase = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY >= 0) return;
      const wasAtEnd = isAtEndRef.current;
      const guardRemainingMs = Math.max(0, programmaticScrollUntilRef.current - performance.now());
      programmaticScrollUntilRef.current = 0;
      clearTranscriptAutoFollow();
      isAtEndRef.current = false;
      showScrollDebouncer.current.maybeExecute();
      recordTranscriptControllerDiagnostic("controller:reader-detached", {
        source: "wheel-up",
        deltaY: event.deltaY,
        wasAtEnd,
        programmaticGuardRemainingMs: guardRemainingMs,
      });
    },
    [clearTranscriptAutoFollow, recordTranscriptControllerDiagnostic],
  );
  useLayoutEffect(() => {
    const ownsExplicitFollowRequest =
      activeThread?.id !== undefined && autoFollowThreadIdRef.current === activeThread.id;
    if (!ownsExplicitFollowRequest) {
      recordTranscriptControllerDiagnostic("controller:auto-follow-skipped", {
        isAtEnd: isAtEndRef.current,
        ownsExplicitFollowRequest: false,
      });
      return;
    }
    // The controller acquires tail ownership once for an explicit send/steer.
    // After that handoff, TranscriptVirtualList is the sole geometry owner for
    // streaming appends and row measurements. Reissuing an imperative scroll
    // for every text revision races the virtualizer's measurement correction
    // and was the second writer behind the recorded oscillation.
    const frameId = window.requestAnimationFrame(() => {
      if (activeThread?.id === undefined || autoFollowThreadIdRef.current !== activeThread.id) {
        return;
      }
      const shouldAnimate = animateNextAutoFollowScrollRef.current;
      animateNextAutoFollowScrollRef.current = false;
      scrollToEnd(shouldAnimate);
      autoFollowThreadIdRef.current = null;
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    activeThread?.id,
    recordTranscriptControllerDiagnostic,
    scrollToEnd,
    transcriptAutoFollowSignal,
  ]);
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
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
    enabled: Boolean(activeThread) && pendingUserInputs.length === 0,
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
  useLayoutEffect(() => {
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
  }, [activeThread?.id, composerFooterHasWideActions]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;

    let previousHeight = composerForm.getBoundingClientRect().height;
    let pendingScrollFrame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      if (pendingScrollFrame !== null) {
        window.cancelAnimationFrame(pendingScrollFrame);
        pendingScrollFrame = null;
      }
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

      pendingScrollFrame = window.requestAnimationFrame(() => {
        pendingScrollFrame = null;
        // Composer chrome changed the viewport; no transcript item
        // arrived. Preserve an existing tail position directly instead of
        // entering the semantic message auto-follow path.
        const beforeTop = scrollContainer.scrollTop;
        const requestedTop = scrollContainer.scrollHeight;
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        markChatScrollWrite(scrollContainer, {
          owner: "controller:composer-resize",
          requestedTop,
          beforeTop,
          afterTop: scrollContainer.scrollTop,
        });
        recordTranscriptControllerDiagnostic("controller:scroll-write:composer-resize", {
          beforeTop,
          requestedTop,
          afterTop: scrollContainer.scrollTop,
        });
      });
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
      if (pendingScrollFrame !== null) {
        window.cancelAnimationFrame(pendingScrollFrame);
      }
    };
  }, [
    activeThread?.id,
    recordTranscriptControllerDiagnostic,
    secondaryChromeReady,
    shouldRenderChatPaneContent,
  ]);

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
    if (!activeThread?.id) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer]);

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
    promptRefThreadId.current = threadId;
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
    setExpandedImage(null);
  }, [threadId]);

  const [composerStateThreadId, setComposerStateThreadId] = useState(threadId);
  if (composerStateThreadId !== threadId) {
    setComposerStateThreadId(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(prompt, prompt.length));
    setComposerTrigger(detectComposerTrigger(prompt, prompt.length));
    setIsDragOverComposer(false);
  }
  useEffect(() => {
    dragDepthRef.current = 0;
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

  const queuedMessages = useMemo(
    () =>
      canonicalThread === null
        ? []
        : Schema.decodeUnknownSync(Schema.Array(CleanCoreQueuedMessage))(
            JSON.parse(canonicalThread.queue),
          ).filter((message) => message.origin._tag !== "recovery"),
    [canonicalThread],
  );

  const { stopping, stop: stopProviderTurn } = useThreadStop(
    isServerThread ? activeThreadId : null,
    (error) => {
      if (activeThreadId !== null)
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to interrupt the provider turn.",
        );
    },
  );
  const onInterrupt = useCallback(async () => {
    if (!activeThread) return;
    await stopProviderTurn?.();
  }, [activeThread, stopProviderTurn]);

  const onStopWorkflowRun = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || !workflowRunState) return;
    await api.cleanCore.updateThread({
      update: {
        action: "stopTask",
        threadId: activeThread.id,
        taskId: workflowRunState.workflowTaskId,
        updatedAt: new Date().toISOString(),
      },
    });
  }, [activeThread, workflowRunState]);

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
      setComposerDraftModelSelectionAndSticky(activeThread.id, nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelectionAndSticky,
      customModelsByProvider,
      selectableModelOptionsByProvider,
    ],
  );

  useEffect(() => {
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
      const composerPickerShortcutActive =
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      const shortcutContext = {};

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "composer.focus.toggle") {
        if (isVoiceRecording || isVoiceTranscribing) return;
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
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    activeThreadId,
    keybindings,
    onInterrupt,
    hasControllableTurn,
    handleModelPickerOpenChange,
    handleTraitsPickerOpenChange,
    isVoiceRecording,
    isVoiceTranscribing,
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

  const addComposerAttachments = useCallback(
    (files: readonly File[]) => {
      const splitFiles = splitComposerDropzoneFiles(files);
      if (splitFiles.imageFiles.length > 0) {
        addComposerImages(splitFiles.imageFiles);
      }
      if (splitFiles.genericFiles.length > 0) {
        addComposerFiles(splitFiles.genericFiles);
      }
    },
    [addComposerFiles, addComposerImages],
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

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      cancelPendingPromptPersistence();
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [
      cancelPendingPromptPersistence,
      clearComposerDraftContent,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const onSendRef = useRef<
    (
      e?: { preventDefault: () => void },
      dispatchMode?: "queue" | "steer",
      queuedTurn?: ComposerSubmission,
    ) => Promise<boolean>
  >(async () => false);
  const savePromptRef = useRef<() => Promise<boolean>>(async () => false);

  const cancelQueuedMessage = useCallback(
    async (message: Pick<CleanCoreQueuedMessage, "messageId">) => {
      const api = readNativeApi();
      if (!api) return false;
      try {
        const result = await api.cleanCore.cancelQueuedMessage({
          threadId,
          messageId: message.messageId,
        });
        setThreadError(threadId, null);
        return result.removed;
      } catch (error) {
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to remove the message.",
        );
        return false;
      }
    },
    [threadId, setThreadError],
  );
  const removeQueuedMessage = useCallback(
    (message: CleanCoreQueuedMessage) => {
      void runQueuedActionWhilePending(message, "delete", () => cancelQueuedMessage(message));
    },
    [runQueuedActionWhilePending, cancelQueuedMessage],
  );

  const removeFailedMessage = useCallback(
    (messageId: MessageId) => {
      void cancelQueuedMessage({ messageId });
    },
    [cancelQueuedMessage],
  );

  // These handlers are declared later because they depend on composer controls
  // established below. Route event-time calls through a ref so the earlier send
  // handler does not capture later-declared bindings and bail out React Compiler.
  const lateComposerSendHandlersRef = useRef<LateComposerSendHandlers | null>(null);

  const submitComposer = async (
    intent: "send" | "save",
    e?: { preventDefault: () => void },
    dispatchMode: "queue" | "steer" = "queue",
  ): Promise<boolean> => {
    const saving = intent === "save";
    e?.preventDefault();
    const api = readNativeApi();
    const lateSendHandlers = lateComposerSendHandlersRef.current;
    if (!api || !lateSendHandlers || !activeThread || isVoiceTranscribing) return false;
    if (activePendingProgress && !saving) {
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

    const threadIdForSend = activeThread.id;
    if (admittingThreadsRef.current.has(threadIdForSend)) return false;
    admittingThreadsRef.current.add(threadIdForSend);
    setAdmittingThreadIds(new Set(admittingThreadsRef.current));
    let sentComposerDraft: typeof composerDraft | undefined;
    let composerCleared = false;
    return (async () => {
      flushPendingPromptPersistence(threadIdForSend);
      const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
      const promptForSend = liveComposerSnapshot?.value ?? promptRef.current;
      let composerImagesForSend = [...composerImages];
      const composerFilesForSend = [...composerFiles];
      const composerAssistantSelectionsForSend = [...composerAssistantSelections];
      const composerFileCommentsForSend = [...composerFileComments];
      const composerTerminalContextsForSend = [...composerTerminalContexts];
      const composerPastedTextsForSend = [...composerPastedTexts];
      const selectedComposerSkillsForSend = [...selectedComposerSkillsRef.current];
      const selectedComposerMentionsForSend = [...selectedComposerMentionsRef.current];
      const selectedProviderForSend = selectedProvider;
      const selectedModelForSend = selectedModel;
      const selectedPromptEffortForSend = selectedPromptEffort;
      const selectedModelSelectionForSend = selectedModelSelection;
      let selectedConnectionIdForSend = resolveSelectedConnection(
        selectedProviderForSend,
        selectedModelSelectionForSend.model,
      );
      const providerOptionsForDispatchForSend = providerOptionsForDispatch;
      const capturedDraft =
        useComposerDraftStore.getState().draftsByThreadId[threadIdForSend] ?? composerDraft;
      const sentDraftUpdatedAt = readDraftUpdatedAt();
      sentComposerDraft = { ...capturedDraft, prompt: promptForSend };
      const capturedSavedPayload = JSON.stringify(
        captureComposerPromptHistorySavedDraft({
          threadId: threadIdForSend,
          draft: capturedDraft,
          prompt: promptForSend,
        }),
      );
      const matchesSavedSnapshot = () => {
        const latest = useComposerDraftStore.getState().draftsByThreadId[threadIdForSend];
        if (!latest) return false;
        const livePrompt =
          promptRefThreadId.current === threadIdForSend
            ? (composerEditorRef.current?.readSnapshot()?.value ?? promptRef.current)
            : latest.prompt;
        return (
          JSON.stringify(
            captureComposerPromptHistorySavedDraft({
              threadId: threadIdForSend,
              draft: latest,
              prompt: livePrompt,
            }),
          ) === capturedSavedPayload
        );
      };
      const pendingBlobAttachments = findPendingBlobComposerAttachments({
        persistedAttachments: capturedDraft.persistedAttachments,
        images: composerImagesForSend,
      });
      const initialSendState = deriveComposerSendState({
        prompt: promptForSend,
        imageCount: composerImagesForSend.length + pendingBlobAttachments.length,
        fileCount: composerFilesForSend.length,
        assistantSelectionCount: composerAssistantSelectionsForSend.length,
        fileCommentCount: composerFileCommentsForSend.length,
        terminalContexts: composerTerminalContextsForSend,
        pastedTexts: composerPastedTextsForSend,
      });
      const initialHasNoStructuredComposerContext =
        composerImagesForSend.length === 0 &&
        pendingBlobAttachments.length === 0 &&
        composerFilesForSend.length === 0 &&
        composerAssistantSelectionsForSend.length === 0 &&
        composerFileCommentsForSend.length === 0 &&
        initialSendState.sendableTerminalContexts.length === 0 &&
        initialSendState.sendablePastedTexts.length === 0 &&
        selectedComposerMentionsForSend.length === 0;
      if (initialHasNoStructuredComposerContext && !saving) {
        if (initialSendState.trimmedPrompt.startsWith("/")) {
          let slashCommandFailed = false;
          const handledSlashCommand = await lateSendHandlers
            .handleStandaloneSlashCommand(initialSendState.trimmedPrompt)
            .catch((error) => {
              setThreadError(
                activeThread.id,
                error instanceof Error ? error.message : "Failed to run the command.",
              );
              slashCommandFailed = true;
              return false;
            });
          if (slashCommandFailed) return false;
          if (handledSlashCommand) return true;
        }
      }
      if (!initialSendState.hasSendableContent) {
        if (initialSendState.expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            initialSendState.expiredTerminalContextCount,
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

      if (!saving) {
        cancelPendingPromptPersistence();
        composerEditorRef.current?.clear();
        clearComposerDraftContent(threadIdForSend, {
          preservePreviewUrls: true,
          preservePersistedAssets: true,
        });
        promptRef.current = "";
        setComposerCursor(0);
        setComposerTrigger(null);
        composerCleared = true;
      }

      if (pendingBlobAttachments.length > 0) {
        const hydrated = await hydratePendingBlobComposerAttachments(pendingBlobAttachments);
        composerImagesForSend = [...composerImagesForSend, ...hydrated];
      }
      if (selectedConnectionIdForSend === undefined && !saving) {
        // A managed login may complete while Settings is closing or unmounted,
        // before its cache invalidation reaches this already-mounted composer.
        // Re-read the authoritative Space snapshot at the admission boundary;
        // this selects only the exact persisted default/route and never guesses.
        const availableConnectionIds = runtimeModelsByProvider[
          selectedModelSelectionForSend.provider
        ].find(
          (descriptor) => descriptor.slug === selectedModelSelectionForSend.model,
        )?.availableConnectionIds;
        const availableConnectionOptions =
          availableConnectionIds === undefined ? {} : { availableConnectionIds };
        const startedThreadBindingLoaded = context.kind === "persisted";
        const startedThreadBindingConnectionId =
          context.kind === "persisted" ? context.row.connectionId : undefined;
        let connectionResolutionFailed = false;
        selectedConnectionIdForSend = await resolveComposerConnectionAtAdmission({
          snapshot: providerConnectionsQuery.data,
          refreshSnapshot: async () => (await providerConnectionsQuery.refetch()).data,
          refreshAvailableConnectionIds: async () => {
            const route = discoveryRouteByProvider[selectedModelSelectionForSend.provider];
            if (route === undefined) return undefined;
            const catalog = await api.provider.getCatalog({
              provider: selectedModelSelectionForSend.provider,
              connectionId: route.connectionId,
              kinds: ["models"],
            });
            return catalog.models?.find(
              (model) => model.slug === selectedModelSelectionForSend.model,
            )?.availableConnectionIds;
          },
          provider: selectedModelSelectionForSend.provider,
          model: selectedModelSelectionForSend.model,
          ...availableConnectionOptions,
          explicitSelection: {
            specified: Object.prototype.hasOwnProperty.call(
              selectedConnectionByProvider,
              selectedModelSelectionForSend.provider,
            ),
            connectionId: selectedConnectionByProvider[selectedModelSelectionForSend.provider],
          },
          startedThreadBinding: {
            loaded: startedThreadBindingLoaded,
            connectionId: startedThreadBindingConnectionId,
          },
          hasThreadStarted,
        }).catch((error) => {
          setThreadError(
            activeThread.id,
            error instanceof Error ? error.message : "Failed to resolve the Connection.",
          );
          connectionResolutionFailed = true;
          return undefined;
        });
        if (connectionResolutionFailed) return false;
      }
      // A first turn may omit the Connection and let the server resolve the
      // Space's persisted default (or declared anonymous route). Once a harness
      // has started, however, the exact durable binding remains mandatory.
      if (selectedConnectionIdForSend === undefined && hasThreadStarted && !saving) {
        setThreadError(activeThread.id, "Choose a Connection before sending this message.");
        return false;
      }
      const runtimeModeForSend = runtimeMode;
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
      if (!activeProject) {
        return false;
      }

      if (!saving) window.desktopBridge?.threadHome?.send({ threadId: threadIdForSend });
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
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
      const targetFolderIdForSend = activeProject.id;
      const targetProjectDefaultModelSelectionForSend = activeProject.defaultModelSelection ?? null;
      let nextRuntimeModeForSend = runtimeModeForSend;
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

      const outgoingTextSeed =
        messageTextForSend ||
        (composerImagesSnapshot.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
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
      const stagedTurnAttachments = await stageUploadComposerAttachments({
        threadId: threadIdForSend,
        images: composerImagesSnapshot,
        files: composerFilesSnapshot,
        assistantSelections: composerAssistantSelectionsSnapshot,
      });

      if (!saving)
        handoffAttachmentPreviews(
          messageIdForSend,
          composerImagesSnapshot
            .map((image) => image.previewUrl)
            .filter((url) => url.startsWith("blob:")),
        );
      if (!saving) armTranscriptAutoFollow(threadIdForSend);
      setThreadError(threadIdForSend, null);
      if (expiredTerminalContextCount > 0) {
        const copy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "omitted");
        toastManager.add({ type: "warning", title: copy.title, description: copy.description });
      }
      const threadCreateModelSelection: ModelSelection = buildModelSelection(
        selectedModelSelectionForSend.provider,
        selectedModelSelectionForSend.model ||
          selectedModelForSend ||
          targetProjectDefaultModelSelectionForSend?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelectionForSend.options,
      );

      if (!saving)
        rememberCustomBinaryPathForDispatch({
          threadId: threadIdForSend,
          provider: selectedModelSelectionForSend.provider,
          providerOptions: providerOptionsForDispatchForSend,
        });
      await stagedTurnAttachments.runWithDispatch(async (attachments) => {
        const send: Omit<CleanCoreUserSendMessageInput, "threadId"> = {
          draftUpdatedAt: sentDraftUpdatedAt,
          runtimeMode: runtimeModeForSend,
          message: {
            messageId: messageIdForSend,
            text: outgoingMessageText,
            attachments: [
              ...attachments.filter((attachment) => attachment.type !== "assistant-selection"),
              ...composerAssistantSelectionsSnapshot.map((selection) => ({
                ...selection,
                assistantMessageId: MessageId.make(selection.assistantMessageId),
              })),
            ],
            queuedAt: messageCreatedAt,
          },
          modelSelection: selectedModelSelectionForSend,
          ...(providerOptionsForDispatchForSend === undefined
            ? {}
            : { providerOptions: providerOptionsForDispatchForSend }),
          assistantDeliveryMode,
          ...(mentionedSkillsForSend.length === 0 ? {} : { skills: mentionedSkillsForSend }),
          ...(mentionedPluginMentionsForSend.length === 0
            ? {}
            : { mentions: mentionedPluginMentionsForSend }),
          ...(selectedConnectionIdForSend === undefined
            ? {}
            : { connectionId: selectedConnectionIdForSend }),
          dispatchMode,
        };
        if (saving) {
          if (isLocalDraftThread) {
            const promoted = await promoteThreadCreate(
              {
                creator: { kind: "user" },
                connection:
                  selectedConnectionIdForSend === undefined
                    ? { kind: "default" }
                    : { kind: "selected", connectionId: selectedConnectionIdForSend },
                threadId: threadIdForSend,
                folderId: targetFolderIdForSend,
                title,
                modelSelection: threadCreateModelSelection,
                runtimeMode: nextRuntimeModeForSend,
                createdAt: activeThread.createdAt,
              },
              api,
            );
            if (promoted === "unavailable") failChatOperation("The app is not connected.");
          }
          if (!matchesSavedSnapshot()) failChatOperation("The draft changed. Try again.");
          const savedDraftUpdatedAt = await flushCommittedDraft(
            sentComposerDraft!,
            threadIdForSend,
          );
          if (!matchesSavedSnapshot()) failChatOperation("The draft changed. Try again.");
          const result = await api.cleanCore.savePrompt({
            threadId: threadIdForSend,
            draftUpdatedAt: savedDraftUpdatedAt,
            message: {
              messageId: send.message.messageId,
              text: send.message.text,
              attachments: send.message.attachments,
              ...(send.skills === undefined ? {} : { skills: send.skills }),
              ...(send.mentions === undefined ? {} : { mentions: send.mentions }),
            },
          });
          // A later local edit is a new draft, not part of the saved snapshot.
          if (matchesSavedSnapshot()) {
            cancelPendingPromptPersistence();
            clearComposerDraftContent(threadIdForSend);
            if (promptRefThreadId.current === threadIdForSend) {
              composerEditorRef.current?.clear();
              promptRef.current = "";
              setComposerCursor(0);
              setComposerTrigger(null);
              await refreshCommittedDraft();
            }
          }
          return result;
        }
        if (!isLocalDraftThread)
          return api.cleanCore.sendMessage({ ...send, threadId: threadIdForSend });
        setAcceptedFirstMessage({
          threadId: threadIdForSend,
          sourceId: messageIdForSend,
          seq: 1,
          turnId: null,
          kind: "user",
          status: "sending",
          text: send.message.text,
          data: JSON.stringify({ origin: { _tag: "user" }, attachments: send.message.attachments }),
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
        });
        const result = await api.cleanCore.createAndSendThread({
          ...send,
          thread: {
            creator: { kind: "user" },
            connection:
              selectedConnectionIdForSend === undefined
                ? { kind: "default" }
                : { kind: "selected", connectionId: selectedConnectionIdForSend },
            threadId: threadIdForSend,
            folderId: targetFolderIdForSend,
            title,
            modelSelection: threadCreateModelSelection,
            runtimeMode: nextRuntimeModeForSend,
            createdAt: activeThread.createdAt,
          },
        });
        applyThreadCreationResponse(result);
        return result.sendResult;
      });

      // Re-read the committed compare-and-clear through the draft controller.
      if (!saving && promptRefThreadId.current === threadIdForSend) await refreshCommittedDraft();
      if (promptRefThreadId.current === threadIdForSend) scheduleComposerFocus();
      return true;
    })()
      .catch((error) => {
        setAcceptedFirstMessage((current) =>
          current?.threadId === threadIdForSend ? null : current,
        );
        const currentDraft = useComposerDraftStore.getState().draftsByThreadId[threadIdForSend];
        if (
          composerCleared &&
          sentComposerDraft &&
          (!currentDraft ||
            (currentDraft.prompt.length === 0 &&
              [
                currentDraft.images,
                currentDraft.persistedAttachments,
                currentDraft.files,
                currentDraft.assistantSelections,
                currentDraft.fileComments,
                currentDraft.pastedTexts,
                currentDraft.terminalContexts,
                currentDraft.skills,
                currentDraft.mentions,
              ].every((entries) => entries.length === 0)))
        )
          applyServerThreadDraft(threadIdForSend, sentComposerDraft);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
        return false;
      })
      .finally(() => {
        admittingThreadsRef.current.delete(threadIdForSend);
        setAdmittingThreadIds(new Set(admittingThreadsRef.current));
      });
  };

  const onSend = (e?: { preventDefault: () => void }, dispatchMode: "queue" | "steer" = "queue") =>
    submitComposer("send", e, dispatchMode);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        resolveShortcutCommand(event, keybindings, { context: {} }) !== "composer.saveForLater"
      )
        return;
      const target = event.target;
      const transcript = transcriptListRef.current?.getScrollableNode?.();
      if (
        !eventTargetsComposer(event, composerFormRef.current) &&
        !(target instanceof Node && transcript?.contains(target))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void savePromptRef.current();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [keybindings]);

  const onRespondToUserInput = useCallback(
    async (requestId: string, answers: ProviderUserInputAnswers, lifecycleGeneration?: string) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);
      const dispatchAnswers: Record<string, CleanCoreAnswerThreadQuestionInput["answers"][string]> =
        {};
      for (const [key, answer] of Object.entries(answers)) {
        if (typeof answer === "string" || Array.isArray(answer)) dispatchAnswers[key] = answer;
      }

      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      await api.cleanCore
        .answerThreadQuestion({
          threadId: activeThreadId,
          requestId,
          answers: dispatchAnswers,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
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

  // Keep event-time sends current with the latest callbacks after each commit.
  useLayoutEffect(() => {
    onSendRef.current = onSend;
    savePromptRef.current = () => submitComposer("save");
  });

  // Transcript delivery updates the draft first. Send only after transcription
  // ends and the editor has committed that draft, through the ordinary send path.
  useEffect(() => {
    if (!voiceMessageToSend || isVoiceTranscribing) return;
    setVoiceMessageToSend(null);
    if (
      voiceMessageToSend.threadId === threadId &&
      promptRef.current === voiceMessageToSend.prompt
    ) {
      void onSendRef.current();
    }
  }, [isVoiceTranscribing, threadId, voiceMessageToSend]);

  useLayoutEffect(
    () =>
      registerDesktopThreadLiveHandlers(threadId, {
        read: () => ({
          threadId,
          phase:
            activePendingProgress !== null
              ? "waiting"
              : isSendBusy || isConnecting
                ? "submitting"
                : phase === "running" || activeSessionTurnId !== null
                  ? "running"
                  : "idle",
          activeTurnId: activeSessionTurnId,
          queuedCount: serverQueuedMessageIds.size,
          pendingUserInput: activePendingProgress !== null,
          sendBusy: isSendBusy,
        }),
        send: async ({ expectedText, mode }) => {
          if (activePendingProgress !== null) {
            throw Object.assign(new Error("The current Thread is waiting for a human answer."), {
              code: "THREAD_WAITING_FOR_USER",
            });
          }
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const editorText =
              composerEditorRef.current?.readSnapshot()?.value ?? promptRef.current;
            if (editorText === expectedText) return onSendRef.current(undefined, mode);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          throw Object.assign(
            new Error("The visible composer did not converge on the staged composition."),
            { code: "COMPOSER_NOT_READY" },
          );
        },
      }),
    [
      activePendingProgress,
      activeSessionTurnId,
      isConnecting,
      isSendBusy,
      phase,
      serverQueuedMessageIds.size,
      threadId,
    ],
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
    });
    if (sent && activeThreadId) {
      markWorkflowRunDismissed(activeThreadId, workflowTaskId);
    }
  }, [
    activeThreadId,
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

  const steerQueuedMessage = useCallback(
    async (message: CleanCoreQueuedMessage) => {
      armTranscriptAutoFollow(threadId);
      await runQueuedActionWhilePending(message, "steer", async () => {
        const api = readNativeApi();
        if (!api) return;
        try {
          await api.cleanCore.steerQueued({
            threadId,
            messageId: message.messageId,
          });
          setThreadError(threadId, null);
        } catch (error) {
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Failed to steer the queued message.",
          );
        }
      });
    },
    [runQueuedActionWhilePending, setThreadError, threadId],
  );
  const moveMessageIntoComposer = useCallback(
    (source: "queue" | "saved", message: CleanCoreQueuedMessage | CleanCoreSavedPrompt) => {
      flushPendingPromptPersistence(threadId);
      const draft = selectComposerThreadDraft(useComposerDraftStore.getState(), threadId);
      if (
        draft.prompt.length > 0 ||
        draft.images.length > 0 ||
        draft.persistedAttachments.length > 0 ||
        draft.files.length > 0 ||
        draft.assistantSelections.length > 0
      ) {
        toastManager.add({
          type: "error",
          title:
            source === "queue"
              ? QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR
              : SAVED_PROMPT_RESTORE_NONEMPTY_DRAFT_ERROR,
        });
        return false;
      }
      void runQueuedActionWhilePending(message, "edit", async () => {
        const api = readNativeApi();
        if (!api) return;
        const moveIntoDraft =
          source === "queue" ? api.cleanCore.editQueuedMessage : api.cleanCore.restoreSavedPrompt;
        try {
          await flushCommittedDraft(draft, threadId);
          // Stage the existing attachment bytes under the same ID used by the draft.
          await Promise.all(
            message.attachments
              .filter((attachment) => attachment.type !== "assistant-selection")
              .map(async (attachment) => {
                const response = await fetch(
                  toAttachmentPreviewUrl(`/attachments/${encodeURIComponent(attachment.id)}`),
                );
                if (!response.ok)
                  failChatOperation("Failed to prepare the queued attachment for editing.");
                const blob = await response.blob();
                await persistComposerAsset({
                  threadId,
                  assetId: attachment.id,
                  file: new File([blob], attachment.name, { type: attachment.mimeType }),
                });
              }),
          );
          if (selectComposerThreadDraft(useComposerDraftStore.getState(), threadId) !== draft)
            failChatOperation("The draft changed. Try again.");
          const result = await moveIntoDraft({
            threadId,
            messageId: message.messageId,
            updatedAt: new Date().toISOString(),
          });
          if (!result.removed) failChatOperation("This message is no longer queued.");
          setThreadError(threadId, null);
          scheduleComposerFocus();
        } catch (error) {
          const description =
            error instanceof Error ? error.message : "Failed to edit the queued message.";
          if (
            Schema.is(QueuedEditDraftNotEmptyError)(error) ||
            Schema.is(SavedRestoreDraftNotEmptyError)(error)
          ) {
            toastManager.add({
              type: "error",
              title:
                source === "queue"
                  ? QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR
                  : SAVED_PROMPT_RESTORE_NONEMPTY_DRAFT_ERROR,
            });
            return;
          }
          setThreadError(threadId, description);
          toastManager.add({
            type: "error",
            title:
              source === "queue" ? "Couldn't edit queued message" : "Couldn't restore saved prompt",
            description,
          });
        }
      });
      return true;
    },
    [
      runQueuedActionWhilePending,
      setThreadError,
      threadId,
      scheduleComposerFocus,
      flushPendingPromptPersistence,
      flushCommittedDraft,
    ],
  );
  const editQueuedMessage = useCallback(
    (message: CleanCoreQueuedMessage) => {
      moveMessageIntoComposer("queue", message);
    },
    [moveMessageIntoComposer],
  );
  const savedPrompts = useMemo(
    () =>
      canonicalThread === null
        ? []
        : Schema.decodeUnknownSync(Schema.Array(CleanCoreSavedPrompt))(
            JSON.parse(canonicalThread.saved),
          ).toSorted((a, b) => b.savedAt.localeCompare(a.savedAt)),
    [canonicalThread],
  );
  const restoreSavedPrompt = useCallback(
    (messageId: string) => {
      const message = savedPrompts.find((entry) => entry.messageId === messageId);
      return message ? moveMessageIntoComposer("saved", message) : false;
    },
    [savedPrompts, moveMessageIntoComposer],
  );
  const deleteSaved = useCallback(
    (messageId: string) => {
      const message = savedPrompts.find((entry) => entry.messageId === messageId);
      if (!message) return;
      void runQueuedActionWhilePending(message, "delete", async () => {
        const api = readNativeApi();
        if (!api) return;
        try {
          await api.cleanCore.deleteSavedPrompt({ threadId, messageId: message.messageId });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Couldn't delete saved prompt",
            description: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
    [savedPrompts, runQueuedActionWhilePending, threadId],
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
      onSelectionCommitted={scheduleComposerFocus}
      open={isComposerModelEffortPickerOpen}
      onOpenChange={handleComposerModelEffortPickerOpenChange}
      shortcutLabel={modelPickerShortcutLabel}
    />
  );
  const ComposerFooterActions = useSplitComposerPickerControls
    ? ComposerActionsEmptyThread
    : ComposerActions;

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
    cancelPendingPromptPersistence();
    clearComposerDraftContent(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    scheduleComposerFocus();
  }, [cancelPendingPromptPersistence, clearComposerDraftContent, scheduleComposerFocus, threadId]);

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
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
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
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    selectedConnectionId,
    runtimeMode,
    threadId,
    navigateToThread: (nextThreadId) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: () => ({}),
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
      await handleNewThread(activeProject.id, {});
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
        folderCatalog.isLoading ||
        folderCatalog.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (folderCatalog.isLoading || folderCatalog.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        folderCatalog.isLoading ||
        folderCatalog.isFetching));

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
      promptRefThreadId.current = threadId;
      schedulePromptPersistence(nextPrompt, nextCursor, expandedCursor, cursorAdjacentToMention);
      if (composerCommandPicker !== null && nextPrompt.trim().length > 0) {
        setComposerCommandPicker(null);
      }
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
    },
    [
      activePendingQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      composerCommandPicker,
      onChangeActivePendingUserInputCustomAnswer,
      promptHistory,
      restoreComposerDraftPromptHistorySavedDraft,
      schedulePromptPersistence,
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
        (event.metaKey || event.ctrlKey) &&
        hasLiveTurn &&
        !admittingThreadsRef.current.has(threadId)
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
        search: () => ({}),
      });
    },
    [navigate],
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
    isHomeChat: isChatProject,
    isEmpty: timelineEntries.length === 0,
  });

  // Pencil's narrow variants hide lower-priority actions in place. Controls
  // never relocate into the removed legacy toolbar row below the composer.
  const renderComposerLeadingControls = () => (
    <>
      <span className="inline-flex shrink-0" data-pencil-action="attach">
        <ComposerExtrasMenu onAddAttachments={addComposerAttachments} />
      </span>
      <span className="inline-flex shrink-0" data-pencil-action="saved">
        <ComposerSavedPrompts
          prompts={savedPrompts.map((entry) => ({
            messageId: entry.messageId,
            text: entry.text,
            savedAt: entry.savedAt,
            attachments: entry.attachments.map((attachment) => ({
              name: attachment.type === "assistant-selection" ? attachment.text : attachment.name,
            })),
          }))}
          onRestore={restoreSavedPrompt}
          onDelete={deleteSaved}
          shortcutLabel={shortcutLabelForCommand(keybindings, "composer.saveForLater")}
        />
      </span>
    </>
  );
  const idleComposerVoiceControl =
    showVoiceNotesControl &&
    pendingUserInputs.length === 0 &&
    !isVoiceRecording &&
    !isVoiceTranscribing ? (
      <span className="inline-flex shrink-0 @max-[280px]:hidden" data-pencil-action="voice">
        <ComposerVoiceButton
          disabled={isConnecting || isSendBusy}
          isRecording={isVoiceRecording}
          isTranscribing={isVoiceTranscribing}
          durationLabel={voiceRecordingDurationLabel}
          onClick={toggleComposerVoiceRecording}
        />
      </span>
    ) : null;

  const showComposerWorkflowRunCard = workflowRunState !== null;

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
              <ComposerQueuedHeader
                queuedTurns={queuedMessages}
                actionInFlightIds={queuedComposerActionInFlightIds}
                onSteer={steerQueuedMessage}
                onRemove={removeQueuedMessage}
                onEdit={editQueuedMessage}
                cwd={workspaceCwd ?? undefined}
                attachedToPrevious={showComposerWorkflowRunCard}
              />
              {/* Pending approvals and AskUserQuestion prompts both render as a detached
                  card floating just above the composer (padding gives the measured gap),
                  instead of a banner fused into the composer surface. An approval takes
                  precedence and suppresses the question card while one is active. */}
              {pendingUserInputs.length > 0 ? (
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
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerMenuOpen && "overflow-visible",
              )}
              surfaceClassName={cn(
                composerProviderState.composerSurfaceClassName,
                composerMenuOpen ? "overflow-visible" : "overflow-hidden",
              )}
            >
              <div
                className={cn(
                  COMPOSER_EDITOR_PADDING_CLASS_NAME,
                  composerMenuOpen && "overflow-visible",
                )}
              >
                {composerMenuOpen ? (
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
                        loadFailed={
                          folderCatalog.loadFailed
                            ? {
                                onRetry: () => {
                                  void folderCatalog
                                    .reload()
                                    .catch((error) =>
                                      console.error("Provider catalog retry failed", error),
                                    );
                                },
                              }
                            : null
                        }
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
                {pendingUserInputs.length === 0 &&
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
                  value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
                  cursor={composerCursor}
                  terminalContexts={pendingUserInputs.length === 0 ? composerTerminalContexts : []}
                  mentionReferences={selectedComposerMentions}
                  onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                  onChange={onPromptChange}
                  onCommandKeyDown={onComposerCommandKey}
                  onPaste={onComposerPaste}
                  {...(canCollapsePastedTextToDraft
                    ? { onCollapsePastedText: addPastedTextToDraft }
                    : {})}
                  placeholder={
                    activePendingProgress
                      ? activePendingProgress.activeQuestion?.options.length === 0
                        ? "Type your answer to continue"
                        : "Type your own answer, or leave this blank to use the selected option"
                      : hasLiveTurn
                        ? "Ask for follow-up changes"
                        : "Do something"
                  }
                  disabled={isComposerEditorDisabled}
                />
              </div>
              {/* Bottom toolbar. */}
              {
                <div
                  data-chat-composer-footer="true"
                  className={cn("@container", COMPOSER_FOOTER_ROW_CLASS_NAME)}
                >
                  <ComposerFooterActions
                    applicationLeading={renderComposerLeadingControls()}
                    applicationTrailingExpands={isVoiceRecording || isVoiceTranscribing}
                    applicationTrailing={
                      <>
                        {!isVoiceRecording && !isVoiceTranscribing ? composerPickerControls : null}
                        {!isVoiceRecording &&
                        !isVoiceTranscribing &&
                        providerConnectionsQuery.data !== undefined &&
                        (composerConnectionCandidates.length > 0 ||
                          providerConnectionsQuery.data.anonymousRoutes.some(
                            (route) => route.harness === selectedProvider,
                          )) ? (
                          <ComposerConnectionControl
                            provider={selectedProvider}
                            connections={composerConnectionCandidates}
                            authenticationMethods={
                              providerConnectionsQuery.data.authenticationMethods
                            }
                            anonymousRoutes={providerConnectionsQuery.data.anonymousRoutes}
                            selectedConnectionId={selectedConnectionId}
                            onConnectionChange={handleConnectionChange}
                            onManageConnections={handleManageConnections}
                            onSelectionCommitted={scheduleComposerFocus}
                          />
                        ) : null}
                        {showVoiceNotesControl && (isVoiceRecording || isVoiceTranscribing) ? (
                          <>
                            <VoiceRecorderShared
                              disabled={isConnecting || isSendBusy}
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
                            />
                            <ButtonSend
                              type="button"
                              disabled={isConnecting || isSendBusy || isVoiceTranscribing}
                              aria-label={
                                isVoiceTranscribing ? "Transcribing voice note" : "Send voice note"
                              }
                              onClick={sendComposerVoiceRecording}
                            />
                          </>
                        ) : null}
                        {isVoiceRecording || isVoiceTranscribing ? null : activePendingProgress &&
                          !stopping ? (
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
                        ) : hasControllableTurn || stopping ? (
                          <>
                            {idleComposerVoiceControl}
                            <ButtonSend
                              type="button"
                              visualState={stopping ? "stopping" : "stop"}
                              onClick={() => void onInterrupt()}
                              aria-label={stopping ? "Stopping…" : "Stop generation"}
                              data-thread-id={activeThreadId}
                              data-turn-id={activeLatestTurn?.turnId}
                              data-turn-state={activeLatestTurn?.state}
                              title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                            />
                          </>
                        ) : canShowContinue ? (
                          <>
                            {idleComposerVoiceControl}
                            <ButtonSend
                              type="button"
                              visualState="play"
                              aria-label="Continue"
                              title="Continue"
                              onClick={() => void onContinue()}
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
              }
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
      <FolderTabs
        activeThread={activeThread}
        activeComposerProvider={selectedProvider}
        defaultComposerProvider={settings.defaultProvider}
        className={cn(isElectron && "drag-region", desktopTopBarTrafficLightGutterClassName)}
        leftRailCollapsed={!leftRailOpen}
        onRestoreLeftRail={() => setLeftRailOpen(true)}
      />
      {/* Error banner */}
      <ProviderHealthBanner
        status={visibleActiveProviderStatus}
        onDismiss={dismissActiveProviderHealthBanner}
      />
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={dismissActiveThreadError}
        onRetry={() => {
          const connectionId = serverThread?.connectionId;
          const api = readNativeApi();
          if (!connectionId || !api) return;
          void api.provider.retryAuthConnection({ connectionId }).catch((error) =>
            toastManager.add({
              type: "error",
              title: "Could not retry the Connection",
              description: String(error),
            }),
          );
        }}
        onReauthenticate={handleManageConnections}
      />
      <RateLimitBanner
        rateLimitStatus={visibleActiveRateLimitStatus}
        onDismiss={dismissActiveRateLimitBanner}
      />
      {/* Main content area with optional plan sidebar */}
      <ThreadShell>
        {/* Chat column */}
        <div data-p29-thread-content className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                  <div className="w-full">
                    <ChatPerformanceBoundary surface="composer">
                      {composerSection}
                    </ChatPerformanceBoundary>
                  </div>
                </div>
              </ThreadScreenEmpty>
            ) : null}

            {shouldRenderChatPaneContent && !isCenteredEmptyLanding ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatPerformanceBoundary surface="transcript">
                    {shouldRenderTranscriptSurface ? (
                      <ChatTranscriptPane
                        activeThreadId={activeThread.id}
                        activeTurnId={activeThread.session?.activeTurnId ?? null}
                        agentActivityDetail={openAgentActivityDetail}
                        hasMessages={visibleTimelineEntries.length > 0}
                        isWorking={showThinking}
                        activeTurnInProgress={activeTurnInProgress}
                        activeTurnStartedAt={activeWorkStartedAt}
                        listRef={transcriptListRef}
                        crossTaskOrigin={crossTaskOrigin}
                        timelineEntries={visibleTimelineEntries}
                        turns={threadItemsState.turns}
                        transcriptPages={{
                          finals: threadItemsState.finals,
                          segments: threadItemsState.segments,
                          details: threadItemsState.details,
                          outlineCursor: threadItemsState.nextCursor,
                          onExpandedTurnsChange: setExpandedTurns,
                          onLoadOlderTurn: loadOlderTurn,
                        }}
                        onLoadOlder={loadOlderItems}
                        onOpenThread={onNavigateToThread}
                        onRemoveFailedMessage={removeFailedMessage}
                        onExpandTimelineImage={onExpandTimelineImage}
                        onIsAtEndChange={onIsAtEndChange}
                        markdownCwd={workspaceCwd ?? undefined}
                        resolvedTheme={resolvedTheme}
                        chatFontSizePx={settings.chatFontSizePx}
                        timestampFormat={timestampFormat}
                        workspaceRoot={workspaceCwd ?? undefined}
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
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <ThreadDetailHydrationState
                          state={
                            threadDetailHydration === "ready" ? "loading" : threadDetailHydration
                          }
                          onRetry={retryThreadDetailHydration}
                          error={threadItemsError}
                        />
                      </div>
                    )}
                  </ChatPerformanceBoundary>
                </div>

                <div
                  className={cn(
                    "relative z-10 -mt-5 w-full shrink-0 overflow-visible pt-0 sm:pt-0",
                    CHAT_COLUMN_GUTTER_CLASS_NAME,
                    "pb-3 sm:pb-4",
                  )}
                >
                  <ChatPerformanceBoundary surface="composer">
                    {composerSection}
                  </ChatPerformanceBoundary>
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
      <TranscriptSelectionActionLayer
        action={pendingTranscriptSelectionAction}
        onAddToChat={commitTranscriptAssistantSelection}
      />
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </ThreadScreen3Rails>
  );
}
