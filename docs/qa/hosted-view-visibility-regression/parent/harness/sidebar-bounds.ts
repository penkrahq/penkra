import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@penkra/shared/desktopChrome";
const NATIVE_APP_SPLITTER_CLEARANCE_PX = 1;
export function appDockBoundsForWidth(dockWidth: number) {
  const x = Math.ceil(window.innerWidth - dockWidth + NATIVE_APP_SPLITTER_CLEARANCE_PX);
  const y = CHAT_SURFACE_HEADER_HEIGHT_PX;
  return {
    x: Math.max(0, x),
    y,
    width: Math.max(1, Math.floor(window.innerWidth - x)),
    height: Math.max(1, Math.floor(window.innerHeight - y)),
  };
}
