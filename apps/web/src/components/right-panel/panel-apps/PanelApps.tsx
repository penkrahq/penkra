import { IconBrandNotion, IconBrandSlack, IconBrowser, IconTerminal } from "@tabler/icons-react";

import { GitHubIcon } from "~/components/Icons";

import { AppListRowShared } from "../app-list-row-shared/AppListRowShared";
import { RightPanelShared } from "../right-panel-shared/RightPanelShared";

export function PanelApps() {
  return (
    <RightPanelShared>
      <div className="flex w-[260px] flex-col gap-0.5" data-pencil-component="nT768">
        <AppListRowShared icon={<GitHubIcon />} selected shortcut="⌃⇧G">
          GitHub
        </AppListRowShared>
        <AppListRowShared icon={<IconBrandNotion />} shortcut="⌃⇧N">
          Notion
        </AppListRowShared>
        <AppListRowShared icon={<IconBrandSlack />} shortcut="⌃⇧S">
          Slack
        </AppListRowShared>
        <AppListRowShared icon={<IconBrowser />}>Browser</AppListRowShared>
        <AppListRowShared>Linear</AppListRowShared>
        <AppListRowShared icon={<IconTerminal />}>Terminal</AppListRowShared>
      </div>
    </RightPanelShared>
  );
}
