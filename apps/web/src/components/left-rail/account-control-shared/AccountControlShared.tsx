"use client";

import { useRef, useState } from "react";

import { Menu, MenuTrigger } from "~/components/ui/menu";

import { AccountRowShared, type AccountUpdatePhase } from "../account-row-shared/AccountRowShared";
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
  updatePhase?: AccountUpdatePhase;
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
  updatePhase,
}: AccountControlSharedProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const accountRowRef = useRef<HTMLDivElement>(null);

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <div data-pencil-component="ptpcV">
        <AccountRowShared
          accountButtonProps={{ "aria-expanded": open, "aria-haspopup": "menu" }}
          accountButtonWrapper={(button) => <MenuTrigger render={button} />}
          name={accountName}
          selected={open}
          ref={accountRowRef}
          {...(onSupport === undefined ? {} : { onHelp: onSupport })}
          {...(onUpdate === undefined ? {} : { onUpdate })}
          {...(updateAvailable === undefined ? {} : { updateAvailable })}
          {...(updateDisabled === undefined ? {} : { updateDisabled })}
          {...(updateLabel === undefined ? {} : { updateLabel })}
          {...(updatePhase === undefined ? {} : { updatePhase })}
        />
        <AccountMenu
          anchor={accountRowRef}
          {...(onFeedback === undefined ? {} : { onFeedback })}
          {...(onLogout === undefined ? {} : { onLogout })}
          {...(onSettings === undefined ? {} : { onSettings })}
          {...(onSupport === undefined ? {} : { onSupport })}
        />
      </div>
    </Menu>
  );
}
