// FILE: RightDockProfilePane.tsx
// Purpose: Right-dock pane that shows the selected Penkra client profile with mock todo list.
// Layer: Chat right-dock UI
// Exports: RightDockProfilePane

import type { ProjectId } from "@penkra/contracts";
import { memo, useState } from "react";

import { CheckCircle2Icon, TriangleAlertIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import { useStore } from "~/store";
import { cn } from "~/lib/utils";

// Mock todo data for UI/UX development — will be replaced with real data later.
const MOCK_TODOS = [
  {
    id: "mock-1",
    title: "Review onboarding flow",
    status: "open" as const,
    kind: "general",
  },
  {
    id: "mock-2",
    title: "Update branding assets",
    status: "doing" as const,
    kind: "design",
  },
  {
    id: "mock-3",
    title: "Fix payment integration",
    status: "blocked" as const,
    kind: "engineering",
    blockedReason: "Waiting on Stripe API key",
  },
  {
    id: "mock-4",
    title: "Prepare Q3 report",
    status: "open" as const,
    kind: "general",
  },
];

const STATUS_CONFIG = {
  open: {
    color: "text-muted-foreground/50",
    dotColor: "bg-muted-foreground/50",
    label: "Open",
  },
  doing: {
    color: "text-blue-500",
    dotColor: "bg-blue-500",
    label: "In progress",
  },
  blocked: {
    color: "text-amber-500",
    dotColor: "bg-amber-500",
    label: "Blocked",
  },
} as const;

export const RightDockProfilePane = memo(function RightDockProfilePane(props: {
  projectId: ProjectId;
}) {
  const project = useStore((store) =>
    store.projects.find((candidate) => candidate.id === props.projectId),
  );
  const [newTodoTitle, setNewTodoTitle] = useState("");

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Profile not found
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header: Avatar + Name */}
      <div className="flex flex-col items-center gap-3 border-b px-5 py-5">
        <div className="flex size-16 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
          <CentralIcon name="user" className="size-10 text-zinc-500 dark:text-zinc-400" />
        </div>
        <div className="text-center">
          <h2 className="text-base font-semibold">{project.name}</h2>
          {project.localName ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{project.folderName}</p>
          ) : null}
        </div>
      </div>

      {/* Todo list */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">Todos</h3>
          <span className="text-xs text-muted-foreground">{MOCK_TODOS.length} active</span>
        </div>

        <div className="space-y-1">
          {MOCK_TODOS.map((todo) => {
            const config = STATUS_CONFIG[todo.status];
            return (
              <div
                key={todo.id}
                className={cn(
                  "group flex items-start gap-2.5 rounded-md px-2 py-2 text-sm",
                  "hover:bg-muted/50",
                )}
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", config.dotColor)} />
                <div className="min-w-0 flex-1">
                  <p className="leading-snug">{todo.title}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        todo.status === "open" && "bg-muted text-muted-foreground",
                        todo.status === "doing" &&
                          "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                        todo.status === "blocked" &&
                          "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {config.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">{todo.kind}</span>
                  </div>
                  {todo.blockedReason ? (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {todo.blockedReason}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick add (mock, non-functional) */}
      <div className="border-t px-5 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Add a todo..."
            value={newTodoTitle}
            onChange={(e) => setNewTodoTitle(e.target.value)}
            className="flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
});
