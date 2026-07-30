import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";
import { ButtonSecondary } from "~/components/foundations/button-secondary/ButtonSecondary";
import { DividerOnboarding } from "~/components/foundations/divider-onboarding/DividerOnboarding";

import { AgentLogos } from "../agent-logos/AgentLogos";
import {
  onboardingIllustrations,
  OnboardingLayout,
} from "../shared/OnboardingLayout";

export interface OnboardingWelcomeProps {
  authProcessingIntent?: "sign-in" | "sign-up" | null;
  onCreateAccount?: () => void;
  onSignIn?: () => void;
}

export function OnboardingWelcome({
  authProcessingIntent = null,
  onCreateAccount,
  onSignIn,
}: OnboardingWelcomeProps) {
  const authenticationProcessing = authProcessingIntent !== null;

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
          Install apps, connect your subscriptions and work seamlessly with any
          AI model
        </p>
        <AgentLogos className="mt-8" />
        <DividerOnboarding className="mt-8" />
        <div className="mt-8 flex flex-col gap-2.5">
          <ButtonPrimary
            disabled={authenticationProcessing}
            loading={authProcessingIntent === "sign-up"}
            loadingLabel="Creating account…"
            onClick={onCreateAccount}
          >
            Create an account
          </ButtonPrimary>
          <ButtonSecondary
            disabled={authenticationProcessing}
            loading={authProcessingIntent === "sign-in"}
            loadingLabel="Signing in…"
            onClick={onSignIn}
          >
            Sign in
          </ButtonSecondary>
        </div>
      </div>
    </OnboardingLayout>
  );
}
