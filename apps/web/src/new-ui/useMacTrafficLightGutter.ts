import type { DesktopWindowState } from "@synara/contracts";
import {
  MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "@synara/shared/desktopChrome";
import { useLayoutEffect, useState } from "react";

export const MAC_WINDOWED_TRAFFIC_LIGHT_GUTTER_PX = MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX;
export const MAC_TITLEBAR_SAFE_AREA_GAP_PX = 10;

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: () => void): void;
  removeEventListener(type: "geometrychange", listener: () => void): void;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | undefined {
  return (
    navigator as Navigator & {
      windowControlsOverlay?: WindowControlsOverlayLike;
    }
  ).windowControlsOverlay;
}

function readTitlebarAreaX(): number {
  const overlay = getWindowControlsOverlay();
  if (!overlay?.visible) return 0;

  const x = overlay.getTitlebarAreaRect().x;
  return Number.isFinite(x) && x > 0 ? x : 0;
}

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
  titlebarAreaX?: number;
}): number {
  if (!shouldReserveMacWindowedTrafficLightGutter(input)) return 0;
  const fallbackGutter = resolveMacDesktopTopBarTrafficLightGutterCssPx(input.zoomFactor);
  const liveSafeAreaGutter = Math.max(0, input.titlebarAreaX ?? 0) + MAC_TITLEBAR_SAFE_AREA_GAP_PX;
  return Math.max(fallbackGutter, Math.ceil(liveSafeAreaGutter));
}

function readZoomFactor(): number {
  return window.desktopBridge?.getZoomFactor?.() ?? 1;
}

function resolveGutter(
  state: DesktopWindowState | null,
  zoomFactor: number,
  titlebarAreaX: number,
): number {
  const controls = window.desktopBridge?.windowControls;
  return resolveMacWindowedTrafficLightGutter({
    platform: navigator.platform,
    hasDesktopWindowControls: Boolean(controls),
    isFullscreen: state?.isFullscreen ?? false,
    zoomFactor,
    titlebarAreaX,
  });
}

export function useMacWindowedTrafficLightGutter(): number {
  const [windowState, setWindowState] = useState<DesktopWindowState | null>(null);
  const [zoomFactor, setZoomFactor] = useState(readZoomFactor);
  const [titlebarAreaX, setTitlebarAreaX] = useState(readTitlebarAreaX);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge;
    const controls = window.desktopBridge?.windowControls;
    const overlay = getWindowControlsOverlay();
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
    const syncTitlebarArea = () => {
      if (!disposed) setTitlebarAreaX(readTitlebarAreaX());
    };
    overlay?.addEventListener("geometrychange", syncTitlebarArea);
    syncTitlebarArea();

    void controls.getState().then((state) => {
      if (!disposed && !receivedEvent) setWindowState(state);
    });

    return () => {
      disposed = true;
      unsubscribeState();
      unsubscribeZoom?.();
      overlay?.removeEventListener("geometrychange", syncTitlebarArea);
    };
  }, []);

  return resolveGutter(windowState, zoomFactor, titlebarAreaX);
}
