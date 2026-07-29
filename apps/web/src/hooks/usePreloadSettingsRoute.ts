import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms the code-split settings route chunk once the browser is idle.
 *
 *  Settings is reached through programmatic `navigate()` calls (sidebar gear,
 *  keyboard shortcut), so the router's intent-based preloading never fires for
 *  it — without this, the first open pays the chunk download/parse cost.
 */
export function usePreloadSettingsRoute() {
  const router = useRouter();

  useEffect(() => {
    const preload = () => {
      // We only need the code-split route component here. `preloadRoute()` also
      // creates and caches route matches, which can race an active navigation
      // during development. Loading the chunk directly keeps this warmup free of
      // navigation state and lets normal navigation create the match on demand.
      void router.loadRouteChunk(router.routesById["/_chat/settings"]);
    };

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preload, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preload, 1500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
