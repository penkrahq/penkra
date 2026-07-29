import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";

import { OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingWelcomeProps {
  onContinue?: () => void;
}

export function OnboardingWelcome({ onContinue }: OnboardingWelcomeProps) {
  return (
    <OnboardingLayout>
      <div className="w-[488px] font-sans" data-pencil-component="X3BOc">
        <p className="text-sm font-semibold text-[var(--color-text-accent)]">
          Welcome to Penkra
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Best app to work with AI
        </h1>
        <p className="mt-3 text-sm leading-5 text-[var(--color-text-foreground-secondary)]">
          Install apps, connect your subscriptions and work seamlessly with any AI model
        </p>
        <ButtonPrimary className="mt-8" onClick={onContinue}>
          Get started
        </ButtonPrimary>
      </div>
    </OnboardingLayout>
  );
}
