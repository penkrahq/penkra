import { useEffect, useMemo, useState } from "react";
import type {
  PenkraClientSummary,
  PenkraProgramWarning,
  PenkraTodoSummary,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { CheckCircle2Icon, PlayIcon, TriangleAlertIcon } from "../lib/icons";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { cn } from "../lib/utils";
import {
  createPenkraTodo,
  penkraInstructionsQueryOptions,
  penkraQueryKeys,
  updatePenkraClient,
  updatePenkraTodo,
} from "./reactQuery";

export function PenkraTodoPanel({
  open,
  onOpenChange,
  client,
  todos,
  warnings,
  onInvoke,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: PenkraClientSummary | null;
  todos: readonly PenkraTodoSummary[];
  warnings: readonly PenkraProgramWarning[];
  onInvoke: (todo: PenkraTodoSummary) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [selectedHumanTodo, setSelectedHumanTodo] = useState<PenkraTodoSummary | null>(null);
  const [invokingTodoId, setInvokingTodoId] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const instructionsQuery = useQuery({
    ...penkraInstructionsQueryOptions({
      scope: "client-specific",
      clientId: client?.id ?? "unselected",
    }),
    enabled: open && client !== null,
  });
  const clientTodos = useMemo(
    () => (client ? todos.filter((todo) => todo.clientId === client.id) : []),
    [client, todos],
  );
  const clientWarnings = useMemo(
    () => (client ? warnings.filter((warning) => warning.clientId === client.id) : []),
    [client, warnings],
  );
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: penkraQueryKeys.snapshot }),
      queryClient.invalidateQueries({ queryKey: penkraQueryKeys.instructions }),
    ]);
  };
  const createMutation = useMutation({ mutationFn: createPenkraTodo, onSuccess: refresh });
  const updateMutation = useMutation({ mutationFn: updatePenkraTodo, onSuccess: refresh });
  const updateClientMutation = useMutation({
    mutationFn: updatePenkraClient,
    onSuccess: refresh,
  });
  useEffect(() => setInstructions(""), [client?.id]);
  useEffect(() => {
    if (instructionsQuery.data) setInstructions(instructionsQuery.data.body);
  }, [instructionsQuery.data]);

  const quickAdd = () => {
    if (!client || !title.trim() || createMutation.isPending) return;
    createMutation.mutate(
      {
        clientId: client.id,
        title: title.trim(),
        kind: "general",
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => setTitle(""),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-lg">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">{client?.displayName ?? "Client work"}</SheetTitle>
          <SheetDescription>
            {client
              ? `${client.badge.count} ${client.badge.count === 1 ? "todo" : "todos"} need attention`
              : "Select a client"}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="space-y-5 px-5 py-4">
          {client ? (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="penkra-client-instructions">
                Client-specific instructions
              </label>
              <Textarea
                id="penkra-client-instructions"
                value={instructions}
                rows={4}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Applied only to this client workspace after you save.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    updateClientMutation.isPending ||
                    instructionsQuery.isPending ||
                    instructions === (instructionsQuery.data?.body ?? "")
                  }
                  onClick={() =>
                    updateClientMutation.mutate({
                      clientId: client.id,
                      instructions,
                    })
                  }
                >
                  {updateClientMutation.isPending ? "Saving" : "Save instructions"}
                </Button>
              </div>
              {updateClientMutation.error ? (
                <p className="text-sm text-destructive">{updateClientMutation.error.message}</p>
              ) : null}
            </div>
          ) : null}
          {clientWarnings.length > 0 ? (
            <div className="border-l-2 border-amber-500 bg-amber-500/8 px-3 py-2 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
                <TriangleAlertIcon className="size-4" /> Program needs work
              </div>
              {clientWarnings.map((warning) => (
                <p key={warning.programId} className="mt-1 text-muted-foreground">
                  {warning.label} is active but has no open work.
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2">
            <Input
              placeholder="Add a todo"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") quickAdd();
              }}
            />
            <Button onClick={quickAdd} disabled={!title.trim() || createMutation.isPending}>
              Add
            </Button>
          </div>
          {createMutation.error ? (
            <p className="text-sm text-destructive">{createMutation.error.message}</p>
          ) : null}

          <div className="divide-y border-y">
            {clientTodos.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing needs attention.
              </p>
            ) : (
              clientTodos.map((todo) => (
                <div key={todo.id} className="py-3">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => {
                      if (todo.execution === "human") setSelectedHumanTodo(todo);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50",
                          todo.status === "blocked" && "bg-red-500",
                          todo.status === "with_partner" && "bg-sky-500",
                          todo.dueAt && "bg-amber-500",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{todo.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {todo.kind}
                          {todo.dueAt
                            ? ` · due ${new Date(todo.dueAt).toLocaleString()}`
                            : " · no date"}
                        </p>
                        {todo.blockedReason ? (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-300">
                            {todo.blockedReason}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={updateMutation.isPending}
                      onClick={() => updateMutation.mutate({ todoId: todo.id, status: "done" })}
                    >
                      <CheckCircle2Icon className="size-4" /> Done
                    </Button>
                    {todo.execution === "agent" ? (
                      <Button
                        size="sm"
                        disabled={invokingTodoId !== null}
                        onClick={async () => {
                          setInvokingTodoId(todo.id);
                          setInvokeError(null);
                          try {
                            await onInvoke(todo);
                          } catch (error) {
                            setInvokeError(
                              error instanceof Error ? error.message : "Failed to start work.",
                            );
                          } finally {
                            setInvokingTodoId(null);
                          }
                        }}
                      >
                        <PlayIcon className="size-4" />{" "}
                        {invokingTodoId === todo.id ? "Starting" : "Start"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedHumanTodo(todo)}
                      >
                        Details
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {selectedHumanTodo ? (
            <div className="border-t pt-4">
              <p className="text-sm font-medium">{selectedHumanTodo.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Human work item. Complete it here after the external action is finished.
              </p>
            </div>
          ) : null}
          {updateMutation.error ? (
            <p className="text-sm text-destructive">{updateMutation.error.message}</p>
          ) : null}
          {invokeError ? <p className="text-sm text-destructive">{invokeError}</p> : null}
        </SheetPanel>
        <SheetFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
