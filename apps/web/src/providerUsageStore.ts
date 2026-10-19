import type {
  ProviderConnectionId,
  ServerProviderUsageChange,
  ServerProviderUsageSnapshot,
} from "@penkra/contracts";
import { create } from "zustand";

export const useProviderUsage = create<
  ReadonlyMap<ProviderConnectionId, ServerProviderUsageSnapshot>
>(() => new Map());
export function applyProviderUsage(change: ServerProviderUsageChange): void {
  useProviderUsage.setState(
    (previous) => new Map(previous).set(change.connectionId, change.snapshot),
    true,
  );
}
export function clearProviderUsage(): void {
  useProviderUsage.setState(new Map(), true);
}
