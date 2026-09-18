import { useLayoutEffect } from "react";

export function NativeAppOverlayBoundary() {
  useLayoutEffect(() => {
    window.desktopBridge?.appTabs?.overlayActive(true);
    return () => window.desktopBridge?.appTabs?.overlayActive(false);
  }, []);
  return null;
}
