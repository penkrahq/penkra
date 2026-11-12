import { useCallback, useEffect, useState } from "react";
import type {
  DesktopSystemPermissionKind,
  DesktopSystemPermissionStatus,
  DesktopSystemPermissions,
} from "@penkra/contracts";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

export interface ComputerUsePermissionsSharedProps {
  permissions: DesktopSystemPermissions | null;
  onOpen: (permission: DesktopSystemPermissionKind) => void;
}

/**
 * The macOS grants every thread shares (P57 step 5, P58): the two Computer Use needs, and Full Disk Access.
 * Each switch shows the real grant; tapping it opens the pane where macOS changes it.
 */
export function ComputerUsePermissionsShared({
  permissions,
  onOpen,
}: ComputerUsePermissionsSharedProps) {
  if (permissions?.accessibility === "unsupported") return null;
  const allowed =
    permissions?.accessibility === "granted" &&
    permissions.screenRecording === "granted";
  const paneName = permissions?.accessibilityPaneName ?? "Accessibility";
  return (
    <SettingsSectionShared title="Computer Use">
      <PermissionRow
        description="Lets threads click, type and read the controls of other apps."
        label={paneName}
        onOpen={() => onOpen("accessibility")}
        status={permissions?.accessibility}
        paneName={paneName}
      />
      <PermissionRow
        description="Lets threads see what's on screen."
        label="Screen Recording"
        onOpen={() => onOpen("screen-recording")}
        status={permissions?.screenRecording}
        paneName="Screen Recording"
      />
      <PermissionRow
        description="Lets threads open any folder without macOS asking first, including Desktop, Documents and Downloads. Optional: without it, macOS asks once per folder."
        label="Full Disk Access"
        onOpen={() => onOpen("full-disk-access")}
        status={permissions?.fullDiskAccess}
        paneName="Full Disk Access"
      />
      <p className="py-3 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-[var(--color-text-foreground-tertiary)]">
        {permissions === null
          ? "Checking permissions…"
          : allowed
            ? "Threads can use the computer. Every thread shares Penkra's access."
            : `Threads can use the computer once ${paneName} and Screen Recording are allowed. Turn one on to open System Settings, allow Penkra there, then come back.`}
      </p>
    </SettingsSectionShared>
  );
}

function PermissionRow({
  description,
  label,
  onOpen,
  paneName,
  status,
}: {
  description: string;
  label: string;
  onOpen: () => void;
  paneName: string;
  status: DesktopSystemPermissionStatus | undefined;
}) {
  const granted = status === "granted";
  return (
    <SettingRowShared
      control={
        <SwitchShared
          aria-label={`${label}: ${granted ? "allowed" : "not allowed"}. Opens System Settings.`}
          checked={granted}
          disabled={status === undefined}
          onCheckedChange={() => onOpen()}
        />
      }
      description={description}
      label={label}
      status={
        status === undefined
          ? null
          : granted
            ? "Allowed"
            : `Not allowed. Opens System Settings → Privacy & Security → ${paneName}.`
      }
    />
  );
}

/** Reads the grants now and again whenever Penkra regains focus, so a change made in System Settings shows on return. */
export function useComputerUsePermissions() {
  const bridge =
    typeof window === "undefined"
      ? undefined
      : window.desktopBridge?.systemPermissions;
  const [permissions, setPermissions] =
    useState<DesktopSystemPermissions | null>(null);
  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge.get().then(setPermissions, () => undefined);
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    // macOS applies some grants a moment after the switch flips; poll lightly while a grant is missing.
    const timer = window.setInterval(refresh, 2000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [bridge, refresh]);
  const open = useCallback(
    (permission: DesktopSystemPermissionKind) => {
      if (!bridge) return;
      void bridge.open(permission).then(refresh, () => undefined);
    },
    [bridge, refresh],
  );
  return { available: Boolean(bridge), permissions, open };
}
