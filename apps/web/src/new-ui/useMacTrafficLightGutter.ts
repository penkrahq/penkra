import type { DesktopWindowState } from "@synara/contracts";
import {
  MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "@synara/shared/desktopChrome";
import { useLayoutEffect, useState } from "react";

export const MAC_WINDOWED_TRAFFIC_LIGHT_GUTTER_PX = MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX;

export function shouldReserveMacWindowedTrafficLightGutter(input: {
  platform: string;
  hasDesktopWindowControls: boolean;
  isFullscreen: boolean;
}): boolean {
  return input.platform.startsWith("Mac") && input.hasDesktopWindowControls && !input.isFullscreen;
}

export function resolveMacWindowedTrafficLightGutter(input: {
  platform: string;
  hasDesktopWindowControls: boolean;
  isFullscreen: boolean;
  zoomFactor: number;
}): number {
  if (!shouldReserveMacWindowedTrafficLightGutter(input)) return 0;
  return resolveMacDesktopTopBarTrafficLightGutterCssPx(input.zoomFactor);
}

function readZoomFactor(): number {
  return window.desktopBridge?.getZoomFactor?.() ?? 1;
}

function resolveGutter(state: DesktopWindowState | null, zoomFactor: number): number {
  const controls = window.desktopBridge?.windowControls;
  return resolveMacWindowedTrafficLightGutter({
    platform: navigator.platform,
    hasDesktopWindowControls: Boolean(controls),
    isFullscreen: state?.isFullscreen ?? false,
    zoomFactor,
  });
}

export function useMacWindowedTrafficLightGutter(): number {
  const [windowState, setWindowState] = useState<DesktopWindowState | null>(null);
  const [zoomFactor, setZoomFactor] = useState(readZoomFactor);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge;
    const controls = window.desktopBridge?.windowControls;
    if (!controls) {
      return;
    }

    let disposed = false;
    let receivedEvent = false;
    const apply = (state: DesktopWindowState) => {
      if (disposed) return;
      receivedEvent = true;
      setWindowState(state);
    };
    const unsubscribeState = controls.onState(apply);
    const unsubscribeZoom = bridge?.onZoomFactorChange?.((factor) => {
      if (!disposed) setZoomFactor(factor);
    });

    void controls.getState().then((state) => {
      if (!disposed && !receivedEvent) setWindowState(state);
    });

    return () => {
      disposed = true;
      unsubscribeState();
      unsubscribeZoom?.();
    };
  }, []);

  return resolveGutter(windowState, zoomFactor);
}
