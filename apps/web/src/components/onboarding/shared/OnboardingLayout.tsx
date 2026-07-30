import type { ReactNode } from "react";

import { PenkraMark } from "~/components/PenkraMark";
import { cn } from "~/lib/utils";

export interface OnboardingLayoutProps {
  brandImage?: string;
  children: ReactNode;
  className?: string;
  showBrandLogo?: boolean;
}

export const onboardingIllustrations = {
  apiKey: new URL("../../../../../../design/assets/onboarding-illustration.png", import.meta.url)
    .href,
  connectAgent: new URL(
    "../../../../../../design/assets/onboarding-illustration-jfvmE.png",
    import.meta.url,
  ).href,
  welcome: new URL(
    "../../../../../../design/assets/onboarding-illustration-of1xs.png",
    import.meta.url,
  ).href,
};

export function OnboardingLayout({
  brandImage,
  children,
  className,
  showBrandLogo = false,
}: OnboardingLayoutProps) {
  return (
    <section
      className={cn(
        "relative flex h-[min(640px,calc(100vh-2rem))] min-h-[520px] w-full max-w-[1040px] overflow-hidden bg-[var(--color-background-panel)] text-[var(--color-text-foreground)]",
        className,
      )}
    >
      {showBrandLogo ? (
        <PenkraMark
          aria-label="Penkra"
          className="absolute left-5 top-5 z-10 size-7 text-[var(--color-text-foreground)]"
        />
      ) : null}
      <main className="relative flex min-w-0 flex-1 items-center justify-center px-6">
        {children}
      </main>
      <aside
        aria-label="Penkra"
        className="relative hidden w-[440px] shrink-0 items-center justify-center overflow-hidden bg-[var(--color-background-elevated-primary-opaque)] md:flex"
      >
        {brandImage ? (
          <img alt="" aria-hidden="true" className="size-full object-cover" src={brandImage} />
        ) : (
          <span className="font-sans text-2xl font-bold tracking-tight">Penkra</span>
        )}
      </aside>
    </section>
  );
}
