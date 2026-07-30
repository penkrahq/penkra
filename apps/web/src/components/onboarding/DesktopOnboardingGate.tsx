import type { DesktopBridge } from "@synara/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { OnboardingConnectAgent } from "./connect-agent/OnboardingConnectAgent";
import { OnboardingWelcome } from "./welcome/OnboardingWelcome";

type GateState = "checking" | "welcome" | "connect-agent" | "complete";
type AuthIntent = "sign-in" | "sign-up";

export interface DesktopOnboardingGateProps {
  bridge?: DesktopBridge;
  children: ReactNode;
}

export function DesktopOnboardingGate({
  bridge = window.desktopBridge,
  children,
}: DesktopOnboardingGateProps) {
  const accountAuth = bridge?.accountAuth;
  const [state, setState] = useState<GateState>(accountAuth ? "checking" : "complete");
  const [authProcessingIntent, setAuthProcessingIntent] = useState<AuthIntent | null>(null);
  const isCreatingAccount = useRef(false);

  const requestAuth = useCallback(
    async (nextIntent: AuthIntent) => {
      if (!accountAuth) return;
      isCreatingAccount.current = nextIntent === "sign-up";
      try {
        if (nextIntent === "sign-up") await accountAuth.requestSignUp();
        else await accountAuth.requestSignIn();
      } catch {
        isCreatingAccount.current = false;
        setAuthProcessingIntent(null);
      }
    },
    [accountAuth],
  );

  useEffect(() => {
    if (!accountAuth) {
      setState("complete");
      return;
    }

    let active = true;
    const unsubscribeCallbackStarted = accountAuth.onCallbackStarted((callback) => {
      if (!active) return;
      const callbackIntent = callback.intent ?? (isCreatingAccount.current ? "sign-up" : "sign-in");
      isCreatingAccount.current = callbackIntent === "sign-up";
      setAuthProcessingIntent(callbackIntent);
    });
    const unsubscribeAuthenticated = accountAuth.onAuthenticated(() => {
      if (!active) return;
      setAuthProcessingIntent(null);
      setState(isCreatingAccount.current ? "connect-agent" : "complete");
    });
    const unsubscribeUserUpdated = accountAuth.onUserUpdated((user) => {
      if (!active) return;
      setAuthProcessingIntent(null);
      if (!user) {
        isCreatingAccount.current = false;
        setState("welcome");
        return;
      }
      setState(isCreatingAccount.current ? "connect-agent" : "complete");
    });
    const unsubscribeError = accountAuth.onError(() => {
      if (!active) return;
      isCreatingAccount.current = false;
      setAuthProcessingIntent(null);
    });

    void accountAuth
      .getState()
      .then((result) => {
        if (!active) return;
        isCreatingAccount.current = false;
        setState(result.status === "authenticated" ? "complete" : "welcome");
      })
      .catch(() => {
        isCreatingAccount.current = false;
        if (active) setState("welcome");
      });
    return () => {
      active = false;
      unsubscribeCallbackStarted();
      unsubscribeAuthenticated();
      unsubscribeUserUpdated();
      unsubscribeError();
    };
  }, [accountAuth]);

  if (state === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Preparing Penkra…</p>
      </div>
    );
  }

  if (state === "welcome") {
    return (
      <div className="flex min-h-screen items-center justify-center overflow-auto bg-background p-4">
        <OnboardingWelcome
          authProcessingIntent={authProcessingIntent}
          onCreateAccount={() => void requestAuth("sign-up")}
          onSignIn={() => void requestAuth("sign-in")}
        />
      </div>
    );
  }

  if (state === "connect-agent") {
    return (
      <div className="flex min-h-screen items-center justify-center overflow-auto bg-background p-4">
        <OnboardingConnectAgent onBack={() => setState("welcome")} />
      </div>
    );
  }

  return children;
}
