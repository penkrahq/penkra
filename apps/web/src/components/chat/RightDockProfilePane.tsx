// FILE: RightDockProfilePane.tsx
// Purpose: Right-dock pane that shows the selected Penkra client profile.
// Layer: Chat right-dock UI
// Exports: RightDockProfilePane

import type { ProjectId } from "@synara/contracts";
import { memo } from "react";

import { CentralIcon } from "~/lib/central-icons";
import { useStore } from "~/store";

export const RightDockProfilePane = memo(function RightDockProfilePane(props: {
  projectId: ProjectId;
}) {
  const project = useStore((store) =>
    store.projects.find((candidate) => candidate.id === props.projectId),
  );

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Profile not found
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <div className="flex size-20 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
        <CentralIcon name="user" className="size-12 text-zinc-500 dark:text-zinc-400" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-medium">{project.name}</h2>
        {project.localName ? (
          <p className="mt-1 text-sm text-muted-foreground">{project.folderName}</p>
        ) : null}
      </div>
    </div>
  );
});
