import { ButtonSecondary } from "~/components/foundations/button-secondary/ButtonSecondary";
import { ButtonSignInWithClaude } from "~/components/foundations/button-sign-in-with-claude/ButtonSignInWithClaude";
import { cn } from "~/lib/utils";

export interface ConnectionMethodListProps {
  className?: string;
  onEnterApiKey?: () => void;
  onSignIn?: () => void;
}

export function ConnectionMethodList({
  className,
  onEnterApiKey,
  onSignIn,
}: ConnectionMethodListProps) {
  return (
    <div className={cn("flex w-[488px] flex-col gap-2.5", className)} data-pencil-component="cv14N">
      <ButtonSignInWithClaude onClick={onSignIn} />
      <ButtonSecondary onClick={onEnterApiKey}>Add an API Key</ButtonSecondary>
    </div>
  );
}
