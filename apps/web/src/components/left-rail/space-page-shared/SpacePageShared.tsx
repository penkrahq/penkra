import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SpacePageSharedProps extends Omit<ComponentProps<"section">, "children"> {
  active: boolean;
  children: ReactNode;
  label: string;
}

export function SpacePageShared({
  active,
  children,
  className,
  label,
  ...props
}: SpacePageSharedProps) {
  return (
    <section
      aria-hidden={!active}
      aria-label={label}
      aria-roledescription="space"
      className={cn(
        "flex h-full w-60 shrink-0 snap-start snap-always flex-col overflow-hidden",
        className,
      )}
      data-pencil-component="tssws"
      inert={!active}
      role="group"
      {...props}
    >
      {children}
    </section>
  );
}
