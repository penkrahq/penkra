import {
  IconAlarm,
  IconApps,
  IconLayoutGrid,
  IconPencil,
  IconSearch,
} from "@tabler/icons-react";
import type { ComponentType, SVGProps } from "react";

import { NavItemShared } from "../nav-item-shared/NavItemShared";

export interface SidebarNavigationItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  id: string;
  label: string;
}

export interface SidebarTopNavigationProps {
  activeItemId?: string;
  items?: SidebarNavigationItem[];
  onSelect?: (id: string) => void;
}

const defaultItems: SidebarNavigationItem[] = [
  { icon: IconSearch, id: "search", label: "Search" },
  { icon: IconPencil, id: "new-chat", label: "New chat" },
  { icon: IconLayoutGrid, id: "sites", label: "Sites" },
  { icon: IconAlarm, id: "scheduled", label: "Scheduled" },
  { icon: IconApps, id: "apps", label: "Apps" },
];

export function SidebarTopNavigation({
  activeItemId,
  items = defaultItems,
  onSelect,
}: SidebarTopNavigationProps) {
  return (
    <nav aria-label="Primary" className="flex w-60 flex-col gap-0.5 px-2 py-1">
      {items.map(({ icon: Icon, id, label }) => (
        <NavItemShared
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
