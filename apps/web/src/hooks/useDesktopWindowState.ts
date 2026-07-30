import { useEffect, useState } from "react";

import type { DesktopWindowState } from "@synara/contracts";

const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
  isFullscreen: false,
};

export function useDesktopWindowState(): DesktopWindowState {
  const controls =
    typeof window === "undefined" ? undefined : window.desktopBridge?.windowControls;
  const [windowState, setWindowState] = useState<DesktopWindowState>(
    DEFAULT_DESKTOP_WINDOW_STATE,
  );

  useEffect(() => {
    if (!controls) return;
    let cancelled = false;

    void controls.getState().then((state) => {
      if (!cancelled) setWindowState(state);
    });
    const unsubscribe = controls.onState(setWindowState);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [controls]);

  return windowState;
}
