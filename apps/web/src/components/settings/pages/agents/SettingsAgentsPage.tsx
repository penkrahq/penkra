import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderConnection,
  type ProviderKind,
} from "@penkra/contracts";
import { IconKey, IconUser } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AgentRowShared } from "~/components/settings/agent-row-shared/AgentRowShared";
import { ConnectionApiKeyFormShared } from "~/components/settings/connection-api-key-form-shared/ConnectionApiKeyFormShared";
import { ConnectionAuthActionShared } from "~/components/settings/connection-auth-action-shared/ConnectionAuthActionShared";
import { ConnectionMethodRowShared } from "~/components/settings/connection-method-row-shared/ConnectionMethodRowShared";
import { ConnectionSetupShared } from "~/components/settings/connection-setup-shared/ConnectionSetupShared";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { EllipsisIcon, PlusIcon, XIcon } from "~/lib/icons";
import { declaredConnectionProviders } from "~/lib/managedConnectionProviders";
import {
  providerConnectionQueryKeys,
  providerConnectionsQueryOptions,
} from "~/lib/providerConnectionsReactQuery";
import { providerDiscoveryQueryKeys } from "~/lib/providerDiscoveryReactQuery";
import { ensureNativeApi } from "~/nativeApi";

function authenticationMethodSelectionId(input: {
  authenticationTargetId: string;
  authenticationMethodId: string;
}) {
  return `${input.authenticationTargetId}:${input.authenticationMethodId}`;
}

function connectionDetail(input: {
  provider: ProviderKind;
  connections: ReadonlyArray<ProviderConnection>;
  installationLifecycle: "staged" | "active" | "retired" | "rejected" | null;
  hasAnonymousRoute: boolean;
}) {
  if (input.installationLifecycle !== "active") {
    return input.installationLifecycle === "rejected" ? "Disabled" : "Getting ready";
  }
  const count = input.connections.filter(
    (connection) => connection.harness === input.provider && connection.lifecycle === "active",
  ).length;
  if (count > 0) return count === 1 ? "1 connection" : `${count} connections`;
  return "No connections yet";
}

function providerDisplayName(provider: ProviderKind) {
  return provider === "codex" ? "ChatGPT" : PROVIDER_DISPLAY_NAMES[provider];
}

function emptyStateCopy(provider: ProviderKind, hasAnonymousRoute: boolean) {
  if (provider === "claudeAgent") {
    return {
      title: "Connect an account to run Claude threads",
      body: "Sign in with your Claude account, or use an API key if you bill through the console. You can add more later and choose a default per Space.",
    };
  }
  if (provider === "codex") {
    return {
      title: "Connect an account to run ChatGPT threads",
      body: "Sign in with your ChatGPT account, or use an API key if you bill through the platform. You can add more later and choose a default per Space.",
    };
  }
  if (provider === "opencode") {
    return {
      title: "Add a Connection for paid OpenCode models",
      body: "Choose OpenCode Zen or OpenCode Go, then add its API key.",
    };
  }
  return hasAnonymousRoute
    ? {
        title: `Add a Connection for more ${PROVIDER_DISPLAY_NAMES[provider]} models`,
        body: "Models that do not require a Connection remain available.",
      }
    : {
        title: `Connect an account to run ${PROVIDER_DISPLAY_NAMES[provider]} threads`,
        body: "Connect an account, then choose its default per Space.",
      };
}

export function SettingsAgentsPage(_props: { embedded?: boolean } = {}) {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(providerConnectionsQueryOptions(null));
  const [openProvider, setOpenProvider] = useState<ProviderKind | null>("claudeAgent");
  const [addingProvider, setAddingProvider] = useState<ProviderKind | null>(null);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [loginOperationId, setLoginOperationId] = useState<string | null>(null);

  const connections = connectionsQuery.data?.connections ?? [];
  const authenticationMethods = connectionsQuery.data?.authenticationMethods ?? [];
  const activeInstallationProviders = useMemo(
    () =>
      new Set(
        connectionsQuery.data?.installations
          .filter((installation) => installation.lifecycle === "active")
          .map((installation) => installation.harness) ?? [],
      ),
    [connectionsQuery.data?.installations],
  );
  const managedAgents = useMemo(
    () => declaredConnectionProviders(connectionsQuery.data),
    [connectionsQuery.data],
  );
  const methodsForAddingProvider = authenticationMethods.filter(
    (method) => method.harness === addingProvider,
  );
  const selectedMethod = methodsForAddingProvider.find(
    (method) => authenticationMethodSelectionId(method) === methodId,
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: providerConnectionQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
    ]);
  }, [queryClient]);

  const clearAdd = useCallback(() => {
    setAddingProvider(null);
    setMethodId(null);
    setSecret("");
  }, []);

  const cancelAdd = useCallback(async () => {
    try {
      if (loginOperationId !== null) {
        await ensureNativeApi().provider.cancelConnectionLogin({ operationId: loginOperationId });
        setLoginOperationId(null);
      }
      clearAdd();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not cancel sign in",
        description: error instanceof Error ? error.message : "Sign in is still in progress.",
      });
    }
  }, [clearAdd, loginOperationId]);

  const beginAdd = (provider: ProviderKind, nextMethodId: string | null = null) => {
    setOpenProvider(provider);
    setAddingProvider(provider);
    setMethodId(nextMethodId);
    setSecret("");
  };

  useEffect(() => {
    if (loginOperationId === null) return;
    let stopped = false;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const login = await ensureNativeApi().provider.getConnectionLogin({
          operationId: loginOperationId,
        });
        if (stopped) return;
        if (login.state === "completed") {
          await refresh();
          setLoginOperationId(null);
          clearAdd();
          return;
        }
        if (login.state === "failed" || login.state === "cancelled") {
          setLoginOperationId(null);
          toastManager.add({
            type: "error",
            title: login.failureReason ?? "Sign in did not complete.",
          });
          return;
        }
        timeout = window.setTimeout(poll, 800);
      } catch {
        if (!stopped) timeout = window.setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [clearAdd, loginOperationId, refresh]);

  const addConnection = async (
    provider: ProviderKind,
    method: (typeof authenticationMethods)[number],
  ) => {
    if (method.kind !== "managed-login" && secret.length === 0) return;
    setSaving(true);
    try {
      if (method.kind === "managed-login") {
        const login = await ensureNativeApi().provider.beginConnectionLogin({
          harness: provider,
          authenticationTargetId: method.authenticationTargetId,
          authenticationMethodId: method.authenticationMethodId,
        });
        setLoginOperationId(login.operationId);
        if (login.authUrl !== null) await ensureNativeApi().shell.openExternal(login.authUrl);
        return;
      }
      if (method.kind === "managed-secret") {
        const login = await ensureNativeApi().provider.beginConnectionLogin({
          harness: provider,
          authenticationTargetId: method.authenticationTargetId,
          authenticationMethodId: method.authenticationMethodId,
          secret,
        });
        setLoginOperationId(login.operationId);
        return;
      }
      await ensureNativeApi().provider.createStaticConnection({
        harness: provider,
        authenticationTargetId: method.authenticationTargetId,
        authenticationMethodId: method.authenticationMethodId,
        secret,
      });
      await refresh();
      clearAdd();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : "The Connection could not be added.",
      });
    } finally {
      setSaving(false);
    }
  };

  const disconnectConnection = async (connection: ProviderConnection) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      `Disconnect “${connection.label}”?\n\nExisting Threads using it will show an error until you choose another Connection.`,
    );
    if (!confirmed) return;
    try {
      await ensureNativeApi().provider.terminateConnection({
        connectionId: connection.id,
        reason: "disconnected",
      });
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not disconnect",
        description: error instanceof Error ? error.message : "The Connection is still active.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-6 font-sans" data-pencil-page="agents">
      <div className="flex flex-col gap-4">
        {managedAgents.map((provider) => {
          const open = openProvider === provider;
          const adding = addingProvider === provider;
          const installationLifecycle =
            connectionsQuery.data?.installations.find(
              (installation) => installation.harness === provider,
            )?.lifecycle ?? null;
          const providerConnections = connections.filter(
            (connection) => connection.harness === provider && connection.lifecycle === "active",
          );
          const methods = authenticationMethods.filter((method) => method.harness === provider);
          const hasAnonymousRoute =
            connectionsQuery.data?.anonymousRoutes.some((route) => route.harness === provider) ===
            true;
          const canAdd = activeInstallationProviders.has(provider) && methods.length > 0;
          const emptyCopy = emptyStateCopy(provider, hasAnonymousRoute);
          const showHeaderAction = providerConnections.length > 0;
          const methodAction = (method: (typeof methods)[number], onClick: () => void) =>
            provider === "opencode" ? (
              <ConnectionMethodRowShared
                ariaLabel={`${method.label} for ${providerDisplayName(provider)}`}
                icon={<IconKey className="size-4 text-[var(--color-text-foreground-secondary)]" />}
                label={method.label}
                onClick={onClick}
              />
            ) : (
              <ConnectionAuthActionShared
                ariaLabel={`${method.label} for ${providerDisplayName(provider)}`}
                disabled={saving || loginOperationId !== null}
                kind={method.kind === "managed-login" ? "sign-in" : "key"}
                label={method.label}
                onClick={onClick}
                provider={provider}
              />
            );
          const selectMethod = (method: (typeof methods)[number]) => {
            beginAdd(provider, authenticationMethodSelectionId(method));
            if (method.kind === "managed-login") void addConnection(provider, method);
          };

          return (
            <Collapsible
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4"
              key={provider}
              onOpenChange={(next) => setOpenProvider(next ? provider : null)}
              open={open}
            >
              <AgentRowShared
                action={
                  showHeaderAction ? (
                    <button
                      aria-label={`${adding ? "Cancel adding" : "Add"} ${providerDisplayName(provider)} Connection`}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[7px] bg-[var(--color-background-button-secondary)] px-2.5 text-[length:var(--app-font-size-ui,12px)] font-medium text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
                      disabled={!adding && !canAdd}
                      onClick={() => {
                        if (adding) void cancelAdd();
                        else beginAdd(provider);
                      }}
                      type="button"
                    >
                      {adding ? (
                        <XIcon className="size-[13px]" />
                      ) : (
                        <PlusIcon className="size-[13px]" />
                      )}
                      {adding ? "Cancel" : "Add"}
                    </button>
                  ) : undefined
                }
                detail={connectionDetail({
                  provider,
                  connections,
                  installationLifecycle,
                  hasAnonymousRoute,
                })}
                label={providerDisplayName(provider)}
                onClick={() => {
                  if (open && adding && providerConnections.length === 0) void cancelAdd();
                  if (!open && addingProvider !== null && addingProvider !== provider) {
                    if (loginOperationId === null) clearAdd();
                    else void cancelAdd();
                  }
                  setOpenProvider(open ? null : provider);
                }}
                open={open}
                provider={provider}
              />
              <CollapsiblePanel>
                <div className="mt-3 flex flex-col gap-2">
                  {installationLifecycle !== "active" ? (
                    <div className="rounded-[10px] bg-[var(--color-background-button-secondary)] px-[18px] py-5 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)]">
                      {installationLifecycle === "rejected"
                        ? "This agent is disabled."
                        : "Penkra is preparing this agent."}
                    </div>
                  ) : (
                    <>
                      {adding || providerConnections.length === 0 ? (
                        <ConnectionSetupShared body={emptyCopy.body} title={emptyCopy.title}>
                          {selectedMethod && selectedMethod.kind !== "managed-login" ? (
                            <ConnectionApiKeyFormShared
                              disabled={saving || loginOperationId !== null || secret.length === 0}
                              onCancel={() => {
                                setMethodId(null);
                                setSecret("");
                              }}
                              onSecretChange={setSecret}
                              onSubmit={() => void addConnection(provider, selectedMethod)}
                              secret={secret}
                            />
                          ) : provider === "opencode" ? (
                            <div className="flex flex-col divide-y divide-[var(--color-border)] overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
                              {methods.map((method) => (
                                <div key={authenticationMethodSelectionId(method)}>
                                  {methodAction(method, () => selectMethod(method))}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {methods.map((method) => (
                                <div key={authenticationMethodSelectionId(method)}>
                                  {methodAction(method, () => selectMethod(method))}
                                </div>
                              ))}
                            </div>
                          )}
                        </ConnectionSetupShared>
                      ) : null}
                      {providerConnections.map((connection) => {
                        const method = authenticationMethods.find(
                          (candidate) =>
                            candidate.harness === provider &&
                            candidate.authenticationTargetId ===
                              connection.authenticationTargetId &&
                            candidate.authenticationMethodId === connection.authenticationMethodId,
                        );
                        const isStatic = method?.kind !== "managed-login";
                        return (
                          <div
                            key={connection.id}
                            className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)]"
                          >
                            <div className="flex min-h-[62px] items-center gap-3 px-3.5 py-[11px]">
                              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)]">
                                {isStatic ? (
                                  <IconKey className="size-[15px]" />
                                ) : (
                                  <IconUser className="size-[15px]" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-text-foreground)]">
                                {connection.label}
                              </span>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <button
                                      aria-label={`Manage ${connection.label}`}
                                      className="inline-flex size-7 items-center justify-center rounded-md text-[var(--color-text-foreground-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
                                      type="button"
                                    />
                                  }
                                >
                                  <EllipsisIcon className="size-4" />
                                </MenuTrigger>
                                <ComposerPickerMenuPopup align="end" fixedWidth>
                                  <MenuItem
                                    className="text-destructive"
                                    onClick={() => void disconnectConnection(connection)}
                                  >
                                    Disconnect
                                  </MenuItem>
                                </ComposerPickerMenuPopup>
                              </Menu>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
