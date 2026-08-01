import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface LeftRailContentSharedProps extends Omit<ComponentProps<"section">, "children"> {
  children: ReactNode;
}

export function LeftRailContentShared({
  children,
  className,
  ...props
}: LeftRailContentSharedProps) {
  return (
    <section
      className={cn("flex min-h-0 w-60 flex-1 flex-col overflow-hidden", className)}
      data-pencil-component="tssws"
      data-slot="left-rail-content"
      {...props}
    >
      {children}
    </section>
  );
}
