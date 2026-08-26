// FILE: ComposerConnectionControl.tsx
// Purpose: Connection-scoped composer control, switcher, and usage detail popup.

import {
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderConnectionsSnapshot,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@penkra/contracts";
import { IconKey, IconUser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ensureNativeApi } from "~/nativeApi";
import { ExternalLinkIcon, PlusIcon } from "~/lib/icons";
import {
  deriveProviderUsageDisplayRows,
  providerUsageToneClassName,
  selectPrimaryProviderUsageDisplayRow,
  type ProviderUsageDisplayRow,
} from "~/lib/providerUsageDisplay";
import {
  connectionUsageEmptyMessage,
  normalizeServerProviderUsageRateLimit,
} from "~/lib/providerUsageSnapshot";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";

const API_KEY_METHOD_ID = "api-key";

function isApiKeyConnection(connection: ProviderConnection): boolean {
  return connection.authenticationMethodId === API_KEY_METHOD_ID;
}

function dashboardForConnection(connection: ProviderConnection): {
  label: string;
  url: string;
} {
  if (connection.harness === "codex") {
    return { label: "OpenAI", url: "https://platform.openai.com/usage" };
  }
  if (connection.harness === "claudeAgent") {
    return { label: "Anthropic", url: "https://console.anthropic.com/settings/usage" };
  }
  if (connection.authenticationTargetId === "opencode-go") {
    return { label: "OpenCode", url: "https://opencode.ai/go" };
  }
  return { label: "OpenCode", url: "https://opencode.ai/auth" };
}

function usageRows(snapshot: ServerProviderUsageSnapshot | undefined): ProviderUsageDisplayRow[] {
  const normalized = normalizeServerProviderUsageRateLimit(snapshot);
  return normalized ? deriveProviderUsageDisplayRows([normalized]) : [];
}

function ConnectionUsageRows({ rows }: { rows: ReadonlyArray<ProviderUsageDisplayRow> }) {
  return (
    <div className="space-y-2.5 px-2 pb-2 pt-1">
      {rows.map((row) => (
        <div className="space-y-1" key={row.id}>
          <div className="flex items-baseline gap-1 text-[length:var(--app-font-size-ui-sm,11px)]">
            <span className="text-muted-foreground">
              {row.label === "5h" ? "Session" : row.label}
            </span>
            {row.resetText ? (
              <span className="text-muted-foreground/60">· {row.resetText.toLowerCase()}</span>
            ) : null}
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {row.remainingLabel}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted-foreground/15">
            <div
              className={cn("h-full rounded-full", providerUsageToneClassName(row.remainingTone))}
              style={{ width: `${row.remainingPercent}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ConnectionChoice {
  readonly key: string;
  readonly connectionId: ProviderConnectionId | null;
  readonly label: string;
  readonly groupLabel: string;
  readonly connection?: ProviderConnection;
}

function ConnectionSwitcher(props: {
  choices: ReadonlyArray<ConnectionChoice>;
  snapshots: ReadonlyMap<ProviderConnectionId, ServerProviderUsageSnapshot>;
  onConnectionChange: (connectionId: ProviderConnectionId | null) => void;
  onManageConnections?: () => void;
}) {
  const groups = props.choices.reduce<Array<[string, ConnectionChoice[]]>>((result, choice) => {
    const group = result.find(([label]) => label === choice.groupLabel);
    if (group) group[1].push(choice);
    else result.push([choice.groupLabel, [choice]]);
    return result;
  }, []);
  return (
    <>
      {groups.map(([groupLabel, choices], groupIndex) => (
        <div key={groupLabel}>
          {groupIndex > 0 ? <MenuSeparator /> : null}
          <div className="px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
            {groupLabel}
          </div>
          {choices.map((choice) => {
            const apiKey = choice.connection ? isApiKeyConnection(choice.connection) : false;
            const primary = choice.connection
              ? selectPrimaryProviderUsageDisplayRow(
                  usageRows(props.snapshots.get(choice.connection.id)),
                )
              : null;
            return (
              <MenuItem
                key={choice.key}
                onClick={() => props.onConnectionChange(choice.connectionId)}
              >
                <span className="min-w-0 truncate">{choice.label}</span>
                {apiKey ? (
                  <IconKey aria-hidden="true" className="ml-auto size-[13px]" stroke={1.8} />
                ) : choice.connection ? (
                  <span className="ml-auto tabular-nums">{primary?.remainingLabel ?? "—"}</span>
                ) : null}
              </MenuItem>
            );
          })}
        </div>
      ))}
      {props.onManageConnections ? <MenuSeparator /> : null}
      {props.onManageConnections ? (
        <MenuItem onClick={props.onManageConnections}>
          <PlusIcon className="size-3.5" />
          Add connection…
        </MenuItem>
      ) : null}
    </>
  );
}

export function ComposerConnectionControl(props: {
  provider: ProviderKind;
  connections: ReadonlyArray<ProviderConnection>;
  authenticationMethods?: ProviderConnectionsSnapshot["authenticationMethods"];
  anonymousRoutes?: ProviderConnectionsSnapshot["anonymousRoutes"];
  selectedConnectionId: ProviderConnectionId | null | undefined;
  onConnectionChange: (connectionId: ProviderConnectionId | null) => void;
  onManageConnections?: () => void;
  onSelectionCommitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const available = useMemo(
    () =>
      props.connections.filter(
        (connection) => connection.harness === props.provider && connection.lifecycle === "active",
      ),
    [props.connections, props.provider],
  );
  const choices = useMemo<ConnectionChoice[]>(
    () => [
      ...(props.anonymousRoutes ?? [])
        .filter((route) => route.harness === props.provider)
        .map((route) => ({
          key: `anonymous:${route.internalProviderId}`,
          connectionId: null,
          label: route.label ?? "Free",
          groupLabel: route.groupLabel ?? "Free",
        })),
      ...available.map((connection) => {
        const method = (props.authenticationMethods ?? []).find(
          (candidate) =>
            candidate.harness === connection.harness &&
            candidate.authenticationTargetId === connection.authenticationTargetId &&
            candidate.authenticationMethodId === connection.authenticationMethodId,
        );
        return {
          key: connection.id,
          connectionId: connection.id,
          label: connection.label,
          groupLabel: method?.groupLabel ?? method?.label ?? "Connections",
          connection,
        };
      }),
    ],
    [available, props.anonymousRoutes, props.authenticationMethods, props.provider],
  );
  const selected =
    choices.find((choice) => choice.connectionId === props.selectedConnectionId) ??
    (props.selectedConnectionId === undefined ? choices[0] : undefined);
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: open && available.length > 0,
      provider: props.provider,
      connectionIds: available.map((connection) => connection.id),
    }),
  );
  const snapshots = useMemo(
    () =>
      new Map(
        (usageQuery.data ?? []).flatMap((snapshot) =>
          snapshot.connectionId ? [[snapshot.connectionId, snapshot] as const] : [],
        ),
      ),
    [usageQuery.data],
  );
  if (!selected) return null;

  const selectedConnection = selected.connection;
  const apiKey = selectedConnection ? isApiKeyConnection(selectedConnection) : false;
  const snapshot = selectedConnection ? snapshots.get(selectedConnection.id) : undefined;
  const rows = usageRows(snapshot);
  const title = apiKey ? `${selected.label} API key` : selected.label;

  return (
    <Menu open={open} onOpenChange={setOpen} keepOpenOnSubmenuInteraction>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="Change connection"
                  className="!size-[26px] shrink-0 rounded-full p-0 text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)] sm:!size-[26px] [&_svg]:mx-0"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          {apiKey ? (
            <IconKey aria-hidden="true" className="!size-4" stroke={1.8} />
          ) : (
            <IconUser aria-hidden="true" className="!size-4" stroke={1.8} />
          )}
        </TooltipTrigger>
        {!open ? <TooltipPopup side="top">{title}</TooltipPopup> : null}
      </Tooltip>
      <ComposerPickerMenuPopup align="end" className="w-[244px] min-w-[244px]" side="top">
        <div className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
          Connection
        </div>
        <MenuSub>
          <MenuSubTrigger>
            <span className="min-w-0 truncate">{selected.label}</span>
          </MenuSubTrigger>
          <ComposerPickerMenuSubPopup fixedWidth>
            <ConnectionSwitcher
              choices={choices}
              snapshots={snapshots}
              onConnectionChange={(connectionId) => {
                props.onConnectionChange(connectionId);
                setOpen(false);
                props.onSelectionCommitted?.();
              }}
              {...(props.onManageConnections
                ? {
                    onManageConnections: () => {
                      setOpen(false);
                      props.onManageConnections?.();
                    },
                  }
                : {})}
            />
          </ComposerPickerMenuSubPopup>
        </MenuSub>
        {apiKey ? (
          <div className="space-y-2 px-2 pb-2 pt-1">
            <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
              Usage isn’t available for API keys.
            </p>
            <MenuItem
              onClick={() => {
                const dashboard = dashboardForConnection(selectedConnection!);
                void ensureNativeApi().shell.openExternal(dashboard.url);
                setOpen(false);
              }}
            >
              View usage in {dashboardForConnection(selectedConnection!).label}
              <ExternalLinkIcon className="ml-auto size-3" />
            </MenuItem>
          </div>
        ) : selectedConnection === undefined ? null : rows.length > 0 ? (
          <ConnectionUsageRows rows={rows} />
        ) : (
          <p className="px-2 pb-2 pt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            {usageQuery.isPending ? "Loading usage…" : connectionUsageEmptyMessage(snapshot)}
          </p>
        )}
        {snapshot?.detail && rows.length > 0 ? (
          <p className="px-2 pb-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
            {snapshot.detail}
          </p>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
