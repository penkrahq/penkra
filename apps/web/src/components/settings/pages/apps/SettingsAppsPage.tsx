import { IconPackage, IconSquareCheck, IconWorld } from "@tabler/icons-react";

import { SettingsInstalledRow } from "../shared/SettingsPageControls";

export function SettingsAppsPage() {
  return (
    <div className="flex flex-col gap-2.5" data-pencil-page="apps">
      <SettingsInstalledRow
        description="Sync invoices and reconcile expenses automatically."
        icon={IconPackage}
        label="Ledger"
        multiline
      />
      <SettingsInstalledRow
        description="Lets agents browse and read the web."
        icon={IconWorld}
        label="Browser"
      />
      <SettingsInstalledRow
        defaultChecked={false}
        description="Create and update Linear issues from threads."
        icon={IconSquareCheck}
        label="Linear"
      />
    </div>
  );
}
