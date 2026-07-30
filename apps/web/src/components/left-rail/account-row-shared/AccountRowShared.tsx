import { IconAdjustmentsHorizontal, IconLifebuoy } from "@tabler/icons-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { AvatarAccount } from "~/components/foundations/avatar-account/AvatarAccount";
import { cn } from "~/lib/utils";

export interface AccountRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  accountButtonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">;
  accountButtonWrapper?: (button: ReactElement) => ReactNode;
  disabled?: boolean;
  name?: string;
  onAccount?: () => void;
  onHelp?: () => void;
  onSettings?: () => void;
  onUpdate?: () => void;
  selected?: boolean;
  updateAvailable?: boolean;
  updateDisabled?: boolean;
  updateLabel?: string;
}

export const AccountRowShared = forwardRef<HTMLDivElement, AccountRowSharedProps>(
  function AccountRowShared(
    {
      accountButtonProps,
      accountButtonWrapper,
      className,
      disabled = false,
      name = "gigsama",
      onAccount,
      onHelp,
      onSettings,
      onUpdate,
      selected = false,
      updateAvailable = false,
      updateDisabled = false,
      updateLabel = "Update",
      ...props
    },
    ref,
  ) {
    const accountButton = (
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-inherit outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        disabled={disabled}
        onClick={onAccount}
        type="button"
        {...accountButtonProps}
      >
        <AvatarAccount />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      </button>
    );

    return (
      <div
        className={cn(
          "group/account-row flex h-11 w-60 items-center gap-2 rounded-[6px] bg-transparent px-2.5 font-sans text-[13px] text-[var(--color-text-foreground-secondary)] transition-colors hover:text-[var(--color-text-foreground)]",
          selected && "text-[var(--color-text-foreground)]",
          disabled &&
            "pointer-events-none bg-transparent text-[var(--color-text-foreground-tertiary)] hover:bg-transparent",
          className,
        )}
        data-selected={selected || undefined}
        ref={ref}
        {...props}
      >
        {accountButtonWrapper ? accountButtonWrapper(accountButton) : accountButton}
        {updateAvailable ? (
          onUpdate ? (
            <button
              aria-label={updateLabel}
              aria-disabled={updateDisabled || undefined}
              className="cursor-pointer rounded-full border-0 bg-[var(--color-background-accent)] px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-[var(--color-text-button-primary)] outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
              disabled={disabled || updateDisabled}
              onClick={onUpdate}
              type="button"
            >
              {updateLabel}
            </button>
          ) : (
            <span className="rounded-full bg-[var(--color-background-accent)] px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-[var(--color-text-button-primary)]">
              {updateLabel}
            </span>
          )
        ) : null}
        <button
          aria-label="Settings"
          className="inline-flex size-3.5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-tertiary)] outline-none group-hover/account-row:text-[var(--color-text-foreground)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          disabled={disabled}
          onClick={onSettings}
          type="button"
        >
          <IconAdjustmentsHorizontal className="size-3.5" />
        </button>
        <button
          aria-label="Help"
          className="inline-flex size-3.5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-tertiary)] outline-none group-hover/account-row:text-[var(--color-text-foreground)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          disabled={disabled}
          onClick={onHelp}
          type="button"
        >
          <IconLifebuoy className="size-3.5" />
        </button>
      </div>
    );
  },
);
