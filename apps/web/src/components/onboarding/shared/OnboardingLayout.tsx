import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface OnboardingLayoutProps {
  children: ReactNode;
  className?: string;
}

export function OnboardingLayout({ children, className }: OnboardingLayoutProps) {
  return (
    <section
      className={cn(
        "flex h-[640px] w-[1040px] overflow-hidden bg-[var(--color-background-surface)] text-[var(--color-text-foreground)]",
        className,
      )}
    >
      <main className="relative flex w-[600px] items-center justify-center">{children}</main>
      <aside
        aria-label="Penkra"
        className="flex w-[440px] items-center justify-center bg-[var(--color-background-elevated-primary-opaque)]"
      >
        <span className="font-sans text-2xl font-bold tracking-tight">Penkra</span>
      </aside>
    </section>
  );
}
