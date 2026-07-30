import type { ReactNode } from "react";

import { AccountControlShared } from "../account-control-shared/AccountControlShared";
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
      className="flex h-[900px] w-60 flex-col overflow-hidden bg-[var(--color-background-surface)]"
      data-pencil-component="UPCCE"
    >
      <SidebarHeaderShared />
      <SidebarTopNavigation
        {...(activeNavigationItemId === undefined ? {} : { activeItemId: activeNavigationItemId })}
        {...(onNavigationSelect === undefined ? {} : { onSelect: onNavigationSelect })}
      />
      <SidebarProjects>{children}</SidebarProjects>
      <AccountControlShared accountName={accountName} />
    </aside>
  );
}
