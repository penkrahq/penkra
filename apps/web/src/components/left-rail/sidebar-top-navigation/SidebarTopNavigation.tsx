import { IconSearch, type TablerIcon } from "@tabler/icons-react";

import { NavItemShared } from "../nav-item-shared/NavItemShared";

export interface SidebarNavigationItem {
  icon: TablerIcon;
  id: string;
  label: string;
}

export interface SidebarTopNavigationProps {
  activeItemId?: string;
  disabledItemIds?: ReadonlyArray<string>;
  items?: SidebarNavigationItem[];
  onSelect?: (id: string) => void;
}

const defaultItems: SidebarNavigationItem[] = [{ icon: IconSearch, id: "search", label: "Search" }];

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
