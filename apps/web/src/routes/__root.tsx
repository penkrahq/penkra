import { applyFolderAppTabs } from "../rightDockStore";
import type { AppState } from "../storeState";
import { upsertSpace, upsertProject } from "../storeProjection";
import { applyThreadRow, subscribeThreadRowChanges } from "../threadListStore";
import { useThreadSummary } from "../threadListStore";
import {
  ThreadId,
  type OrchestrationSyncStreamItem,
  type ServerConfig,
  type WsCompatibilityError,
} from "@penkra/contracts";
import {} from "@penkra/shared/terminalThreads";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useMemo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { DesktopWindowControls } from "../components/DesktopWindowControls";
import { DesktopActiveWorkPowerSync } from "../components/DesktopActiveWorkPowerSync";
import { DesktopThreadApiBridge } from "../components/DesktopThreadApiBridge";
import { DesktopOnboardingGate } from "../components/onboarding/DesktopOnboardingGate";
import { FeedbackDialog } from "../components/FeedbackDialog";
import ShortcutsDialog from "../components/ShortcutsDialog";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { useWhatsNew } from "../whatsNew/useWhatsNew";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import {} from "../components/ChatView.logic";
import { Button, dialogActionButtonClassName } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { ServerConfigUpdateNotifications } from "../components/ServerConfigUpdateNotifications";
import { useFocusedChatContext } from "../focusedChatContext";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import type { FeedbackThreadContext } from "../feedback";
import {
  reconcileServerProviderStatuses,
  refreshServerConfigAfterTransportOpen,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "../lib/serverReactQuery";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { advanceComposerSendPreflightAppliedSequence } from "../composerSendPreflight";
import {
  recordChatLifecycleSyncDiagnostic,
  recordChatSyncPublicationDiagnostic,
} from "../chatLifecycleDiagnostics";
import { recordChatPaginationDiagnostic } from "../chatScrollDiagnostics";
import { useStore } from "../store";
import {
  onServerProviderStatusesUpdated,
  onServerSettingsUpdated,
  onServerWelcome,
} from "../wsNativeApi";
import {
  addWsCompatibilityIssueListener,
  addWsTransportStateListener,
  readLatestWsCompatibilityIssue,
} from "../wsTransportEvents";
import { invalidateProjectQueriesForWorkspaceChange } from "../lib/projectReactQuery";
import { VoiceSessionCoordinatorProvider } from "../voiceSessionCoordinator";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { setVisibleThreadDetailIds } from "../threadDetailSubscriptionRetention";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import { useAppDensity } from "../hooks/useAppDensity";
import { useAppTypography } from "../hooks/useAppTypography";
import { usePreloadRouteChunks } from "../hooks/usePreloadRouteChunks";
import { useSyncDesktopTopBarTrafficLightGutterZoom } from "../hooks/useDesktopTopBarGutter";
import { useTheme } from "../hooks/useTheme";
import { useNativeFontSmoothing } from "../hooks/useNativeFontSmoothing";
import { invalidateProviderData } from "../lib/providerDataRefresh";
import { providerModelDiscoveryInvalidationFingerprint } from "../lib/providerDiscoveryInvalidation";
import { ConnectionDefaultsMigration } from "../components/ConnectionDefaultsMigration";
const ORCHESTRATION_SYNC_PUBLICATION_INTERVAL_MS = 50;
const ORCHESTRATION_SYNC_APPLICATION_RECOVERY_DELAYS_MS = [0, 250, 1_000] as const;

interface ThreadStartedState {
  readonly latestTurn: unknown | null;
  readonly session: unknown | null;
}

function shellThreadHasStarted(thread: ThreadStartedState): boolean {
  return thread.latestTurn !== null || thread.session !== null;
}

interface PromotedDraftThreadDetail extends ThreadStartedState {
  readonly id: ThreadId;
  readonly messages: ReadonlyArray<unknown>;
}

function detailThreadHasStarted(thread: PromotedDraftThreadDetail): boolean {
  return shellThreadHasStarted(thread) || thread.messages.length > 0;
}

function reconcilePromotedDraftFromThreadDetail(thread: PromotedDraftThreadDetail): void {
  markPromotedDraftThreads(new Set([thread.id]));
  if (detailThreadHasStarted(thread)) {
    finalizePromotedDraftThreads(new Set([thread.id]));
  }
}

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  useAppTypography();
  useAppDensity();
  usePreloadRouteChunks();
  useNativeFontSmoothing();
  useSyncDesktopTopBarTrafficLightGutterZoom();
  useTheme();
  const [compatibilityIssue, setCompatibilityIssue] = useState<WsCompatibilityError | null>(() =>
    readLatestWsCompatibilityIssue(),
  );
  useEffect(
    () =>
      addWsCompatibilityIssueListener(setCompatibilityIssue, {
        replayCurrent: true,
      }),
    [],
  );

  // Single mount point for the Windows caption buttons. The cluster is pinned to the
  // window's top-right corner (frameless Windows shell) and renders nothing on macOS,
  // Linux, or the web build, so it is safe to mount unconditionally here — including on
  // the pre-backend "connecting" screen, so the window stays closable before the
  // renderer connects. Top bars reserve space for it via
  // useDesktopTopBarWindowControlsGutterClassName().
  //
  // MUST render LAST: Electron builds the OS drag region by walking elements with
  // `-webkit-app-region` in DOM order, unioning `drag` rects and subtracting `no-drag`
  // rects in sequence. The route headers are full-width `drag-region`s that extend under
  // this cluster, so the cluster's `no-drag` rect has to be subtracted AFTER those drag
  // rects are added — otherwise the OS reclaims the corner as title-bar caption and
  // swallows the click as a window drag (the buttons render but do nothing). Rendering
  // it last in document order guarantees that subtraction wins. (z above dialogs/toasts
  // so it also stays clickable while a modal is open.)
  const desktopWindowControls = <DesktopWindowControls className="fixed top-0 right-0 z-[250]" />;

  if (compatibilityIssue) {
    return (
      <>
        <TransportCompatibilityView issue={compatibilityIssue} />
        {desktopWindowControls}
      </>
    );
  }

  if (!readNativeApi()) {
    return (
      <>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground">
              Connecting to {APP_DISPLAY_NAME} server...
            </p>
          </div>
        </div>
        {desktopWindowControls}
      </>
    );
  }

  return (
    <>
      <DesktopOnboardingGate>
        <ToastProvider position="top-center">
          <VoiceSessionCoordinatorProvider>
            <AnchoredToastProvider>
              <DesktopActiveWorkPowerSync />
              <DesktopThreadApiBridge />
              <ServerConfigUpdateNotifications />
              <EventRouter />
              <GlobalShortcutsDialog />
              <GlobalFeedbackDialog />
              <GlobalWhatsNewSurface />
              <TaskCompletionNotifications />
              <ConnectionDefaultsMigration />
              <Outlet />
            </AnchoredToastProvider>
          </VoiceSessionCoordinatorProvider>
        </ToastProvider>
      </DesktopOnboardingGate>
      {desktopWindowControls}
    </>
  );
}

function TransportCompatibilityView({ issue }: { issue: WsCompatibilityError }) {
  const title =
    issue.action === "update-client"
      ? "This Penkra client needs an update."
      : issue.action === "update-server"
        ? "The Penkra server needs an update."
        : "Penkra needs to reconnect with a matching build.";
  const guidance =
    issue.action === "update-client"
      ? "Update or reload this client, then reconnect."
      : issue.action === "update-server"
        ? "Update or restart the server, then reload this client."
        : "Reload the app. If this repeats, restart Penkra so the client and server use matching builds.";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[length:var(--app-font-size-ui-sm,11px)] font-semibold text-muted-foreground">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{title}</h1>
        <p className="mt-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-relaxed text-muted-foreground">
          {issue.message}
        </p>
        <p className="mt-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-relaxed text-muted-foreground">
          {guidance}
        </p>
        <p className="mt-4 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/80">
          Client {APP_VERSION} · Server {issue.serverBuild}
        </p>
        <div className="mt-5">
          <Button
            size="sm"
            className={dialogActionButtonClassName}
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
      </section>
    </div>
  );
}

function GlobalShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const { focusedThreadId, activeProject } = useFocusedChatContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "show-shortcuts") {
        setOpen(true);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return (
    <ShortcutsDialog
      open={open}
      onOpenChange={setOpen}
      keybindings={keybindings}
      platform={platform}
      context={{}}
    />
  );
}

function GlobalFeedbackDialog() {
  const { activeProject, activeThread, focusedThreadId } = useFocusedChatContext();
  const activeRow = useThreadSummary(focusedThreadId);
  const isOpen = useFeedbackDialogStore((state) => state.isOpen);
  const requestedContext = useFeedbackDialogStore((state) => state.context);
  const setOpen = useFeedbackDialogStore((state) => state.setOpen);
  const context: FeedbackThreadContext = requestedContext ?? {
    provider: activeThread?.modelSelection.provider ?? null,
    model: activeThread?.modelSelection.model ?? null,
    projectKind: activeProject ? "folder" : null,
    runtimeMode: activeRow?.runtimeMode ?? null,
    sessionStatus: activeThread?.session?.status ?? null,
    latestTurnState: activeThread?.latestTurn?.state ?? null,
    messageCount: activeThread?.messages.length ?? 0,
    activityCount: activeThread?.activities.length ?? 0,
    hasPendingUserInput: activeThread?.hasPendingUserInput === true,
    hasThreadError: Boolean(activeThread?.error),
  };

  return <FeedbackDialog open={isOpen} context={context} onOpenChange={setOpen} />;
}

function GlobalWhatsNewSurface() {
  // Single mount point per app session. The hook owns the "popout visible" and
  // "dialog open" booleans and the seen-marker persistence; this component is
  // just the plumbing that renders them together so they share one entry.
  const {
    currentEntry,
    allEntries,
    currentVersion,
    isPopoutVisible,
    isDialogOpen,
    openDialog,
    dismissPopout,
    onDialogOpenChange,
  } = useWhatsNew();

  if (!currentEntry) {
    // Silent-bootstrap or noop — nothing to render on either surface.
    return null;
  }

  return (
    <>
      {isPopoutVisible && (
        <WhatsNewPopoutCard
          entry={currentEntry}
          currentVersion={currentVersion}
          onOpen={openDialog}
          onDismiss={dismissPopout}
        />
      )}
      <WhatsNewDialog
        open={isDialogOpen}
        onOpenChange={onDialogOpenChange}
        currentEntry={currentEntry}
        allEntries={allEntries}
        currentVersion={currentVersion}
      />
    </>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[length:var(--app-font-size-ui-sm,11px)] font-semibold text-muted-foreground">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Something went wrong.</h1>
        <p className="mt-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-relaxed text-muted-foreground">
          {message}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" className={dialogActionButtonClassName} onClick={() => reset()}>
            Try again
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={dialogActionButtonClassName}
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-[length:var(--app-font-size-ui,12px)] font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function EventRouter() {
  useEffect(
    () =>
      ensureNativeApi().cleanCore.onSidebarChange((change) => {
        if (change.kind === "folder.appTabs") {
          applyFolderAppTabs(change);
          return;
        }
        if (change.kind !== "navigation.restored") return;
        useStore.setState((state) => {
          let next: AppState = state;
          for (const space of change.spaces) next = upsertSpace(next, space);
          for (const folder of change.folders) next = upsertProject(next, folder, "id-only");
          return next;
        });
      }),
    [],
  );
  const syncServerStartupSnapshot = useStore((store) => store.syncServerStartupSnapshot);
  const syncServerThreadTurnsPage = useStore((store) => store.syncServerThreadTurnsPage);
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const setServerWorkspacePaths = useWorkspacePathsStore((store) => store.setServerWorkspacePaths);
  const serverThreadIdList = useStore((store) => store.threadIds);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const visibleThreadIds = useMemo(() => (routeThreadId ? [routeThreadId] : []), [routeThreadId]);
  const serverThreadIds = useMemo(() => new Set(serverThreadIdList ?? []), [serverThreadIdList]);
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const previouslyVisibleThreadIdsRef = useRef<ReadonlySet<ThreadId>>(new Set());
  const seenThreadIdsRef = useRef<Set<ThreadId>>(new Set());

  useEffect(() => {
    pathnameRef.current = pathname;
    setVisibleThreadDetailIds(visibleThreadIds);
  }, [pathname, visibleThreadIds]);

  useLayoutEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const previouslyVisibleThreadIds = previouslyVisibleThreadIdsRef.current;
    previouslyVisibleThreadIdsRef.current = new Set(visibleThreadIds);
    for (const threadId of visibleThreadIds) {
      // Opening a persisted thread loads its per-thread metadata first; detail
      // pages can attach only after that targeted read supplies the thread.
      if (!serverThreadIds.has(threadId)) continue;
      const state = useStore.getState();
      const wasSeen = seenThreadIdsRef.current.has(threadId);
      seenThreadIdsRef.current.add(threadId);
      const isReopened = wasSeen && !previouslyVisibleThreadIds.has(threadId);
      if (!isReopened && state.threadDetailSyncById?.[threadId] === "synced") continue;
      recordChatPaginationDiagnostic({
        event: "visible-reconcile-requested",
        threadId,
        dataCount: state.activityIdsByThreadId?.[threadId]?.length ?? 0,
        detail: {
          previousSyncState: state.threadDetailSyncById?.[threadId] ?? null,
          isReopened,
          shellSnapshotSequence: state.shellSnapshotSequence ?? null,
        },
      });
      void api.orchestration
        .getThreadTurnsPage({ threadId })
        .then((page) => {
          // The response hydrates an authoritative retained-detail cache, not
          // component-local state. A route or shell rerender while the read is
          // in flight must not revoke it; deleted threads are rejected by the
          // store merge itself.
          syncServerThreadTurnsPage(page);
          recordChatPaginationDiagnostic({
            event: "visible-reconcile-applied",
            threadId,
            dataCount: page.activities.length,
            detail: {
              messageCount: page.messages.length,
              snapshotSequence: page.snapshotSequence,
            },
          });
          const thread = getThreadFromState(useStore.getState(), threadId);
          if (thread) reconcilePromotedDraftFromThreadDetail(thread);
        })
        .catch((error: unknown) => {
          useStore.getState().markThreadDetailSyncFailed(threadId);
          recordChatPaginationDiagnostic({
            event: "visible-reconcile-failed",
            threadId,
            dataCount: 0,
            detail: {
              errorName: error instanceof Error ? error.name : typeof error,
            },
          });
        });
    }
  }, [serverThreadIds, syncServerThreadTurnsPage, visibleThreadIds]);

  return null;
}
