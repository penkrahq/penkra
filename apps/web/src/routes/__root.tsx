import {
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type OrchestrationShellSnapshot,
  type ServerConfig,
  type ServerProviderStatus,
  type WsCompatibilityError,
} from "@penkra/contracts";
import { defaultTerminalTitleForCliKind } from "@penkra/shared/terminalThreads";
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
import { DesktopComposerStageBridge } from "../components/DesktopComposerStageBridge";
import { DesktopOnboardingGate } from "../components/onboarding/DesktopOnboardingGate";
import { QueuedComposerTurnDispatcher } from "../components/QueuedComposerTurnDispatcher";
import { FeedbackDialog } from "../components/FeedbackDialog";
import { SETTINGS_TARGETS } from "../settingsNavigation";
import ShortcutsDialog from "../components/ShortcutsDialog";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { useWhatsNew } from "../whatsNew/useWhatsNew";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import { shouldRenderTerminalWorkspace } from "../components/ChatView.logic";
import { Button, dialogActionButtonClassName } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { ServerConfigUpdateNotifications } from "../components/ServerConfigUpdateNotifications";
import { useFocusedChatContext } from "../focusedChatContext";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import type { FeedbackThreadContext } from "../feedback";
import { isTerminalFocused } from "../lib/terminalFocus";
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
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { terminalActivityFromEvent } from "../terminalActivity";
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
import { invalidateProjectFileQueriesForCwds, projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { useProjectRunStore } from "../projectRunStore";
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
import { useChatRouteSearch } from "../hooks/useChatRouteSearch";
import { resolveSplitViewThreadIds, selectSplitView, useSplitViewStore } from "../splitViewStore";
import { providerModelDiscoveryInvalidationFingerprint } from "../lib/providerDiscoveryInvalidation";
import { providerDiscoveryQueryKeys } from "../lib/providerDiscoveryReactQuery";
import { useAppSettings } from "../appSettings";
import {
  getVisibleProviderUpdateStatuses,
  isProviderUpdateActive,
  providerUpdateNotificationKey,
  withProviderUpdateTimeout,
} from "../providerUpdates";

const seenProviderUpdateNotificationKeys = new Set<string>();

type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;
type ActiveProviderUpdateToast =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
    };

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

function reconcilePromotedDraftsFromShellThreads(
  threads: ReadonlyArray<OrchestrationShellSnapshot["threads"][number]>,
): void {
  markPromotedDraftThreads(new Set(threads.map((thread) => thread.id)));
  finalizePromotedDraftThreads(
    new Set(threads.filter((thread) => shellThreadHasStarted(thread)).map((thread) => thread.id)),
  );
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
              <DesktopComposerStageBridge />
              <ServerConfigUpdateNotifications />
              <EventRouter />
              <GlobalShortcutsDialog />
              <GlobalFeedbackDialog />
              <GlobalWhatsNewSurface />
              <TaskCompletionNotifications />
              <ProviderUpdateNotifications />
              <QueuedComposerTurnDispatcher />
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

// Extracted to module scope so its run-always cleanup can stay a try/finally: the
// React Compiler does not compile module functions, so the finally block is fine
// here even though it would bail out the component body.
async function runProviderUpdateAll(params: {
  providers: ReadonlyArray<ServerProviderStatus>;
  queryClient: QueryClient;
  activeToastRef: { current: ActiveProviderUpdateToast | null };
  isUpdatingAllRef: { current: boolean };
  progressToastDismissedRef: { current: boolean };
  setIsUpdatingAll: (value: boolean) => void;
}): Promise<void> {
  const {
    providers,
    queryClient,
    activeToastRef,
    isUpdatingAllRef,
    progressToastDismissedRef,
    setIsUpdatingAll,
  } = params;
  const activeNotificationKey = providerUpdateNotificationKey(providers);
  if (isUpdatingAllRef.current || providers.length === 0 || !activeNotificationKey) {
    return;
  }

  isUpdatingAllRef.current = true;
  progressToastDismissedRef.current = false;
  setIsUpdatingAll(true);
  const trackedToast = activeToastRef.current;
  const toastId =
    trackedToast?.toastId ??
    toastManager.add({
      type: "loading",
      title: "Updating providers...",
      description:
        providers.length === 1
          ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
          : `Updating ${providers.length} providers.`,
      timeout: 0,
    });
  activeToastRef.current = {
    kind: "update",
    key: activeNotificationKey,
    toastId,
  };
  const dismissProgressToast = () => {
    progressToastDismissedRef.current = true;
    if (activeToastRef.current?.toastId === toastId) {
      activeToastRef.current = null;
    }
    toastManager.close(toastId);
  };

  toastManager.update(toastId, {
    type: "loading",
    title: "Updating providers...",
    description:
      providers.length === 1
        ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
        : `Updating ${providers.length} providers.`,
    actionProps: undefined,
    data: { onClose: dismissProgressToast },
    timeout: 0,
  });

  const failures: Array<{ provider: ServerProviderStatus; reason: string }> = [];

  try {
    const api = ensureNativeApi();
    for (const provider of providers) {
      try {
        const result = await withProviderUpdateTimeout({
          provider: provider.provider,
          request: api.server.updateProvider({ provider: provider.provider }),
        });
        const refreshed = result.providers.find((entry) => entry.provider === provider.provider);
        const updateState = refreshed?.updateState;
        if (updateState?.status === "failed" || updateState?.status === "unchanged") {
          failures.push({
            provider,
            reason: updateState.message ?? "The update command did not complete successfully.",
          });
        } else if (refreshed?.versionAdvisory?.status === "behind_latest") {
          failures.push({
            provider,
            reason: "The provider still appears outdated after updating.",
          });
        }
      } catch (error) {
        failures.push({
          provider,
          reason: error instanceof Error ? error.message : "The update request failed.",
        });
      }
    }
  } catch (error) {
    for (const provider of providers) {
      failures.push({
        provider,
        reason:
          error instanceof Error ? error.message : "The provider update request could not start.",
      });
    }
  } finally {
    // Refresh is best-effort UI sync; it must not keep the progress toast alive.
    await queryClient
      .invalidateQueries({ queryKey: serverQueryKeys.config() })
      .catch(() => undefined);
    isUpdatingAllRef.current = false;
    setIsUpdatingAll(false);
  }

  if (progressToastDismissedRef.current || activeToastRef.current?.toastId !== toastId) {
    return;
  }

  if (failures.length > 0) {
    activeToastRef.current = null;
    // Surface the exact manual commands so a user whose one-click update
    // failed (EACCES on global npm, PATH/package-manager mismatch, etc.) can
    // copy and run them in a terminal instead of being stuck.
    const manualCommands = Array.from(
      new Set(
        failures
          .map(({ provider }) => provider.versionAdvisory?.updateCommand)
          .filter(
            (command): command is string =>
              typeof command === "string" && command.trim().length > 0,
          ),
      ),
    );
    const failureLines = failures
      .map(({ provider, reason }) => `${PROVIDER_DISPLAY_NAMES[provider.provider]}: ${reason}`)
      .join("\n");
    toastManager.update(toastId, {
      type: "error",
      title:
        failures.length === providers.length
          ? "Provider updates failed"
          : "Some provider updates failed",
      description:
        manualCommands.length > 0
          ? `${failureLines}\n\nCopy the command${manualCommands.length === 1 ? "" : "s"} below to update manually in a terminal.`
          : failureLines,
      data: {
        onClose: dismissProgressToast,
        ...(manualCommands.length > 0 ? { copyText: manualCommands.join("\n") } : {}),
      },
      timeout: 0,
    });
    return;
  }

  activeToastRef.current = null;
  toastManager.update(toastId, {
    type: "success",
    title:
      providers.length === 1
        ? `${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]} updated`
        : `${providers.length} providers updated`,
    description: "New sessions will use the refreshed provider tools.",
    data: { onClose: dismissProgressToast },
    timeout: 6000,
  });
}

function ProviderUpdateNotifications() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const providerUpdateServerSettings = serverSettingsQuery.data ?? null;
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const isUpdatingAllRef = useRef(false);
  const progressToastDismissedRef = useRef(false);
  const outdatedProviders = getVisibleProviderUpdateStatuses({
    providers: serverConfigQuery.data?.providers ?? [],
    hiddenProviders: settings.hiddenProviders,
    serverSettings: providerUpdateServerSettings,
    oneClickOnly: true,
  });
  const oneClickProviders = outdatedProviders.filter(
    (provider) => !isProviderUpdateActive(provider),
  );
  const notificationKey = providerUpdateNotificationKey(outdatedProviders);

  const updateAll = (providers: ReadonlyArray<ServerProviderStatus>) =>
    runProviderUpdateAll({
      providers,
      queryClient,
      activeToastRef,
      isUpdatingAllRef,
      progressToastDismissedRef,
      setIsUpdatingAll,
    });

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (
      activeToast?.kind === "prompt" &&
      (settings.providerUpdateMode !== "notify" || activeToast.key !== notificationKey)
    ) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      settings.providerUpdateMode !== "notify" ||
      outdatedProviders.length === 0 ||
      oneClickProviders.length === 0 ||
      !notificationKey ||
      isUpdatingAll ||
      activeToastRef.current ||
      seenProviderUpdateNotificationKeys.has(notificationKey)
    ) {
      return;
    }

    // Key the prompt by the complete provider/version set so a partial refresh
    // cannot stack a second "Update all" prompt on top of the first one.
    seenProviderUpdateNotificationKeys.add(notificationKey);

    const firstProvider = outdatedProviders[0]!;
    const additionalCount = outdatedProviders.length - 1;
    const providerName = PROVIDER_DISPLAY_NAMES[firstProvider.provider];
    const title =
      outdatedProviders.length === 1
        ? `${providerName} update available`
        : `${outdatedProviders.length} provider updates available`;
    const description =
      outdatedProviders.length === 1
        ? `${providerName} has a newer version available.`
        : `${providerName} and ${additionalCount} more provider${additionalCount === 1 ? "" : "s"} have newer versions available.`;

    let toastId!: ProviderUpdateToastId;
    const closeTrackedPrompt = () => {
      if (activeToastRef.current?.toastId === toastId) {
        activeToastRef.current = null;
      }
      toastManager.close(toastId);
    };
    toastId = toastManager.add({
      type: "warning",
      title,
      description,
      timeout: 0,
      actionProps: {
        children: "Review updates",
        onClick: () => {
          if (activeToastRef.current?.toastId === toastId) {
            toastManager.close(toastId);
            activeToastRef.current = null;
          }
          void navigate({
            to: "/settings",
            search: {
              section: "providers",
              target: SETTINGS_TARGETS.providerUpdates,
            },
          });
        },
      },
      data: {
        onClose: closeTrackedPrompt,
        secondaryActionProps: {
          children: "Update all",
          onClick: () => {
            void updateAll(oneClickProviders);
          },
        },
      },
    });
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    isUpdatingAll,
    navigate,
    notificationKey,
    oneClickProviders,
    outdatedProviders,
    settings.providerUpdateMode,
    updateAll,
  ]);

  return null;
}

function GlobalShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const { focusedThreadId, activeProject } = useFocusedChatContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const activeThreadTerminalState = useTerminalStateStore((state) =>
    focusedThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, focusedThreadId)
      : null,
  );
  const terminalOpen = activeThreadTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: activeThreadTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });

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
      projectScripts={activeProject?.scripts ?? []}
      platform={platform}
      context={{
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      }}
    />
  );
}

function GlobalFeedbackDialog() {
  const { activeProject, activeThread } = useFocusedChatContext();
  const isOpen = useFeedbackDialogStore((state) => state.isOpen);
  const requestedContext = useFeedbackDialogStore((state) => state.context);
  const setOpen = useFeedbackDialogStore((state) => state.setOpen);
  const context: FeedbackThreadContext = requestedContext ?? {
    provider: activeThread?.modelSelection.provider ?? null,
    model: activeThread?.modelSelection.model ?? null,
    projectKind: activeProject ? "folder" : null,
    runtimeMode: activeThread?.runtimeMode ?? null,
    sessionStatus: activeThread?.session?.status ?? null,
    latestTurnState: activeThread?.latestTurn?.state ?? null,
    messageCount: activeThread?.messages.length ?? 0,
    activityCount: activeThread?.activities.length ?? 0,
    hasPendingApproval: activeThread?.hasPendingApprovals === true,
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
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerThreadTurnsPage = useStore((store) => store.syncServerThreadTurnsPage);
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
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
  const routeSearch = useChatRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const visibleThreadIds = useMemo(
    () =>
      activeSplitView
        ? resolveSplitViewThreadIds(activeSplitView)
        : routeThreadId
          ? [routeThreadId]
          : [],
    [activeSplitView, routeThreadId],
  );
  const serverThreadIds = useMemo(() => new Set(serverThreadIdList ?? []), [serverThreadIdList]);
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
    setVisibleThreadDetailIds(visibleThreadIds);
  }, [pathname, visibleThreadIds]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;
    let syncDeliveryChain = Promise.resolve();
    let providerDiscoveryInvalidationFingerprint: string | null = null;

    const removeOrphanedTerminalsForCurrentState = () => {
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: getThreadsFromState(useStore.getState()).map((thread) => ({
          id: thread.id,
          deletedAt: null,
          archivedAt: thread.archivedAt ?? null,
        })),
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const unsubSyncEvent = api.orchestration.onSyncEvent((item) => {
      syncDeliveryChain = syncDeliveryChain
        .then(async () => {
          if (disposed) return;
          const appliedSequence =
            item.kind === "snapshot" ? item.snapshot.snapshotSequence : item.event.sequence;
          if (item.kind === "snapshot") {
            syncServerShellSnapshot(item.snapshot.shell);
            reconcilePromotedDraftsFromShellThreads(item.snapshot.shell.threads);
            for (const page of item.snapshot.activeThreadPages) {
              syncServerThreadTurnsPage(page);
              const thread = getThreadFromState(useStore.getState(), page.threadId);
              if (thread) reconcilePromotedDraftFromThreadDetail(thread);
            }
            removeOrphanedTerminalsForCurrentState();
          } else {
            applyOrchestrationEvents([item.event]);
            if (item.event.aggregateKind === "thread") {
              const thread = getThreadFromState(
                useStore.getState(),
                ThreadId.makeUnsafe(String(item.event.aggregateId)),
              );
              if (thread) {
                reconcilePromotedDraftFromThreadDetail(thread);
              }
            }
          }
          await api.orchestration.acknowledgeSync({
            deliveryId: item.deliveryId,
            appliedSequence,
          });
        })
        .catch((error) => {
          if (!disposed) {
            console.error("Failed to apply orchestration synchronization delivery", error);
          }
        });
    });

    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const terminalThreadId = ThreadId.makeUnsafe(event.threadId);
      if (event.type === "activity") {
        const terminalStore = useTerminalStateStore.getState();
        const currentCliKind =
          selectThreadTerminalState(terminalStore.terminalStateByThreadId, terminalThreadId)
            .terminalCliKindsById[event.terminalId] ?? null;
        if (event.cliKind || currentCliKind !== null) {
          terminalStore.setTerminalMetadata(terminalThreadId, event.terminalId, {
            cliKind: event.cliKind,
            label: event.cliKind ? defaultTerminalTitleForCliKind(event.cliKind) : "Terminal",
          });
        }
      }
      const activity = terminalActivityFromEvent(event);
      if (activity === null) return;
      useTerminalStateStore.getState().setTerminalActivity(terminalThreadId, event.terminalId, {
        hasRunningSubprocess: activity.hasRunningSubprocess,
        agentState: activity.agentState,
      });
    });

    const invalidateLocalServers = () => {
      void queryClient.invalidateQueries({
        queryKey: serverQueryKeys.localServers(),
      });
    };
    const unsubDevServerEvent = api.folders.onDevServerEvent((event) => {
      const store = useProjectRunStore.getState();
      if (event.type === "snapshot") {
        store.replaceAll(event.servers);
      } else if (event.type === "upserted") {
        store.upsertRun(event.server);
      } else {
        store.removeRun(event.folderId);
      }
      invalidateLocalServers();
    });
    const unsubWorkspaceChange = api.folders.onWorkspaceChange((event) => {
      if (event.lostSync) {
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
        return;
      }
      if (event.filesChanged) {
        void invalidateProjectFileQueriesForCwds(queryClient, new Set([event.cwd]));
      }
    });
    void api.folders
      .listDevServers()
      .then(({ servers }) => {
        if (disposed) return;
        useProjectRunStore.getState().replaceAll(servers);
        invalidateLocalServers();
      })
      .catch(() => undefined);

    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        setServerWorkspacePaths({
          homeDir: payload.homeDir,
          chatWorkspaceRoot: payload.chatWorkspaceRoot,
        });
        if (disposed || !payload.bootstrapFolderId || !payload.bootstrapThreadId) return;
        setProjectExpanded(payload.bootstrapFolderId, true);
        if (
          pathnameRef.current !== "/" ||
          handledBootstrapThreadIdRef.current === payload.bootstrapThreadId
        ) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });

    const unsubProviderStatusesUpdated = onServerProviderStatusesUpdated((payload) => {
      const nextProviderDiscoveryFingerprint = providerModelDiscoveryInvalidationFingerprint(
        payload.providers,
      );
      const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
      const previousProviderDiscoveryFingerprint =
        providerDiscoveryInvalidationFingerprint ??
        (currentConfig
          ? providerModelDiscoveryInvalidationFingerprint(currentConfig.providers)
          : null);
      const shouldInvalidateProviderDiscovery =
        previousProviderDiscoveryFingerprint !== null &&
        previousProviderDiscoveryFingerprint !== nextProviderDiscoveryFingerprint;
      providerDiscoveryInvalidationFingerprint = nextProviderDiscoveryFingerprint;

      void reconcileServerProviderStatuses(queryClient, payload.providers).catch(() => undefined);
      if (shouldInvalidateProviderDiscovery) {
        void queryClient.invalidateQueries({
          queryKey: ["provider-discovery", "models", "opencode"],
        });
        void queryClient.invalidateQueries({
          queryKey: providerDiscoveryQueryKeys.agentsForProvider("opencode"),
        });
      }
    });
    const unsubWsTransportState = addWsTransportStateListener(
      (state) => {
        if (state !== "open") return;
        void refreshServerConfigAfterTransportOpen(queryClient).catch(() => undefined);
      },
      { replayCurrent: true },
    );
    const unsubServerSettingsUpdated = onServerSettingsUpdated((payload) => {
      queryClient.setQueryData(serverQueryKeys.settings(), payload.settings);
      void queryClient.invalidateQueries({
        queryKey: serverSettingsQueryOptions().queryKey,
      });
    });
    return () => {
      disposed = true;
      unsubSyncEvent();
      unsubTerminalEvent();
      unsubDevServerEvent();
      unsubWorkspaceChange();
      unsubWelcome();
      unsubProviderStatusesUpdated();
      unsubWsTransportState();
      unsubServerSettingsUpdated();
    };
  }, [
    applyOrchestrationEvents,
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    setServerWorkspacePaths,
    syncServerShellSnapshot,
  ]);

  useLayoutEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let cancelled = false;
    for (const threadId of visibleThreadIds) {
      // The route becomes visible before the uniform sync snapshot necessarily
      // creates its shell row. A page that wins that race is intentionally
      // rejected by syncServerThreadTurnsPage because there is no Thread to
      // attach it to; wait for shell ownership so the subsequent thread-id
      // update retries this effect instead of dropping detail permanently.
      if (!serverThreadIds.has(threadId)) continue;
      const state = useStore.getState();
      if (state.threadDetailSyncById?.[threadId] === "synced") continue;
      void api.orchestration
        .getThreadTurnsPage({ threadId })
        .then((page) => {
          if (cancelled) return;
          syncServerThreadTurnsPage(page);
          const thread = getThreadFromState(useStore.getState(), threadId);
          if (thread) reconcilePromotedDraftFromThreadDetail(thread);
        })
        .catch(() => {
          if (!cancelled) {
            useStore.getState().markThreadDetailSyncFailed(threadId);
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [serverThreadIds, syncServerThreadTurnsPage, visibleThreadIds]);

  return null;
}
