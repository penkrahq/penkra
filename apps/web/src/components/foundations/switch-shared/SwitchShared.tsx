import type { ComponentProps } from "react";

import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

export type SwitchSharedProps = ComponentProps<typeof Switch>;

export function SwitchShared({ className, ...props }: SwitchSharedProps) {
  return (
    <Switch
      className={cn(
        "!h-5 !w-9 !border-0 !p-0.5 [--thumb-size:16px] data-unchecked:!bg-[var(--pencil-border)] data-checked:!bg-[var(--pencil-accent)] [&_[data-slot=switch-thumb]]:!ring-0 [&_[data-slot=switch-thumb]]:!shadow-none",
        className,
      )}
      {...props}
    />
  );
}
