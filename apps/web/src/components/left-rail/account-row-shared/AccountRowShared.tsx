import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { AvatarAccount } from "~/components/foundations/avatar-account/AvatarAccount";
import { cn } from "~/lib/utils";
import { CircleQuestionIcon, LoaderCircleIcon } from "~/lib/icons";

export type AccountUpdatePhase = "none" | "preparing" | "downloading" | "ready" | "installing";

export interface AccountRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  accountButtonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">;
  accountButtonWrapper?: (button: ReactElement) => ReactNode;
  disabled?: boolean;
  name?: string;
  onAccount?: () => void;
  onHelp?: () => void;
  onUpdate?: () => void;
  selected?: boolean;
  updateAvailable?: boolean;
  updateDisabled?: boolean;
  updateLabel?: string;
  updatePhase?: AccountUpdatePhase;
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
      onUpdate,
      selected = false,
      updateAvailable = false,
      updateDisabled = false,
      updateLabel = "Update",
      updatePhase,
      ...props
    },
    ref,
  ) {
    const resolvedUpdatePhase = updatePhase ?? (updateAvailable ? "ready" : "none");
    const showUpdate = resolvedUpdatePhase !== "none";
    const showUpdateSpinner =
      resolvedUpdatePhase === "preparing" || resolvedUpdatePhase === "installing";
    const updateIsActionable = resolvedUpdatePhase === "ready";
    const accountButton = (
      <button
        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2.5 py-1 text-inherit outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
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
          "group/account-row flex h-11 w-60 items-center rounded-[6px] bg-transparent py-2 font-sans text-[13px] text-[var(--color-text-foreground-secondary)]",
          selected && "text-[var(--color-text-foreground)]",
          disabled &&
            "pointer-events-none bg-transparent text-[var(--color-text-foreground-tertiary)]",
          className,
        )}
        data-pencil-component="QXbUg"
        data-selected={selected || undefined}
        ref={ref}
        {...props}
      >
        {accountButtonWrapper ? accountButtonWrapper(accountButton) : accountButton}
        {showUpdate ? (
          <div className="flex h-7 shrink-0 items-center justify-center px-2.5">
            {onUpdate ? (
              <button
                aria-label={updateLabel}
                aria-disabled={updateDisabled || undefined}
                className={cn(
                  "flex h-[26px] cursor-pointer items-center justify-center gap-1 rounded-full border-0 px-1.5 text-xs leading-none font-normal outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]",
                  updateIsActionable
                    ? "bg-[#339cff] text-white hover:bg-[#1f8fef] active:bg-[#147bca] dark:bg-[#5bafff] dark:hover:bg-[#79bfff] dark:active:bg-[#339cff]"
                    : "bg-[#ecedef] text-[#6d7075] dark:bg-[#2a2a2a] dark:text-[#a6a6a6]",
                )}
                data-update-phase={resolvedUpdatePhase}
                disabled={disabled || updateDisabled || !updateIsActionable}
                onClick={onUpdate}
                type="button"
              >
                {showUpdateSpinner ? (
                  <LoaderCircleIcon aria-hidden="true" className="size-[13px] animate-spin" />
                ) : null}
                {updateLabel}
              </button>
            ) : (
              <span
                className={cn(
                  "flex h-[26px] items-center justify-center gap-1 rounded-full px-1.5 text-xs leading-none font-normal",
                  updateIsActionable
                    ? "bg-[#339cff] text-white dark:bg-[#5bafff]"
                    : "bg-[#ecedef] text-[#6d7075] dark:bg-[#2a2a2a] dark:text-[#a6a6a6]",
                )}
                data-update-phase={resolvedUpdatePhase}
              >
                {showUpdateSpinner ? (
                  <LoaderCircleIcon aria-hidden="true" className="size-[13px] animate-spin" />
                ) : null}
                {updateLabel}
              </span>
            )}
          </div>
        ) : null}
        {!showUpdate ? (
          <button
            aria-label="Help"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent p-0 text-[var(--color-text-foreground-tertiary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
            disabled={disabled}
            onClick={onHelp}
            type="button"
          >
            <CircleQuestionIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  },
);
