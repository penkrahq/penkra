// FILE: RouteInsetSurface.tsx
// Purpose: Route-level SidebarInset preset for chat-style routes.
// Layer: Shared app component
// Exports: RouteInsetSurface
// Depends on: SidebarInset (ui) and the shared chat surface class constants.

import { type ComponentProps } from "react";

import {
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { SidebarInset } from "./ui/sidebar";

const DEFAULT_ROUTE_INSET_CLASS_NAME = "h-dvh min-h-0 overscroll-y-none text-foreground";

// Keep SidebarInset as the sidebar peer while the inner surface owns route color.
export function RouteInsetSurface({
  className,
  surfaceClassName,
  ...props
}: ComponentProps<typeof SidebarInset>) {
  if (surfaceClassName === undefined) {
    return (
      <SidebarInset
        className={className ?? DEFAULT_ROUTE_INSET_CLASS_NAME}
        surfaceClassName={CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME}
        {...props}
      />
    );
  }
  return (
    <SidebarInset
      className={className ?? CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={surfaceClassName}
      {...props}
    />
  );
}
