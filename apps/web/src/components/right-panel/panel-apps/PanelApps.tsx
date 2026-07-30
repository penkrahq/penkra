import { IconBrandNotion, IconBrandSlack, IconBrowser } from "@tabler/icons-react";

import { GitHubIcon } from "~/components/Icons";

import { AppListRowShared } from "../app-list-row-shared/AppListRowShared";
import { RightPanelShared } from "../right-panel-shared/RightPanelShared";

export function PanelAppsContent() {
  return (
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
    </div>
  );
}

export function PanelApps() {
  return (
    <RightPanelShared>
      <PanelAppsContent />
    </RightPanelShared>
  );
}
