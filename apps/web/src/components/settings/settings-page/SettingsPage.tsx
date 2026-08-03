import {
  IconApps,
  IconBrush,
  IconKey,
  IconFolders,
  IconPlug,
  IconRobot,
  IconSettings,
  IconUser,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { SettingsNavRowShared } from "../nav-row-shared/SettingsNavRowShared";
import { SettingRowShared } from "../setting-row-shared/SettingRowShared";
import { SettingsHeader } from "../settings-header/SettingsHeader";
import { SettingsSectionShared } from "../settings-section-shared/SettingsSectionShared";

export type SettingsPageId =
  | "general"
  | "permissions"
  | "spaces"
  | "agents"
  | "apps"
  | "connectors"
  | "appearance"
  | "account";

export interface SettingsPageProps {
  children?: ReactNode;
  className?: string;
  onPageChange?: (page: SettingsPageId) => void;
  page?: SettingsPageId;
}

const pages = [
  {
    icon: IconSettings,
    id: "general",
    label: "General",
    subtitle: "Defaults and updates for Penkra.",
  },
  {
    icon: IconKey,
    id: "permissions",
    label: "Permissions",
    subtitle: "Review pending access requests and manage alerts.",
  },
  {
    icon: IconFolders,
    id: "spaces",
    label: "Spaces",
    subtitle: "Create, rename, and organize the Spaces in your left rail.",
  },
  {
    icon: IconRobot,
    id: "agents",
    label: "Agents",
    subtitle: "Choose which coding agent runs your threads.",
  },
  {
    icon: IconApps,
    id: "apps",
    label: "Apps",
    subtitle: "Installed apps from the Penkra registry.",
  },
  {
    icon: IconPlug,
    id: "connectors",
    label: "Connectors",
    subtitle: "Link external services and integrations.",
  },
  {
    icon: IconBrush,
    id: "appearance",
    label: "Appearance",
    subtitle: "Customize the look and feel of Penkra.",
  },
  {
    icon: IconUser,
    id: "account",
    label: "Account",
    subtitle: "Manage your profile and preferences.",
  },
] as const;

const SETTINGS_PAGE_CONTENT_WIDTH_CLASS_NAME: Record<SettingsPageId, string> = {
  general: "max-w-[440px]",
  permissions: "max-w-[440px]",
  spaces: "max-w-[596px]",
  agents: "max-w-[440px]",
  apps: "max-w-[440px]",
  connectors: "max-w-[440px]",
  appearance: "max-w-[560px]",
  account: "max-w-[440px]",
};

export function SettingsPage({
  children,
  className,
  onPageChange,
  page = "general",
}: SettingsPageProps) {
  const activePage = pages.find((item) => item.id === page) ?? pages[0];

  return (
    <main
      aria-label="Settings"
      className={cn(
        "flex h-full min-h-0 w-full overflow-hidden bg-[var(--color-background-surface)]",
        className,
      )}
      data-pencil-surface="settings-page"
    >
      <nav
        aria-label="Settings pages"
        className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-[var(--color-border)] p-3"
      >
        {pages.map(({ icon: Icon, id, label }) => (
          <SettingsNavRowShared
            icon={<Icon />}
            key={id}
            onClick={() => onPageChange?.(id)}
            selected={page === id}
          >
            {label}
          </SettingsNavRowShared>
        ))}
      </nav>
      <ScrollArea
        aria-label={`${activePage.label} settings`}
        className="h-full min-h-0 flex-1"
        data-pencil-region="settings-content"
        scrollFade
      >
        <div className="w-full px-8 py-8">
          <div
            className={cn(
              "mx-auto flex w-full flex-col gap-7",
              SETTINGS_PAGE_CONTENT_WIDTH_CLASS_NAME[page],
            )}
          >
            <SettingsHeader subtitle={activePage.subtitle} title={activePage.label} />
            {children ?? (
              <SettingsSectionShared>
                {Array.from({ length: 12 }, (_, index) => (
                  <SettingRowShared
                    control={
                      <SwitchShared
                        aria-label={`Setting ${index + 1}`}
                        defaultChecked={index % 2 === 0}
                      />
                    }
                    description="This preference is saved automatically."
                    key={index}
                    label={`Setting ${index + 1}`}
                  />
                ))}
              </SettingsSectionShared>
            )}
          </div>
        </div>
      </ScrollArea>
    </main>
  );
}
