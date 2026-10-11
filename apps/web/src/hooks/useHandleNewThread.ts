import { Schema } from "effect";
import { RuntimeMode } from "@penkra/contracts";
import { getThreadListById } from "../threadListStore";
import { ProviderKind, type FolderId, ThreadId } from "@penkra/contracts";
import { getDefaultModel } from "@penkra/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { startTransition } from "react";
import { useAppSettings } from "../appSettings";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  scopeNewThreadOptionsToContainer,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import { promoteThreadCreate } from "../lib/threadCreatePromotion";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "../lib/stagedDraftNavigation";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";

export function useHandleNewThread() {
  const folders = useStore((store) => store.folders);
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const router = useRouter();
  const { activeDraftThread, activeFolderId, activeThread, focusedThreadId, routeThreadId } =
    useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((store) => store.openTerminalThreadPage);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);

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
    const entryPoint = options?.entryPoint ?? "chat";
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
    const activateThreadEntryPoint = (threadId: ThreadId) => {
      if (entryPoint === "terminal") {
        openTerminalThreadPage(threadId, { terminalOnly: true });
        return;
      }
      openChatThreadPage(threadId);
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
    // Terminal entry always creates a durable Thread. It never reopens or
    // promotes an old terminal draft slot.
    const shouldForceFreshThread = options?.fresh === true || entryPoint === "terminal";

    const storedDraftThreadCandidate = getDraftThreadByFolderId(folderId, entryPoint);
    const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
      ? getDraftThread(focusedThreadId)
      : null;
    const storedDraftThread = !shouldForceFreshThread ? storedDraftThreadCandidate : null;
    const latestActiveDraftThread: DraftThreadState | null = !shouldForceFreshThread
      ? latestActiveDraftThreadCandidate
      : null;
    const bootstrapPlan = resolveThreadBootstrapPlan({
      storedDraftThread,
      latestActiveDraftThread,
      entryPoint,
      folderId,
      routeThreadId: focusedThreadId,
    });
    // Read from the store at call time so post-sync sidebar flows can use the latest project defaults.
    const projectDefaultModelSelection =
      useStore.getState().folders.find((project) => project.id === folderId)
        ?.defaultModelSelection ?? null;
    const activeRow = focusedThreadId ? getThreadListById().get(focusedThreadId) : undefined;
    const activeThreadSnapshot = createActiveThreadSnapshot(
      activeRow === undefined
        ? null
        : {
            folderId: activeRow.folderId,
            modelSelection: {
              provider: Schema.decodeUnknownSync(ProviderKind)(activeRow.provider),
              model: activeRow.model,
              ...(activeRow.modelOptions === null
                ? {}
                : { options: JSON.parse(activeRow.modelOptions) }),
            },
            runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(activeRow.runtimeMode),
          },
      folderId,
    );
    const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(activeDraftThread, folderId);
    const resolveCreationState = (
      targetThreadId: ThreadId,
      draftThread: DraftThreadState | null,
      creationOptions: NewThreadOptions | undefined,
    ) =>
      resolveTerminalThreadCreationState({
        activeDraftThread: activeDraftThreadSnapshot,
        activeThread: activeThreadSnapshot,
        defaultProvider: options?.provider ?? settings.defaultProvider,
        draftComposerState:
          useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
        draftThread,
        options: creationOptions,
        projectDefaultModelSelection,
        folderId,
      });
    // Terminal-first threads need a real orchestration thread immediately so
    // the sidebar can render them as durable rows instead of draft-only routes.
    const createTerminalThread = async (
      threadId: ThreadId,
      creationState: ReturnType<typeof resolveCreationState>,
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await promoteThreadCreate(
        {
          creator: { kind: "user" },
          connection: { kind: "default" },
          threadId,

          folderId,
          title: "New terminal",
          modelSelection: creationState.modelSelection,
          runtimeMode: creationState.runtimeMode,
          createdAt: new Date().toISOString(),
        },
        api,
      );
    };
    if (bootstrapPlan.kind === "stored") {
      return (async (): Promise<ThreadId> => {
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedStoredDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const shouldPreserveStoredTerminalContext =
          entryPoint === "terminal" && bootstrapPlan.draftThread.entryPoint === "terminal";
        const draftContextPatch = shouldPreserveStoredTerminalContext
          ? null
          : buildDraftThreadContextPatch(entryPoint, options);
        const creationOptions = shouldPreserveStoredTerminalContext ? undefined : options;
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(folderId, bootstrapPlan.threadId, { entryPoint });

        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (focusedThreadId === bootstrapPlan.threadId) {
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(
                bootstrapPlan.threadId,
                resolvedStoredDraftThread,
                creationOptions,
              ),
            );
          }
          return bootstrapPlan.threadId;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: bootstrapPlan.threadId },
          search: () => ({}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(
              bootstrapPlan.threadId,
              resolvedStoredDraftThread,
              creationOptions,
            ),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    if (bootstrapPlan.kind === "route") {
      return (async (): Promise<ThreadId> => {
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedActiveDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const draftContextPatch = buildDraftThreadContextPatch(entryPoint, options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(folderId, bootstrapPlan.threadId, { entryPoint });

        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(bootstrapPlan.threadId, resolvedActiveDraftThread, options),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    const navigationContainer = { kind: "folder" as const, id: folderId };
    return runDraftNavigationOnce(
      draftNavigationSlotKey(navigationContainer, entryPoint),
      async () => {
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const draftSeed = createFreshDraftThreadSeed({
          createdAt,
          entryPoint,
          options,
        });
        const committed = await stageDraftNavigation({
          // Keep the previous routed draft alive while the destination loads. Replacing the
          // project's primary slot earlier makes the route guard redirect the old URL to Home.
          stage: () => {
            registerDraftThread(threadId, { folderId, ...draftSeed });
            activateThreadEntryPoint(threadId);
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
            clearTerminalState(threadId);
          },
        });
        if (!committed) {
          return null;
        }
        if (entryPoint === "terminal") {
          await createTerminalThread(
            threadId,
            resolveCreationState(threadId, getDraftThread(threadId), options),
          );
        }
        return threadId;
      },
    );
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
