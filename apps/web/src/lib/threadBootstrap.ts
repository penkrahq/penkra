import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type FolderId,
  type ProviderKind,
  type RuntimeMode,
  type SpaceId,
  type ThreadId,
} from "@penkra/contracts";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  resolvePreferredComposerModelSelection,
} from "../composerDraftStore";
import { type Thread, type ThreadPrimarySurface } from "../types";

export interface NewThreadOptions {
  spaceId?: SpaceId | null;
  workingDirectory?: string | null;
  entryPoint?: ThreadPrimarySurface;
  provider?: ProviderKind;
  fresh?: boolean;
}

export function scopeNewThreadOptionsToParentSpace(
  options: NewThreadOptions | undefined,
  parentSpaceId: SpaceId | null,
): NewThreadOptions {
  return { ...options, spaceId: parentSpaceId };
}

export function scopeNewThreadOptionsToContainer(input: {
  options: NewThreadOptions | undefined;
  containerSpaceId: SpaceId | null;
}): NewThreadOptions | undefined {
  return scopeNewThreadOptionsToParentSpace(input.options, input.containerSpaceId);
}

export function requireNewThreadSpaceId(spaceId: SpaceId | null): SpaceId {
  if (spaceId === null) throw new Error("Choose a persisted Space before starting this chat.");
  return spaceId;
}

export interface InheritedThreadContext {
  workingDirectory: string | null;
}

export function resolveRecentParentWorkingDirectory(input: {
  folderId: FolderId;
  threads: ReadonlyArray<Pick<Thread, "folderId" | "workingDirectory" | "createdAt">>;
}): string | null {
  const matching = input.threads.filter(
    (thread) => thread.folderId === input.folderId && Boolean(thread.workingDirectory?.trim()),
  );
  const latest = matching.reduce<(typeof matching)[number] | null>(
    (current, candidate) =>
      !current || candidate.createdAt.localeCompare(current.createdAt) > 0 ? candidate : current,
    null,
  );
  return latest?.workingDirectory?.trim() || null;
}

export function resolveInheritedThreadContext(input: {
  activeThread: Pick<Thread, "workingDirectory"> | null | undefined;
  activeDraftThread: Pick<DraftThreadState, "workingDirectory"> | null | undefined;
}): InheritedThreadContext {
  return {
    workingDirectory:
      input.activeDraftThread?.workingDirectory ?? input.activeThread?.workingDirectory ?? null,
  };
}

interface ActiveThreadSnapshot {
  folderId: FolderId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

export interface DraftReusePlanStored {
  draftThread: DraftThreadState;
  kind: "stored";
  threadId: ThreadId;
}
export interface DraftReusePlanRoute {
  draftThread: DraftThreadState;
  kind: "route";
  threadId: ThreadId;
}
export interface DraftReusePlanFresh {
  kind: "fresh";
}
export type ThreadBootstrapPlan = DraftReusePlanStored | DraftReusePlanRoute | DraftReusePlanFresh;

interface ResolveTerminalThreadCreationStateInput {
  activeDraftThread: DraftThreadState | null;
  activeThread: ActiveThreadSnapshot | null;
  defaultProvider?: ProviderKind | null | undefined;
  draftComposerState: ComposerThreadDraftState | null;
  draftThread: DraftThreadState | null;
  options: NewThreadOptions | undefined;
  projectDefaultModelSelection: ModelSelection | null;
  folderId: FolderId;
}

export interface TerminalThreadCreationState {
  spaceId: SpaceId | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  workingDirectory: string | null;
}

export function createActiveThreadSnapshot(
  activeThread:
    | { modelSelection: ModelSelection; folderId: FolderId; runtimeMode: RuntimeMode }
    | null
    | undefined,
  folderId: FolderId,
): ActiveThreadSnapshot | null {
  if (!activeThread || activeThread.folderId !== folderId) return null;
  return {
    folderId: activeThread.folderId,
    modelSelection: activeThread.modelSelection,
    runtimeMode: activeThread.runtimeMode,
  };
}

export function createActiveDraftThreadSnapshot(
  activeDraftThread: DraftThreadState | null | undefined,
  folderId: FolderId,
): DraftThreadState | null {
  if (!activeDraftThread || activeDraftThread.folderId !== folderId) return null;
  return { ...activeDraftThread, workingDirectory: activeDraftThread.workingDirectory ?? null };
}

export function resolveThreadBootstrapPlan(input: {
  entryPoint: ThreadPrimarySurface;
  latestActiveDraftThread: DraftThreadState | null;
  folderId: FolderId;
  routeThreadId: ThreadId | null;
  storedDraftThread: ({ threadId: ThreadId } & DraftThreadState) | null;
}): ThreadBootstrapPlan {
  if (
    shouldReuseActiveDraftThread({
      draftThread: input.latestActiveDraftThread,
      entryPoint: input.entryPoint,
      folderId: input.folderId,
      routeThreadId: input.routeThreadId,
    })
  ) {
    return {
      kind: "route",
      threadId: input.routeThreadId!,
      draftThread: input.latestActiveDraftThread!,
    };
  }
  if (input.storedDraftThread) {
    return {
      kind: "stored",
      threadId: input.storedDraftThread.threadId,
      draftThread: input.storedDraftThread,
    };
  }
  return { kind: "fresh" };
}

export function createFreshDraftThreadSeed(input: {
  createdAt: string;
  entryPoint: ThreadPrimarySurface;
  options: NewThreadOptions | undefined;
}): Omit<DraftThreadState, "folderId"> {
  return {
    createdAt: input.createdAt,
    spaceId: input.options?.spaceId ?? null,
    workingDirectory: input.options?.workingDirectory ?? null,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    entryPoint: input.entryPoint,
  };
}

export function hasDraftContextOverrides(options?: NewThreadOptions): boolean {
  return options?.spaceId !== undefined || options?.workingDirectory !== undefined;
}

export function buildDraftThreadContextPatch(
  entryPoint: ThreadPrimarySurface,
  options?: NewThreadOptions,
): {
  spaceId?: SpaceId | null;
  entryPoint: ThreadPrimarySurface;
  workingDirectory?: string | null;
} | null {
  if (!hasDraftContextOverrides(options)) return null;
  return {
    ...(options?.spaceId !== undefined ? { spaceId: options.spaceId ?? null } : {}),
    ...(options?.workingDirectory !== undefined
      ? { workingDirectory: options.workingDirectory ?? null }
      : {}),
    entryPoint,
  };
}

export function shouldReuseActiveDraftThread(input: {
  draftThread: DraftThreadState | null;
  entryPoint: ThreadPrimarySurface;
  folderId: FolderId;
  routeThreadId: ThreadId | null;
}): input is {
  draftThread: DraftThreadState;
  entryPoint: ThreadPrimarySurface;
  folderId: FolderId;
  routeThreadId: ThreadId;
} {
  return Boolean(
    input.draftThread &&
    input.routeThreadId &&
    input.draftThread.folderId === input.folderId &&
    input.draftThread.entryPoint === input.entryPoint,
  );
}

export function resolveTerminalThreadCreationState(
  input: ResolveTerminalThreadCreationStateInput,
): TerminalThreadCreationState {
  return {
    spaceId: input.options?.spaceId ?? input.draftThread?.spaceId ?? null,
    modelSelection: resolvePreferredComposerModelSelection({
      draft: input.draftComposerState,
      threadModelSelection:
        input.activeThread?.folderId === input.folderId ? input.activeThread.modelSelection : null,
      projectModelSelection: input.projectDefaultModelSelection,
      defaultProvider: input.defaultProvider,
    }),
    runtimeMode:
      input.draftThread?.runtimeMode ??
      (input.activeThread?.folderId === input.folderId ? input.activeThread.runtimeMode : null) ??
      (input.activeDraftThread?.folderId === input.folderId
        ? input.activeDraftThread.runtimeMode
        : null) ??
      DEFAULT_RUNTIME_MODE,
    workingDirectory:
      input.options?.workingDirectory ?? input.draftThread?.workingDirectory ?? null,
  };
}
