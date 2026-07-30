import { AgentRowShared } from "~/components/settings/agent-row-shared/AgentRowShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

import { SettingsTextAction, SettingsValueAction } from "../shared/SettingsPageControls";

export function SettingsAgentsPage() {
  return (
    <div className="flex flex-col gap-6" data-pencil-page="agents">
      <div className="divide-y divide-[var(--color-border)] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5">
        <AgentRowShared detail="Connected" label="Claude Agent" provider="claudeAgent" />
        <AgentRowShared detail="Not connected" label="Codex" provider="codex" />
        <AgentRowShared detail="Not connected" label="OpenCode" provider="opencode" />
      </div>

      <SettingsSectionShared title="Model & Access">
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
    </div>
  );
}
