import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export function NoticeSecurity({
  children = "Your key is stored securely and never leaves this device unencrypted.",
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "w-[488px] text-xs text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
      data-pencil-component="pTOyi"
      {...props}
    >
      {children}
    </p>
  );
}
