// FILE: types.ts
// Purpose: Shared web-app view models for threads, projects, terminal layout, and sidebar rows.
// Exports: Runtime UI types consumed across store, routes, and components.

import type {
  ModelSelection,
  MessageDispatchOrigin,
  OrchestrationMessageSource,
  OrchestrationPendingInteraction,
  TurnDispatchMode,
  OrchestrationLatestTurn,
  OrchestrationThreadPullRequest,
  PinnedMessage,
  ThreadMarker,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ContainerId,
  SpaceId,
  SpaceIconName,
  TurnId,
  MessageId,
  ProviderMentionReference,
  ProviderSkillReference,
  ProviderKind,
  CheckpointRef,
  ContainerKind,
  RuntimeMode,
  ThreadCreationSource,
  ThreadEnvironmentMode,
} from "@penkra/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 6;
export type ThreadTerminalPresentationMode = "drawer" | "workspace";
export type ThreadTerminalWorkspaceTab = "terminal" | "chat";
export type ThreadTerminalWorkspaceLayout = "both" | "terminal-only";
export type ThreadPrimarySurface = "chat" | "terminal";
export type ProjectScript = ContractProjectScript;

export type ThreadTerminalSplitDirection = "horizontal" | "vertical";
export type ThreadTerminalSplitPosition = "top" | "right" | "bottom" | "left";

export interface ThreadTerminalLeafNode {
  type: "terminal";
  paneId: string;
  terminalIds: string[];
  activeTerminalId: string;
}

export interface ThreadTerminalSplitNode {
  type: "split";
  id: string;
  direction: ThreadTerminalSplitDirection;
  children: ThreadTerminalLayoutNode[];
  weights: number[];
}

export type ThreadTerminalLayoutNode = ThreadTerminalLeafNode | ThreadTerminalSplitNode;

export interface ThreadTerminalGroup {
  id: string;
  activeTerminalId: string;
  layout: ThreadTerminalLayoutNode;
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface ChatFileAttachment {
  type: "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ChatAssistantSelectionAttachment {
  type: "assistant-selection";
  id: string;
  assistantMessageId: string;
  text: string;
}

export type ChatAttachment =
  | ChatImageAttachment
  | ChatFileAttachment
  | ChatAssistantSelectionAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  skills?: ProviderSkillReference[];
  mentions?: ProviderMentionReference[];
  dispatchMode?: TurnDispatchMode;
  dispatchOrigin?: MessageDispatchOrigin;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
  source?: OrchestrationMessageSource;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
  checkpointTurnCounts?: number[] | undefined;
}

export interface Project {
  id: ContainerId;
  kind: ContainerKind;
  name: string;
  remoteName: string;
  folderName: string;
  localName: string | null;
  cwd: string;
  defaultModelSelection: ModelSelection | null;
  expanded: boolean;
  isPinned?: boolean;
  /** Missing on renderer state written before Spaces; normalized snapshots always set it. */
  spaceId?: SpaceId | null;
  sidebarSortOrder?: number;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Space {
  id: SpaceId;
  name: string;
  icon: SpaceIconName;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadWorkspaceState {
  envMode?: ThreadEnvironmentMode | undefined;
  branch: string | null;
  worktreePath: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  createBranchFlowCompleted?: boolean;
}

export interface ThreadWorkspacePatch {
  envMode?: ThreadEnvironmentMode | undefined;
  branch?: string | null;
  worktreePath?: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  createBranchFlowCompleted?: boolean;
}

export interface Thread extends ThreadWorkspaceState {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ContainerId;
  spaceId?: SpaceId | null;
  sidebarSortOrder?: number;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  error: string | null;
  createdAt: string;
  archivedAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  pinnedMessages?: PinnedMessage[];
  threadMarkers?: ThreadMarker[];
  notes?: string;
  latestTurn: OrchestrationLatestTurn | null;
  pendingTurnStartMessageId?: MessageId | null;
  lastVisitedAt?: string | undefined;
  parentThreadId?: ThreadId | null;
  creationSource?: ThreadCreationSource | null;
  sourceThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  forkSourceThreadId?: ThreadId | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  pendingInteractions?: OrchestrationPendingInteraction[];
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface ThreadShell extends ThreadWorkspaceState {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ContainerId;
  spaceId?: SpaceId | null;
  sidebarSortOrder?: number;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  error: string | null;
  createdAt: string;
  archivedAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  // Per-thread workspace annotations carried through the normalized projection so
  // `getThreadFromState` reconstructs them (the shell is the source of truth for a Thread).
  // These do not arrive on the sidebar shell snapshot, so the snapshot path preserves them
  // from the previous shell rather than clobbering with `undefined`.
  pinnedMessages?: PinnedMessage[];
  threadMarkers?: ThreadMarker[];
  notes?: string;
  parentThreadId?: ThreadId | null;
  creationSource?: ThreadCreationSource | null;
  sourceThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  forkSourceThreadId?: ThreadId | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  pendingInteractions?: OrchestrationPendingInteraction[];
  lastVisitedAt?: string | undefined;
}

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
  pendingTurnStartMessageId?: MessageId | null;
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ContainerId;
  spaceId?: SpaceId | null;
  sidebarSortOrder?: number;
  title: string;
  modelSelection: ModelSelection;
  envMode?: ThreadEnvironmentMode | undefined;
  branch: string | null;
  worktreePath: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  latestTurn: OrchestrationLatestTurn | null;
  lastVisitedAt?: string | undefined;
  parentThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  forkSourceThreadId?: ThreadId | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
}

/** Lightweight composer identity that ignores live turn/status churn. */
export interface ComposerThreadMentionSource {
  id: ThreadId;
  projectId: ContainerId;
  title: string;
  provider: ProviderKind;
  createdAt: string;
  archivedAt?: string | null;
  lastVisitedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
