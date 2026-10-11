import type { ReactNode } from "react";

export function FolderTabStripViewport(props: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <div
        className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden"
        data-thread-folder-tab-strip
        role="tablist"
      >
        {props.children}
      </div>
      <div
        aria-hidden="true"
        className="h-full shrink-0"
        data-thread-folder-launcher-reservation
        style={{ width: "var(--apps-launcher-folder-bar-right-reservation, 0px)" }}
      />
    </div>
  );
}
