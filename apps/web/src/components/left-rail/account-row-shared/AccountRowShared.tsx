import { IconHelpCircle, IconSettings } from "@tabler/icons-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react";

import { AvatarAccount } from "~/components/foundations/avatar-account/AvatarAccount";
import { cn } from "~/lib/utils";

export interface AccountRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  accountButtonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">;
  disabled?: boolean;
  name?: string;
  onAccount?: () => void;
  onHelp?: () => void;
  onSettings?: () => void;
  selected?: boolean;
  updateAvailable?: boolean;
}

export const AccountRowShared = forwardRef<HTMLDivElement, AccountRowSharedProps>(
  function AccountRowShared(
    {
      accountButtonProps,
      className,
      disabled = false,
      name = "gigsama",
      onAccount,
      onHelp,
      onSettings,
      selected = false,
      updateAvailable = false,
      ...props
    },
    ref,
  ) {
    return (
      <div
      className={cn(
        "group/account-row flex h-9 w-60 items-center gap-2 bg-transparent px-2 font-sans text-[13px] text-[var(--pencil-text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--pencil-text-primary)]",
        selected && "bg-[var(--pencil-disabled)] text-[var(--pencil-text-primary)]",
        disabled &&
          "pointer-events-none bg-transparent text-[var(--pencil-border-hover)] hover:bg-transparent",
        className,
      )}
        data-selected={selected || undefined}
        ref={ref}
        {...props}
      >
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-inherit outline-none focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
          disabled={disabled}
          onClick={onAccount}
          type="button"
          {...accountButtonProps}
        >
        <AvatarAccount />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {updateAvailable ? (
          <span className="rounded-full bg-[var(--pencil-accent)] px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-[var(--pencil-white)]">
            Update
          </span>
        ) : null}
        </button>
        <button
        aria-label="Settings"
        className="inline-flex size-3.5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--pencil-text-tertiary)] outline-none hover:text-[var(--pencil-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
        disabled={disabled}
        onClick={onSettings}
        type="button"
      >
        <IconSettings className="size-3.5" />
        </button>
        <button
        aria-label="Help"
        className="inline-flex size-3.5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--pencil-text-tertiary)] outline-none hover:text-[var(--pencil-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
        disabled={disabled}
        onClick={onHelp}
        type="button"
      >
        <IconHelpCircle className="size-3.5" />
        </button>
      </div>
    );
  },
);
