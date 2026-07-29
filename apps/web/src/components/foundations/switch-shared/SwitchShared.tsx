import type { ComponentProps } from "react";

import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

export type SwitchSharedProps = ComponentProps<typeof Switch>;

export function SwitchShared({ className, ...props }: SwitchSharedProps) {
  return (
    <Switch
      className={cn(
        "!h-5 !w-9 !p-0.5 [--thumb-size:16px] data-unchecked:!border-[var(--color-border)] data-unchecked:!bg-[var(--color-background-control-opaque)] data-checked:!border-[var(--color-text-accent)] data-checked:!bg-[var(--color-text-accent)] [&_[data-slot=switch-thumb]]:!ring-0 [&_[data-slot=switch-thumb]]:!shadow-none",
        className,
      )}
      {...props}
    />
  );
}
