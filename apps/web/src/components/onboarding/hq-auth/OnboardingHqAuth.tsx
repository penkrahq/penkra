import type { FormEvent } from "react";
import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";
import { InputShared } from "~/components/foundations/input-shared/InputShared";

import {
  onboardingIllustrations,
  OnboardingLayout,
} from "../shared/OnboardingLayout";

export interface OnboardingHqAuthProps {
  onBack?: () => void;
  onSubmit: (password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export function OnboardingHqAuth({ onBack, onSubmit }: OnboardingHqAuthProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || submitting) return;

    setError(null);
    setSubmitting(true);
    try {
      const result = await onSubmit(password);
      if (!result.ok) {
        setError(result.message);
        setSubmitting(false);
      }
    } catch {
      setError("Authentication failed.");
      setSubmitting(false);
    }
  }

  return (
    <OnboardingLayout brandImage={onboardingIllustrations.welcome}>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <form
        className="w-full max-w-[488px] font-sans"
        data-pencil-derived-from="X3BOc"
        onSubmit={handleSubmit}
      >
        <p className="text-[13px] font-light text-[var(--color-text-foreground-tertiary)]">
          Welcome to Penkra
        </p>
        <h1 className="mt-1.5 text-[28px] font-semibold tracking-tight">
          Connect Penkra HQ
        </h1>
        <p className="mt-2 text-[15px] leading-5 text-[var(--color-text-foreground-secondary)]">
          Enter the master password to connect this workspace.
        </p>
        <label
          className="mt-8 mb-2 block text-[13px] font-medium text-[var(--color-text-foreground-secondary)]"
          htmlFor="penkra-hq-password"
        >
          Master password
        </label>
        <InputShared
          autoComplete="current-password"
          autoFocus
          disabled={submitting}
          id="penkra-hq-password"
          invalid={Boolean(error)}
          maxLength={1024}
          onChange={(event) => setPassword(event.currentTarget.value)}
          type="password"
          value={password}
        />
        <p
          aria-live="polite"
          className="mt-2 min-h-5 text-[13px] text-destructive"
          role={error ? "alert" : undefined}
        >
          {error}
        </p>
        <ButtonPrimary className="mt-4" disabled={!password || submitting} type="submit">
          {submitting ? "Connecting…" : "Connect"}
        </ButtonPrimary>
      </form>
    </OnboardingLayout>
  );
}
