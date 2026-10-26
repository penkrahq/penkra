import type { DesktopBridge } from "@penkra/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SplashScreen } from "~/components/SplashScreen";

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
    let receivedAccountEvent = false;
    const unsubscribeCallbackStarted = accountAuth.onCallbackStarted((callback) => {
      if (!active) return;
      const callbackIntent = callback.intent ?? (isCreatingAccount.current ? "sign-up" : "sign-in");
      isCreatingAccount.current = callbackIntent === "sign-up";
      setAuthProcessingIntent(callbackIntent);
    });
    const unsubscribeAuthenticated = accountAuth.onAuthenticated(() => {
      if (!active) return;
      receivedAccountEvent = true;
      setAuthProcessingIntent(null);
      setState(isCreatingAccount.current ? "connect-agent" : "complete");
    });
    const unsubscribeUserUpdated = accountAuth.onUserUpdated((user) => {
      if (!active) return;
      receivedAccountEvent = true;
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
        if (!active || receivedAccountEvent) return;
        isCreatingAccount.current = false;
        if (result.status === "authenticated") setState("complete");
        else {
          if (result.status === "error")
            console.error("[account-auth] Local session read failed.", result.message);
          setState("welcome");
        }
      })
      .catch((error: unknown) => {
        if (!active || receivedAccountEvent) return;
        console.error("[account-auth] Local session read failed.", error);
        isCreatingAccount.current = false;
        setState("welcome");
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
      <div
        aria-busy="true"
        aria-label="Preparing Penkra"
        className="flex min-h-screen bg-background"
        role="status"
      >
        <SplashScreen />
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
        <OnboardingConnectAgent
          onBack={() => setState("welcome")}
          onContinue={() => setState("complete")}
        />
      </div>
    );
  }

  return children;
}
