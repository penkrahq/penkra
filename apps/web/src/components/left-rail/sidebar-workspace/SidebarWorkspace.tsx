import type { ReactNode } from "react";

import { AccountMenu } from "../menu-account/AccountMenu";
import { SidebarHeaderShared } from "../sidebar-header-shared/SidebarHeaderShared";
import { SidebarProjects } from "../sidebar-projects/SidebarProjects";
import { SidebarTopNavigation } from "../sidebar-top-navigation/SidebarTopNavigation";

export interface SidebarWorkspaceProps {
  accountName?: string;
  activeNavigationItemId?: string;
  children: ReactNode;
  onNavigationSelect?: (id: string) => void;
}

export function SidebarWorkspace({
  accountName = "gigsama",
  activeNavigationItemId,
  children,
  onNavigationSelect,
}: SidebarWorkspaceProps) {
  return (
    <aside
      aria-label="Workspace"
      className="flex h-[900px] w-60 flex-col overflow-hidden bg-[#0b0c10]"
      data-pencil-component="UPCCE"
    >
      <SidebarHeaderShared />
      <SidebarTopNavigation
        activeItemId={activeNavigationItemId}
        onSelect={onNavigationSelect}
      />
      <SidebarProjects>{children}</SidebarProjects>
      <AccountMenu accountName={accountName} />
    </aside>
  );
}
