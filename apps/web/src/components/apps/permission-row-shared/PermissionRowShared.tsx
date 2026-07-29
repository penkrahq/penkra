import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";

export interface PermissionRowSharedProps {
  checked?: boolean;
  className?: string;
  onCheckedChange?: (checked: boolean) => void;
  reason?: string;
  required?: boolean;
  title?: string;
}

export function PermissionRowShared({
  checked = true,
  className,
  onCheckedChange,
  reason = '"Sync your invoices with your Ledger account."',
  required = false,
  title = "Connect to the internet",
}: PermissionRowSharedProps) {
  return (
    <div
      className={cn("flex w-full flex-col gap-1 py-2.5 font-sans", className)}
      data-pencil-component="t8z9QM"
    >
      <div className="flex items-center gap-2">
        <strong className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--color-text-foreground)]">
          {title}
        </strong>
        {required ? (
          <span className="text-[11px] text-[var(--color-text-foreground-tertiary)]">
            Required
          </span>
        ) : (
          <SwitchShared
            aria-label={title}
            checked={checked}
            onCheckedChange={(next) => onCheckedChange?.(Boolean(next))}
          />
        )}
      </div>
      <p className="text-xs text-[var(--color-text-foreground-tertiary)]">{reason}</p>
    </div>
  );
}
