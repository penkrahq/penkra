import type { SettingsPage } from "../modal-settings/ModalSettings";
import { SettingsAccountPage } from "./account/SettingsAccountPage";
import { SettingsAgentsPage } from "./agents/SettingsAgentsPage";
import { SettingsAppearancePage } from "./appearance/SettingsAppearancePage";
import { SettingsAppsPage } from "./apps/SettingsAppsPage";
import { SettingsConnectorsPage } from "./connectors/SettingsConnectorsPage";
import { SettingsGeneralPage } from "./general/SettingsGeneralPage";
import { SettingsPermissionsPage } from "./permissions/SettingsPermissionsPage";

export function SettingsPageContent({ page }: { page: SettingsPage }) {
  switch (page) {
    case "general":
      return <SettingsGeneralPage />;
    case "permissions":
      return <SettingsPermissionsPage />;
    case "agents":
      return <SettingsAgentsPage />;
    case "apps":
      return <SettingsAppsPage />;
    case "connectors":
      return <SettingsConnectorsPage />;
    case "appearance":
      return <SettingsAppearancePage />;
    case "account":
      return <SettingsAccountPage />;
  }
}
