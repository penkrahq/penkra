import type {
  PenkraCreateClientInput,
  PenkraCreateTodoInput,
  PenkraGetInstructionsInput,
  PenkraUpdateTodoInput,
  PenkraUpdateClientInput,
} from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

export const penkraQueryKeys = {
  snapshot: ["penkra", "snapshot"] as const,
  instructions: ["penkra", "instructions"] as const,
  instruction: (input: PenkraGetInstructionsInput) =>
    [...penkraQueryKeys.instructions, input.scope, input.clientId ?? null] as const,
};

export const penkraInstructionsQueryOptions = (input: PenkraGetInstructionsInput) =>
  queryOptions({
    queryKey: penkraQueryKeys.instruction(input),
    queryFn: () => ensureNativeApi().penkra.getInstructions(input),
    staleTime: Infinity,
  });

export const penkraSnapshotQueryOptions = () =>
  queryOptions({
    queryKey: penkraQueryKeys.snapshot,
    queryFn: () => ensureNativeApi().penkra.getSnapshot(),
    // The desktop server owns the backend socket and pushes every subsequent snapshot.
    // This query is the one-time bootstrap only; focus/reconnect polling would duplicate
    // that stream without repairing local workspace projections.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export const createPenkraClient = (input: PenkraCreateClientInput) =>
  ensureNativeApi().penkra.createClient(input);

export const updatePenkraClient = (input: PenkraUpdateClientInput) =>
  ensureNativeApi().penkra.updateClient(input);

export const createPenkraTodo = (input: PenkraCreateTodoInput) =>
  ensureNativeApi().penkra.createTodo(input);

export const updatePenkraTodo = (input: PenkraUpdateTodoInput) =>
  ensureNativeApi().penkra.updateTodo(input);
