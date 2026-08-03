import { PermissionToggleShared } from "../permission-toggle-shared/PermissionToggleShared";

export interface PermissionSectionProps {
  defaultEnabled?: boolean;
  heading?: string;
  reason?: string;
  required?: boolean;
  title?: string;
}

export function PermissionSection({
  defaultEnabled = true,
  heading,
  reason = '"Sync your invoices with your Ledger account."',
  required = true,
  title = "Connect to the internet",
}: PermissionSectionProps) {
  const resolvedHeading =
    heading ??
    (required ? "Required — Ledger can't work without these" : "Optional — you can turn these off");

  return (
    <section className="w-full font-sans">
      <h3 className="text-[length:var(--app-font-size-ui-sm,11px)] font-semibold text-[var(--color-text-foreground-tertiary)]">
        {resolvedHeading}
      </h3>
      <div className="mt-0.5 flex min-h-[58px] flex-col justify-center">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[length:var(--app-font-size-ui-lg,13px)] font-semibold text-[var(--color-text-foreground)]">
            {title}
          </span>
          <PermissionToggleShared aria-label={title} defaultChecked={defaultEnabled} />
        </div>
        <p className="mt-1 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
          {reason}
        </p>
      </div>
    </section>
  );
}
