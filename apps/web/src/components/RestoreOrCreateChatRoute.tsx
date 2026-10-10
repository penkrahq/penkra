// FILE: RestoreOrCreateChatRoute.tsx
// Purpose: After bootstrap, restore a chat from the store or create a fresh draft.
// Layer: Routing
// Depends on: sidebar UI persistence plus caller-supplied restore/fresh-chat policy.

import { ThreadId } from "@penkra/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { SplashScreen } from "./SplashScreen";
import type { LastThreadRoute } from "../chatRouteRestore";
import type { StartContainerChatResult } from "../lib/startContainerChat";
import { useStore } from "../store";

// Resolves which thread route (if any) this surface should restore to. Returning `null` defers
// to `createFreshChat` (e.g. because there is a draft to reopen instead of an existing thread).
export type RestoreRouteResolver = () => LastThreadRoute | null;

export function RestoreOrCreateChatRoute({
  resolveRestoreRoute,
  createFreshChat,
}: {
  // Surface-specific policy for picking the thread route to restore (e.g. the last-visited route
  // for home chats).
  readonly resolveRestoreRoute: RestoreRouteResolver;
  readonly createFreshChat: () => Promise<StartContainerChatResult>;
}) {
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const [attempt, setAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // One fresh-chat creation at a time per mount: a dep change mid-create re-runs the effect,
  // and without this guard the superseded run and the new run could both mint a draft.
  const createFreshChatInFlightRef = useRef(false);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    let cancelled = false;

    void (async () => {
      // Yield one microtask so every state write below happens asynchronously
      // (no wasted pre-paint render; keeps the component compiler-eligible).
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      setErrorMessage(null);
      const restorableRoute = resolveRestoreRoute();
      if (restorableRoute) {
        if (cancelled) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(restorableRoute.threadId) },
          replace: true,
          search: () => ({}),
        });
        return;
      }

      if (cancelled || createFreshChatInFlightRef.current) {
        return;
      }
      createFreshChatInFlightRef.current = true;
      // .finally instead of try/finally: React Compiler does not yet support
      // try/finally and would skip optimizing this whole component.
      const result: StartContainerChatResult = await createFreshChat().finally(() => {
        createFreshChatInFlightRef.current = false;
      });
      if (cancelled || result.ok) {
        return;
      }
      setErrorMessage(result.error);
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, createFreshChat, navigate, resolveRestoreRoute, threadsHydrated]);

  return (
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}
