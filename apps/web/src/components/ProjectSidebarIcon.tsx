// FILE: ProjectSidebarIcon.tsx
// Purpose: Render the client avatar used in project-facing surfaces.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon

import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";

// Mock badge number for UI development - will be replaced with actual todo count later.
function getMockBadgeNumber(cwd: string): number {
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) {
    hash = (hash << 5) - hash + cwd.charCodeAt(index);
    hash |= 0;
  }
  return (Math.abs(hash) % 9) + 1;
}

export function ProjectSidebarIcon({
  cwd,
  glyphClassName = "size-4",
}: {
  cwd: string;
  expanded: boolean;
  glyphClassName?: string;
}) {
  const badgeNumber = getMockBadgeNumber(cwd);

  return (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700",
          glyphClassName,
        )}
      >
        <CentralIcon name="user" className="size-2/3 text-zinc-500 dark:text-zinc-400" />
      </span>
      <span
        aria-label={`${badgeNumber} items`}
        className="absolute -right-1 -bottom-1 flex size-3 min-w-3 items-center justify-center rounded-full bg-blue-500 px-px text-[7px] leading-none font-semibold text-white"
      >
        {badgeNumber}
      </span>
    </span>
  );
}
