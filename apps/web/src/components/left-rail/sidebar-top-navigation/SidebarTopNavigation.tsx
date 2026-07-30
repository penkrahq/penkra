import { IconAlarm, IconEdit, IconLayoutGrid } from "@tabler/icons-react";
import type { ComponentType, SVGProps } from "react";

import { NavItemShared } from "../nav-item-shared/NavItemShared";

export interface SidebarNavigationItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  id: string;
  label: string;
}

export interface SidebarTopNavigationProps {
  activeItemId?: string;
  disabledItemIds?: ReadonlyArray<string>;
  items?: SidebarNavigationItem[];
  onSelect?: (id: string) => void;
}

const defaultItems: SidebarNavigationItem[] = [
  { icon: IconEdit, id: "new-chat", label: "New chat" },
  { icon: IconLayoutGrid, id: "apps", label: "Apps" },
  { icon: IconAlarm, id: "scheduled", label: "Scheduled" },
];

export function SidebarTopNavigation({
  activeItemId,
  disabledItemIds = [],
  items = defaultItems,
  onSelect,
}: SidebarTopNavigationProps) {
  return (
    <nav aria-label="Primary" className="flex w-60 flex-col gap-0.5 px-2 py-1">
      {items.map(({ icon: Icon, id, label }) => (
        <NavItemShared
          disabled={disabledItemIds.includes(id)}
          icon={<Icon />}
          key={id}
          onClick={() => onSelect?.(id)}
          state={activeItemId === id ? "selected" : "default"}
        >
          {label}
        </NavItemShared>
      ))}
    </nav>
  );
}
