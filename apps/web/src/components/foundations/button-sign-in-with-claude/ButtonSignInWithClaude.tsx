import type { ComponentProps } from "react";

import { ButtonPrimary } from "../button-primary/ButtonPrimary";

export type ButtonSignInWithClaudeProps = ComponentProps<typeof ButtonPrimary>;

export function ButtonSignInWithClaude({
  children = "Sign in to Claude",
  ...props
}: ButtonSignInWithClaudeProps) {
  return <ButtonPrimary {...props}>{children}</ButtonPrimary>;
}
