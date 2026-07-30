import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

import { SettingsTextAction, SettingsValueAction } from "../shared/SettingsPageControls";

export function SettingsAccountPage() {
  return (
    <SettingsSectionShared title="Account">
      <SettingRowShared
        control={<SettingsValueAction>Claude Opus 5</SettingsValueAction>}
        description="Used when a thread doesn't specify one."
        label="Default model"
      />
      <SettingRowShared
        control={<SettingsTextAction>Replace</SettingsTextAction>}
        description="sk-ant-…4f2a"
        label="Anthropic API key"
      />
    </SettingsSectionShared>
  );
}
