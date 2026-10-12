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
import type {} from "../types";

export interface NewThreadOptions {
  spaceId?: SpaceId | null;
  provider?: ProviderKind;
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

export function createActiveThreadSnapshot(
  activeThread:
    | {
        modelSelection: ModelSelection;
        folderId: FolderId;
        runtimeMode: RuntimeMode;
      }
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
  return {
    ...activeDraftThread,
  };
}

export function resolveThreadBootstrapPlan(input: {
  latestActiveDraftThread: DraftThreadState | null;
  folderId: FolderId;
  routeThreadId: ThreadId | null;
  storedDraftThread: ({ threadId: ThreadId } & DraftThreadState) | null;
}): ThreadBootstrapPlan {
  if (
    shouldReuseActiveDraftThread({
      draftThread: input.latestActiveDraftThread,
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
  options: NewThreadOptions | undefined;
}): Omit<DraftThreadState, "folderId"> {
  return {
    createdAt: input.createdAt,
    spaceId: input.options?.spaceId ?? null,
    runtimeMode: DEFAULT_RUNTIME_MODE,
  };
}

export function hasDraftContextOverrides(options?: NewThreadOptions): boolean {
  return options?.spaceId !== undefined;
}

export function buildDraftThreadContextPatch(options?: NewThreadOptions): {
  spaceId?: SpaceId | null;
} | null {
  if (!hasDraftContextOverrides(options)) return null;
  return {
    ...(options?.spaceId !== undefined ? { spaceId: options.spaceId ?? null } : {}),
  };
}

export function shouldReuseActiveDraftThread(input: {
  draftThread: DraftThreadState | null;
  folderId: FolderId;
  routeThreadId: ThreadId | null;
}): input is {
  draftThread: DraftThreadState;
  folderId: FolderId;
  routeThreadId: ThreadId;
} {
  return Boolean(
    input.draftThread && input.routeThreadId && input.draftThread.folderId === input.folderId,
  );
}
