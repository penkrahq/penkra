"use client";

import { useState } from "react";

import {
  Menu,
  MenuItem,
  MenuPopupBase,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";

import { AccountRowShared } from "../account-row-shared/AccountRowShared";
import { AccountMenuIcon, type AccountMenuIconName } from "./AccountMenuIcon";

export interface AccountMenuProps {
  accountName?: string;
  defaultOpen?: boolean;
  onFeedback?: () => void;
  onLogout?: () => void;
  onSettings?: () => void;
  onSupport?: () => void;
  onUpdate?: () => void;
  updateAvailable?: boolean;
  updateDisabled?: boolean;
  updateLabel?: string;
}

const itemClassName =
  "grid h-[29px] w-[206px] cursor-pointer grid-cols-[14px_144px_14px] items-center gap-2 rounded-[6px] px-2.5 font-sans text-[13px] font-normal text-[#ffffff94] outline-none hover:bg-[#ffffff0a] hover:text-[#ffffff94] focus-visible:bg-[#ffffff0a] data-highlighted:bg-[#ffffff0a]";

interface AccountMenuItemProps {
  icon: Exclude<AccountMenuIconName, "chevron">;
  label: string;
  onClick?: () => void;
}

function AccountMenuItem({ icon, label, onClick }: AccountMenuItemProps) {
  return (
    <MenuItem appearance="plain" className={itemClassName} onClick={onClick}>
      <AccountMenuIcon className="size-3.5 text-[#ffffff94]" name={icon} />
      <span>{label}</span>
      <AccountMenuIcon className="size-3.5 text-[#ffffff54]" name="chevron" />
    </MenuItem>
  );
}

export function AccountMenu({
  accountName = "gigsama",
  defaultOpen,
  onFeedback,
  onLogout,
  onSettings,
  onSupport,
  onUpdate,
  updateAvailable,
  updateDisabled,
  updateLabel,
}: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <AccountRowShared
        accountButtonProps={{ "aria-expanded": open, "aria-haspopup": "menu" }}
        accountButtonWrapper={(button) => <MenuTrigger render={button} />}
        name={accountName}
        onHelp={onSupport}
        onSettings={onSettings}
        onUpdate={onUpdate}
        updateAvailable={updateAvailable}
        updateDisabled={updateDisabled}
        updateLabel={updateLabel}
      />
      <MenuPopupBase
        align="start"
        className="box-border h-[139px] w-[220px] flex-col rounded-[10px] border-[#ffffff12] bg-[#1a1a1a] p-1.5 [border-width:1px]"
        side="top"
        surface="bare"
      >
        <AccountMenuItem icon="settings" label="Settings" onClick={onSettings} />
        <AccountMenuItem icon="feedback" label="Give Feedback" onClick={onFeedback} />
        <AccountMenuItem icon="support" label="Support Us" onClick={onSupport} />
        <div className="flex h-[9px] w-[206px] items-center px-1">
          <MenuSeparator className="m-0 h-px w-[198px] bg-[#ffffff12]" />
        </div>
        <AccountMenuItem icon="logout" label="Log Out" onClick={onLogout} />
      </MenuPopupBase>
    </Menu>
  );
}
