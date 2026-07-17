import type {
  PenkraCreateClientInput,
  PenkraCreateTodoInput,
  PenkraUpdateTodoInput,
} from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

export const penkraQueryKeys = {
  snapshot: ["penkra", "snapshot"] as const,
};

export const penkraSnapshotQueryOptions = () =>
  queryOptions({
    queryKey: penkraQueryKeys.snapshot,
    queryFn: () => ensureNativeApi().penkra.getSnapshot(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

export const createPenkraClient = (input: PenkraCreateClientInput) =>
  ensureNativeApi().penkra.createClient(input);

export const createPenkraTodo = (input: PenkraCreateTodoInput) =>
  ensureNativeApi().penkra.createTodo(input);

export const updatePenkraTodo = (input: PenkraUpdateTodoInput) =>
  ensureNativeApi().penkra.updateTodo(input);
