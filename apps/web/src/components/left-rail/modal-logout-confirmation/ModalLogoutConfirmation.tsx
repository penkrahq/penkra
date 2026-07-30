import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";
import { ButtonSecondary } from "~/components/foundations/button-secondary/ButtonSecondary";
import { cn } from "~/lib/utils";

import { AccountMenuIcon } from "../menu-account/AccountMenuIcon";

export interface ModalLogoutConfirmationProps {
  className?: string;
  descriptionId?: string;
  errorMessage?: string | null;
  loading?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  titleId?: string;
}

export function ModalLogoutConfirmation({
  className,
  descriptionId,
  errorMessage,
  loading = false,
  onCancel,
  onConfirm,
  titleId,
}: ModalLogoutConfirmationProps) {
  return (
    <div
      className={cn(
        "box-border flex h-[220px] w-[400px] flex-col items-center border-0 bg-[var(--color-background-surface)] px-6 pt-6 pb-5 font-sans text-[var(--color-text-foreground)] ring-1 ring-[var(--color-border)] ring-inset",
        className,
      )}
      data-pencil-component="r88fa"
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/8 text-destructive"
        data-slot="logout-icon"
      >
        <AccountMenuIcon aria-hidden="true" className="size-6" name="logout" />
      </div>

      <div
        className="flex w-full flex-col items-center gap-2 pt-4 text-center"
        data-slot="logout-content"
      >
        <h2 className="text-base leading-[1.2] font-semibold" id={titleId}>
          Log out
        </h2>
        <p
          className="w-full text-[13px] leading-[1.4] font-normal text-[var(--color-text-foreground-secondary)]"
          id={descriptionId}
        >
          Are you sure you want to log out? You&apos;ll need to sign in again to access your
          account.
        </p>
      </div>

      <div className="grid w-full grid-cols-2 gap-2 pt-5" data-slot="logout-actions">
        <ButtonSecondary
          className="!h-9 min-w-0 sm:!h-9"
          disabled={loading}
          onClick={onCancel}
        >
          Cancel
        </ButtonSecondary>
        <ButtonPrimary
          className="!h-9 min-w-0 !text-white sm:!h-9"
          loading={loading}
          loadingLabel="Logging out…"
          onClick={onConfirm}
          variant="destructive"
        >
          Log out
        </ButtonPrimary>
      </div>

      <p aria-live="assertive" className="sr-only" role="status">
        {errorMessage ?? ""}
      </p>
    </div>
  );
}
