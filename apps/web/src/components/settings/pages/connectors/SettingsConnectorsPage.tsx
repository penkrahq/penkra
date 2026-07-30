import { IconCalendar, IconListCheck, IconMail, IconNotes } from "@tabler/icons-react";

import { SettingsConnectorRow } from "../shared/SettingsPageControls";

export function SettingsConnectorsPage() {
  return (
    <div className="flex flex-col gap-2.5" data-pencil-page="connectors">
      <SettingsConnectorRow
        description="Read and create calendar events."
        icon={IconCalendar}
        label="Calendar"
      />
      <SettingsConnectorRow
        description="Create and complete reminders."
        icon={IconListCheck}
        label="Reminders"
      />
      <SettingsConnectorRow
        defaultChecked={false}
        description="Read and send email on your behalf."
        icon={IconMail}
        label="Mail"
      />
      <SettingsConnectorRow description="Read and write notes." icon={IconNotes} label="Notes" />
    </div>
  );
}
