import type { SettingsPageId } from "../settings-page/SettingsPage";
import { SettingsAccountPage } from "./account/SettingsAccountPage";
import { SettingsAgentsPage } from "./agents/SettingsAgentsPage";
import { SettingsAppearancePage } from "./appearance/SettingsAppearancePage";
import { SettingsAppsPage } from "./apps/SettingsAppsPage";
import { SettingsGeneralPage } from "./general/SettingsGeneralPage";
import { SettingsPermissionsPage } from "./permissions/SettingsPermissionsPage";
import { SettingsSpacesPage } from "./spaces/SettingsSpacesPage";

export function SettingsPageContent({ page }: { page: SettingsPageId }) {
  switch (page) {
    case "general":
      return <SettingsGeneralPage />;
    case "permissions":
      return <SettingsPermissionsPage />;
    case "spaces":
      return <SettingsSpacesPage />;
    case "agents":
      return <SettingsAgentsPage />;
    case "apps":
      return <SettingsAppsPage />;
    case "appearance":
      return <SettingsAppearancePage />;
    case "account":
      return <SettingsAccountPage />;
  }
}
