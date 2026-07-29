import type { ComponentProps } from "react";

import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";

export type OnboardingActionsAgentsProps = ComponentProps<typeof ButtonPrimary>;

export function OnboardingActionsAgents({
  children = "Continue",
  ...props
}: OnboardingActionsAgentsProps) {
  return (
    <ButtonPrimary data-pencil-component="M0qCG" {...props}>
      {children}
    </ButtonPrimary>
  );
}
