import { type FolderId, ThreadId } from "@penkra/contracts";
import { getDefaultModel } from "@penkra/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { startTransition } from "react";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createFreshDraftThreadSeed,
  resolveThreadBootstrapPlan,
  scopeNewThreadOptionsToContainer,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "../lib/stagedDraftNavigation";
import { newCommandId, newThreadId } from "../lib/utils";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";

export function useHandleNewThread() {
  const folders = useStore((store) => store.folders);
  const navigate = useNavigate();
  const router = useRouter();
  const { activeDraftThread, activeFolderId, activeThread, focusedThreadId, routeThreadId } =
    useFocusedChatContext();

  const handleNewThread = (
    folderId: FolderId,
    requestedOptions?: NewThreadOptions,
  ): Promise<ThreadId | null> => {
    const currentState = useStore.getState();
    const targetProject = currentState.folders.find((project) => project.id === folderId);
    // A virtual Folder is always owned by exactly one Space. Make that durable
    // parent authoritative for every draft created inside it.
    const parentScopedOptions =
      targetProject === undefined
        ? requestedOptions
        : scopeNewThreadOptionsToContainer({
            options: requestedOptions,
            containerSpaceId: targetProject.spaceId,
          });
    const options = parentScopedOptions;
    const applyProviderOverride = (threadId: ThreadId) => {
      if (!options?.provider) {
        return;
      }
      const defaultModel = getDefaultModel(options.provider);
      if (!defaultModel) {
        return;
      }
      setModelSelection(threadId, {
        provider: options.provider,
        model: defaultModel,
      });
    };
    const restoreComposerDraft = (
      threadId: ThreadId,
      draftState: ComposerThreadDraftState | null,
    ) => {
      if (!draftState) {
        return;
      }
      useComposerDraftStore.setState((state) => {
        if (state.draftsByThreadId[threadId] === draftState) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: draftState,
          },
        };
      });
    };
    const {
      getDraftThread,
      getDraftThreadByFolderId,
      applyStickyState,
      clearDraftThread,
      registerDraftThread,
      setDraftThreadContext,
      setProjectDraftThreadId,
      setModelSelection,
    } = useComposerDraftStore.getState();

    const storedDraftThreadCandidate = getDraftThreadByFolderId(folderId);
    const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
      ? getDraftThread(focusedThreadId)
      : null;
    const storedDraftThread = storedDraftThreadCandidate;
    const latestActiveDraftThread = latestActiveDraftThreadCandidate;
    const bootstrapPlan = resolveThreadBootstrapPlan({
      storedDraftThread,
      latestActiveDraftThread,
      folderId,
      routeThreadId: focusedThreadId,
    });
    if (bootstrapPlan.kind === "stored") {
      return (async (): Promise<ThreadId> => {
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        const draftContextPatch = buildDraftThreadContextPatch(options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(folderId, bootstrapPlan.threadId, {});

        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        if (focusedThreadId === bootstrapPlan.threadId) {
          return bootstrapPlan.threadId;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: bootstrapPlan.threadId },
          search: () => ({}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        return bootstrapPlan.threadId;
      })();
    }

    if (bootstrapPlan.kind === "route") {
      return (async (): Promise<ThreadId> => {
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        const draftContextPatch = buildDraftThreadContextPatch(options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(folderId, bootstrapPlan.threadId, {});

        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        return bootstrapPlan.threadId;
      })();
    }

    const navigationContainer = { kind: "folder" as const, id: folderId };
    return runDraftNavigationOnce(draftNavigationSlotKey(navigationContainer), async () => {
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const draftSeed = createFreshDraftThreadSeed({
        createdAt,
        options,
      });
      const committed = await stageDraftNavigation({
        // Keep the previous routed draft alive while the destination loads. Replacing the
        // project's primary slot earlier makes the route guard redirect the old URL to Home.
        stage: () => {
          registerDraftThread(threadId, { folderId, ...draftSeed });
          applyStickyState(threadId);
          applyProviderOverride(threadId);
        },
        // Keep the routed surface available until the locally complete draft
        // surface can commit. A fresh draft never needs a loading placeholder:
        // all state required by its empty composer was staged above.
        navigate: () =>
          new Promise<void>((resolve, reject) => {
            startTransition(() => {
              navigate({
                to: "/$threadId",
                params: { threadId },
                search: () => ({}),
              }).then(resolve, reject);
            });
          }),
        // TanStack resolves an older navigate() promise when a newer navigation supersedes it.
        // Register the new folder draft only after its route is active.
        isDestinationActive: () => router.state.location.pathname === `/${threadId}`,
        finalize: () => {
          setProjectDraftThreadId(folderId, threadId, draftSeed);
        },
        rollback: () => {
          clearDraftThread(threadId);
        },
      });
      if (!committed) {
        return null;
      }
      return threadId;
    });
  };

  return {
    activeDraftThread,
    activeFolderId,
    activeThread,
    activeContextThreadId: focusedThreadId,
    handleNewThread,
    folders,
    routeThreadId,
  };
}
