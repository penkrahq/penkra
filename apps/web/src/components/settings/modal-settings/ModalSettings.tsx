import {
  IconApps,
  IconBrush,
  IconKey,
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

export type SettingsPage =
  | "general"
  | "permissions"
  | "agents"
  | "apps"
  | "connectors"
  | "appearance"
  | "account";

export interface ModalSettingsProps {
  children?: ReactNode;
  className?: string;
  onPageChange?: (page: SettingsPage) => void;
  page?: SettingsPage;
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

export function ModalSettings({
  children,
  className,
  onPageChange,
  page = "general",
}: ModalSettingsProps) {
  const activePage = pages.find((item) => item.id === page) ?? pages[0];
  return (
    <section
      aria-label="Settings"
      className={cn(
        "flex h-[640px] w-[880px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)]",
        className,
      )}
      data-pencil-component="BvoZF"
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
        <div className="mx-auto flex w-[440px] flex-col gap-7 py-8">
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
      </ScrollArea>
    </section>
  );
}
