import type { DesktopWindowState } from "@synara/contracts";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import { useLayoutEffect, useState } from "react";

export const MAC_WINDOWED_TITLEBAR_HEIGHT_PX = CHAT_SURFACE_HEADER_HEIGHT_PX;

export function shouldReserveMacWindowedTitlebar(input: {
  platform: string;
  hasDesktopWindowControls: boolean;
  isFullscreen: boolean;
}): boolean {
  return input.platform.startsWith("Mac") && input.hasDesktopWindowControls && !input.isFullscreen;
}

function resolveReserve(state: DesktopWindowState | null): boolean {
  const controls = window.desktopBridge?.windowControls;
  return shouldReserveMacWindowedTitlebar({
    platform: navigator.platform,
    hasDesktopWindowControls: Boolean(controls),
    isFullscreen: state?.isFullscreen ?? false,
  });
}

export function useMacWindowedTitlebar(): boolean {
  const [reserve, setReserve] = useState(() => resolveReserve(null));

  useLayoutEffect(() => {
    const controls = window.desktopBridge?.windowControls;
    if (!controls) {
      setReserve(false);
      return;
    }

    let disposed = false;
    let receivedEvent = false;
    const apply = (state: DesktopWindowState) => {
      if (disposed) return;
      receivedEvent = true;
      setReserve(resolveReserve(state));
    };
    const unsubscribe = controls.onState(apply);

    void controls.getState().then((state) => {
      if (!disposed && !receivedEvent) setReserve(resolveReserve(state));
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return reserve;
}
