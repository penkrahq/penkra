import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms code-split route chunks once the browser is idle.
 *
 *  Settings and thread routes are reached through programmatic `navigate()`
 *  calls (sidebar gear, keyboard shortcut, the "New thread" button), so the
 *  router's intent-based preloading never fires for them — without this, the
 *  first open pays the chunk download/parse cost. For a brand-new thread that
 *  cost lands right on the draft-landing paint, so warming the thread chunk is
 *  the largest single lever for new-chat startup time.
 */
export function usePreloadRouteChunks() {
  const router = useRouter();

  useEffect(() => {
    const preload = () => {
      // Warm only the code-split components. `preloadRoute()` also constructs
      // route matches, which makes a synthetic thread param participate in
      // navigation state and can race a real activation.
      void router.loadRouteChunk(router.routesById["/_chat/settings"]);
      void router.loadRouteChunk(router.routesById["/_chat/$threadId"]);
    };

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preload, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preload, 1500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
