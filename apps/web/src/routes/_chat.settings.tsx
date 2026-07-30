// FILE: _chat.settings.tsx
// Purpose: Route the Settings dialog and its Pencil-defined page components.
// Layer: Route screen
// Exports: Settings route component for `/settings`

import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";

import type { SettingsPage } from "../components/settings/modal-settings/ModalSettings";
import { SettingsDialog } from "../components/settings/modal-settings/SettingsDialog";
import { SettingsPageContent } from "../components/settings/pages/SettingsPageContent";
import { normalizeSettingsSection, type SettingsSectionId } from "../settingsNavigation";

const SETTINGS_SECTION_BY_PAGE: Readonly<Record<SettingsPage, SettingsSectionId>> = {
  general: "general",
  permissions: "behavior",
  agents: "providers",
  apps: "appsnap",
  connectors: "integrations",
  appearance: "appearance",
  account: "profile",
};

function settingsPageFromSection(section: SettingsSectionId): SettingsPage {
  if (section === "appearance") return "appearance";
  if (section === "profile") return "account";
  if (
    section === "models" ||
    section === "providers" ||
    section === "skills" ||
    section === "usage"
  ) {
    return "agents";
  }
  if (section === "appsnap") return "apps";
  if (section === "integrations") return "connectors";
  if (section === "behavior" || section === "advanced") return "permissions";
  return "general";
}

function SettingsRouteView() {
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activePage = settingsPageFromSection(normalizeSettingsSection(routeSearch.section));

  return (
    <SettingsDialog
      onClose={() => {
        void navigate({ to: "/" });
      }}
      onPageChange={(page) => {
        const section = SETTINGS_SECTION_BY_PAGE[page];
        void navigate({
          to: "/settings",
          search: {
            section: section === "general" ? undefined : section,
          },
        });
      }}
      page={activePage}
    >
      <SettingsPageContent page={activePage} />
    </SettingsDialog>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
