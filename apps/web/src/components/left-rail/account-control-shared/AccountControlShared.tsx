"use client";

import { useState } from "react";

import { Menu, MenuTrigger } from "~/components/ui/menu";

import { AccountRowShared } from "../account-row-shared/AccountRowShared";
import { AccountMenu } from "../menu-account/AccountMenu";

export interface AccountControlSharedProps {
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

export function AccountControlShared({
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
}: AccountControlSharedProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <div data-pencil-component="ptpcV">
        <AccountRowShared
          accountButtonProps={{ "aria-expanded": open, "aria-haspopup": "menu" }}
          accountButtonWrapper={(button) => <MenuTrigger render={button} />}
          name={accountName}
          onHelp={onSupport}
          onSettings={onSettings}
          onUpdate={onUpdate}
          selected={open}
          updateAvailable={updateAvailable}
          updateDisabled={updateDisabled}
          updateLabel={updateLabel}
        />
        <AccountMenu
          onFeedback={onFeedback}
          onLogout={onLogout}
          onSettings={onSettings}
          onSupport={onSupport}
        />
      </div>
    </Menu>
  );
}
