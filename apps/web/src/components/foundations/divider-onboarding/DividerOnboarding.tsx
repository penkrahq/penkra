import type { ComponentProps } from "react";

import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

export type DividerOnboardingProps = ComponentProps<typeof Separator>;

export function DividerOnboarding({ className, ...props }: DividerOnboardingProps) {
  return (
    <Separator
      className={cn("w-full !bg-[var(--color-border)]", className)}
      {...props}
    />
  );
}
