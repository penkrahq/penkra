"use client";

import {
  IconChevronRight,
  IconHelpCircle,
  IconLogout,
  IconMessage,
  IconSettings,
} from "@tabler/icons-react";
import { useRef, useState } from "react";

import {
  Menu,
  MenuItem,
  MenuPopupBase,
  MenuSeparator,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { AccountRowShared } from "../account-row-shared/AccountRowShared";

export interface AccountMenuProps {
  accountName?: string;
  defaultOpen?: boolean;
  onFeedback?: () => void;
  onLogout?: () => void;
  onSettings?: () => void;
  onSupport?: () => void;
}

const itemClassName =
  "h-[29px] gap-2 rounded-md px-2.5 text-[13px] text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)] [&_svg]:size-3.5";

export function AccountMenu({
  accountName = "gigsama",
  defaultOpen,
  onFeedback,
  onLogout,
  onSettings,
  onSupport,
}: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <AccountRowShared
        accountButtonProps={{ "aria-expanded": open, "aria-haspopup": "menu" }}
        name={accountName}
        onAccount={() => setOpen((current) => !current)}
        ref={anchorRef}
      />
      <MenuPopupBase
        align="start"
        anchor={anchorRef}
        className="w-[220px] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-1.5"
        side="top"
      >
        <MenuItem className={itemClassName} onClick={onSettings}>
          <IconSettings />
          <span className="flex-1">Settings</span>
          <IconChevronRight className="text-[var(--color-text-foreground-tertiary)]" />
        </MenuItem>
        <MenuItem className={itemClassName} onClick={onFeedback}>
          <IconMessage />
          <span className="flex-1">Give Feedback</span>
          <IconChevronRight className="text-[var(--color-text-foreground-tertiary)]" />
        </MenuItem>
        <MenuItem className={itemClassName} onClick={onSupport}>
          <IconHelpCircle />
          <span className="flex-1">Support Us</span>
          <IconChevronRight className="text-[var(--color-text-foreground-tertiary)]" />
        </MenuItem>
        <MenuSeparator className="my-1 bg-[var(--color-border)]" />
        <MenuItem className={cn(itemClassName, "w-full")} onClick={onLogout}>
          <IconLogout />
          <span className="flex-1">Log Out</span>
          <IconChevronRight className="text-[var(--color-text-foreground-tertiary)]" />
        </MenuItem>
      </MenuPopupBase>
    </Menu>
  );
}
