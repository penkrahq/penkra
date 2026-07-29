import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";
import { ButtonSecondary } from "~/components/foundations/button-secondary/ButtonSecondary";
import { DividerOnboarding } from "~/components/foundations/divider-onboarding/DividerOnboarding";

import { AgentLogos } from "../agent-logos/AgentLogos";
import {
  onboardingIllustrations,
  OnboardingLayout,
} from "../shared/OnboardingLayout";

export interface OnboardingWelcomeProps {
  onContinue?: () => void;
  onSkip?: () => void;
}

export function OnboardingWelcome({ onContinue, onSkip }: OnboardingWelcomeProps) {
  return (
    <OnboardingLayout
      brandImage={onboardingIllustrations.welcome}
      showBrandLogo
    >
      <div className="w-[488px] font-sans" data-pencil-component="X3BOc">
        <p className="text-[13px] font-light text-[var(--color-text-foreground-tertiary)]">
          Welcome to Penkra
        </p>
        <h1 className="mt-1.5 text-[28px] font-semibold tracking-tight">
          Best app to work with AI
        </h1>
        <p className="mt-2 text-[15px] leading-5 text-[var(--color-text-foreground-secondary)]">
          Install apps, connect your subscriptions and work seamlessly with any AI model
        </p>
        <AgentLogos className="mt-8" />
        <DividerOnboarding className="mt-8" />
        <div className="mt-8 flex flex-col gap-2.5">
          <ButtonPrimary onClick={onContinue}>Sign in</ButtonPrimary>
          <ButtonSecondary onClick={onSkip}>Skip for now</ButtonSecondary>
        </div>
      </div>
    </OnboardingLayout>
  );
}
