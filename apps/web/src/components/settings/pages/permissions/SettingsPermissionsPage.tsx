import { IconShieldCheck, IconShieldLock } from "@tabler/icons-react";

import { setInstalledAppPermission, useAppInstallationSnapshot } from "~/appInstallationStore";
import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { toastManager } from "~/components/ui/toast";
import { useSpacesUiStore } from "~/spacesUiStore";

export function SettingsPermissionsPage() {
  const snapshot = useAppInstallationSnapshot();
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const apps =
    snapshot?.installed.filter((app) => {
      if (app.spaceId !== activeSpaceId) return false;
      const state = activeSpaceId
        ? snapshot.spaces.find(
            (candidate) => candidate.appId === app.id && candidate.spaceId === activeSpaceId,
          )
        : undefined;
      return (
        app.permissions.length > 0 ||
        Object.keys(state?.permissions ?? {}).some((name) => name in STANDARD_PERMISSION_REASONS)
      );
    }) ?? [];

  if (!snapshot)
    return (
      <p className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)]">
        Loading App permissions…
      </p>
    );
  if (!activeSpaceId)
    return (
      <p className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)]">
        Open a Space to manage its App permissions.
      </p>
    );
  if (apps.length === 0)
    return (
      <div
        className="flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] px-6 py-8 text-center"
        data-pencil-page="permissions"
      >
        <IconShieldCheck className="size-6 text-[var(--color-text-foreground-tertiary)]" />
        <p className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-[var(--color-text-foreground)]">
          No additional permissions
        </p>
        <p className="max-w-80 text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-[var(--color-text-foreground-tertiary)]">
          Installed Apps have not requested additional permissions.
        </p>
      </div>
    );

  return (
    <div className="flex flex-col gap-4" data-pencil-page="permissions">
      {apps.map((app) => {
        const space = snapshot.spaces.find(
          (candidate) => candidate.appId === app.id && candidate.spaceId === activeSpaceId,
        );
        return (
          <section
            className="overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)]"
            key={`${app.spaceId}:${app.id}`}
          >
            <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
              <IconShieldLock className="size-4 text-[var(--color-text-foreground-secondary)]" />
              <div className="min-w-0">
                <h3 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-[var(--color-text-foreground)]">
                  {app.name}
                </h3>
                <p className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
                  Permissions for this Space
                </p>
              </div>
            </header>
            <div className="divide-y divide-[var(--color-border)]">
              {permissionRows(app.permissions, space?.permissions ?? {}).map((permission) => {
                const granted = space?.permissions[permission.name] === "granted";
                return (
                  <div className="flex min-h-16 items-center gap-4 px-4 py-3" key={permission.name}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground)]">
                        {permissionLabel(permission.name)}
                      </span>
                      <span className="block text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-[var(--color-text-foreground-tertiary)]">
                        {permission.reason}
                        {permission.audience ? ` Audience: ${permission.audience}.` : ""}
                        {permission.required ? " Required while the App is enabled." : " Optional."}
                      </span>
                    </span>
                    <SwitchShared
                      aria-label={`${app.name} ${permissionLabel(permission.name)}`}
                      checked={granted}
                      onCheckedChange={(checked) => {
                        void setInstalledAppPermission({
                          appId: app.id,
                          spaceId: activeSpaceId,
                          permission: permission.name,
                          grant: checked ? "granted" : "denied",
                        }).catch((error: unknown) => {
                          toastManager.add({
                            type: "error",
                            title: "Permission did not change",
                            description:
                              error instanceof Error
                                ? error.message
                                : "The App permission update failed.",
                          });
                        });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function permissionLabel(permission: string): string {
  return permission
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const STANDARD_PERMISSION_REASONS: Readonly<Record<string, string>> = {
  microphone: "Use the microphone after a runtime request.",
  camera: "Use the camera after a runtime request.",
  notifications: "Show attributed desktop notifications.",
  "clipboard-read": "Read clipboard contents after a runtime request.",
};

function permissionRows(
  declared: ReadonlyArray<{
    name: string;
    required: boolean;
    reason: string;
    audience?: string;
  }>,
  grants: Readonly<Record<string, "denied" | "granted">>,
) {
  const rows = [...declared];
  for (const name of Object.keys(grants)) {
    if (
      name in STANDARD_PERMISSION_REASONS &&
      !rows.some((permission) => permission.name === name)
    ) {
      rows.push({ name, required: false, reason: STANDARD_PERMISSION_REASONS[name]! });
    }
  }
  return rows;
}
