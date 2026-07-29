import type { DesktopBridge } from "@synara/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { OnboardingHqAuth } from "./hq-auth/OnboardingHqAuth";
import { OnboardingWelcome } from "./welcome/OnboardingWelcome";

type GateState = "checking" | "welcome" | "auth" | "complete";

export interface DesktopOnboardingGateProps {
  bridge?: DesktopBridge;
  children: ReactNode;
}

export function DesktopOnboardingGate({
  bridge = window.desktopBridge,
  children,
}: DesktopOnboardingGateProps) {
  const [state, setState] = useState<GateState>(bridge?.hqAuth ? "checking" : "complete");

  useEffect(() => {
    const hqAuth = bridge?.hqAuth;
    if (!hqAuth) {
      setState("complete");
      return;
    }

    let active = true;
    void hqAuth
      .getRequired()
      .then((required) => {
        if (active) setState(required ? "welcome" : "complete");
      })
      .catch(() => {
        if (active) setState("complete");
      });
    return () => {
      active = false;
    };
  }, [bridge]);

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
          onContinue={() => setState("auth")}
          onSkip={() => {
            void bridge?.hqAuth?.skip().finally(() => setState("complete"));
          }}
        />
      </div>
    );
  }

  if (state === "auth" && bridge?.hqAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center overflow-auto bg-background p-4">
        <OnboardingHqAuth
          onBack={() => setState("welcome")}
          onSubmit={(password) => bridge.hqAuth!.submit(password)}
        />
      </div>
    );
  }

  return children;
}
