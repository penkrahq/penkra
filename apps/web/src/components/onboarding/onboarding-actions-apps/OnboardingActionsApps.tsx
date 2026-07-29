import type { ComponentProps } from "react";

import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";

export type OnboardingActionsAppsProps = ComponentProps<typeof ButtonPrimary>;

export function OnboardingActionsApps({
  children = "Continue",
  ...props
}: OnboardingActionsAppsProps) {
  return (
    <ButtonPrimary data-pencil-component="KRsgn" {...props}>
      {children}
    </ButtonPrimary>
  );
}
