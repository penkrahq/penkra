import type { ReactNode } from "react";

import { SynaraLogo } from "~/components/SynaraLogo";
import { cn } from "~/lib/utils";

export interface OnboardingLayoutProps {
  brandImage?: string;
  children: ReactNode;
  className?: string;
  showBrandLogo?: boolean;
}

export const onboardingIllustrations = {
  apiKey: new URL(
    "../../../../../../design/assets/onboarding-illustration.png",
    import.meta.url,
  ).href,
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
        "relative flex h-[640px] w-[1040px] overflow-hidden bg-[var(--color-background-panel)] text-[var(--color-text-foreground)]",
        className,
      )}
    >
      {showBrandLogo ? (
        <SynaraLogo
          aria-label="Penkra"
          className="absolute left-5 top-5 z-10 size-7 text-[var(--color-text-foreground)]"
        />
      ) : null}
      <main className="relative flex w-[600px] items-center justify-center">{children}</main>
      <aside
        aria-label="Penkra"
        className="relative flex w-[440px] items-center justify-center overflow-hidden bg-[var(--color-background-elevated-primary-opaque)]"
      >
        {brandImage ? (
          <img
            alt=""
            aria-hidden="true"
            className="size-full object-cover"
            src={brandImage}
          />
        ) : (
          <span className="font-sans text-2xl font-bold tracking-tight">Penkra</span>
        )}
      </aside>
    </section>
  );
}
