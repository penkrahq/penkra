import type { HTMLAttributes } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

export function HarnessIconClaude({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex size-6 items-center justify-center", className)}
      data-pencil-component="x4UEfB"
      {...props}
    >
      <ProviderIcon className="size-4" provider="claudeAgent" />
    </span>
  );
}
