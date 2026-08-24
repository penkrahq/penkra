import type { DesktopAccountAuthState, DesktopAccountUser, DesktopBridge } from "@penkra/contracts";
import { useEffect, useState } from "react";

type DesktopAccountAuth = NonNullable<DesktopBridge["accountAuth"]>;

export function resolveDesktopAccountName(state: DesktopAccountAuthState | null): string {
  return state?.status === "authenticated" ? state.user.name.trim() : "";
}

export function useDesktopAccountAuthState(): {
  readonly accountAuth: DesktopAccountAuth | undefined;
  readonly authState: DesktopAccountAuthState | null;
} {
  const accountAuth = typeof window === "undefined" ? undefined : window.desktopBridge?.accountAuth;
  const [authState, setAuthState] = useState<DesktopAccountAuthState | null>(null);

  useEffect(() => {
    if (!accountAuth) return;

    let active = true;
    let receivedAccountEvent = false;
    const updateUser = (user: DesktopAccountUser | null) => {
      receivedAccountEvent = true;
      if (active)
        setAuthState(user ? { status: "authenticated", user } : { status: "unauthenticated" });
    };
    const unsubscribeAuthenticated = accountAuth.onAuthenticated(updateUser);
    const unsubscribeUserUpdated = accountAuth.onUserUpdated(updateUser);

    void accountAuth.getState().then(
      (state) => {
        if (active && !receivedAccountEvent) setAuthState(state);
      },
      (error: unknown) => {
        if (active && !receivedAccountEvent) {
          setAuthState({
            status: "error",
            message: error instanceof Error ? error.message : "Account details are unavailable.",
          });
        }
      },
    );

    return () => {
      active = false;
      unsubscribeAuthenticated();
      unsubscribeUserUpdated();
    };
  }, [accountAuth]);

  return { accountAuth, authState };
}
