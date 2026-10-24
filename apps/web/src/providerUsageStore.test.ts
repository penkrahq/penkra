import { ProviderConnectionId } from "@penkra/contracts";
import { afterEach, expect, it } from "vitest";
import { applyProviderUsage, clearProviderUsage, useProviderUsage } from "./providerUsageStore";

afterEach(clearProviderUsage);
it("retains independent Connection snapshots and replaces them from server events", () => {
  const id = ProviderConnectionId.make("one");
  const other = ProviderConnectionId.make("two");
  const snapshot = {
    provider: "codex" as const,
    updatedAt: "2026-10-19T00:00:00.000Z",
    source: "test",
    limits: [],
    usageLines: [],
  };
  applyProviderUsage({ connectionId: id, snapshot });
  applyProviderUsage({ connectionId: other, snapshot });
  const before = useProviderUsage.getState();
  const changed = { ...snapshot, detail: "Updated" };
  applyProviderUsage({ connectionId: id, snapshot: changed });
  expect(useProviderUsage.getState().get(id)).toBe(changed);
  expect(useProviderUsage.getState().get(other)).toBe(snapshot);
  expect(before.get(id)).toBe(snapshot);
});
