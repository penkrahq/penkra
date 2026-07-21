import { describe, expect, it } from "vitest";

import {
  penkraInstructionsQueryOptions,
  penkraQueryKeys,
  penkraSnapshotQueryOptions,
} from "./reactQuery";

describe("Penkra snapshot query", () => {
  it("uses the query only for bootstrap and leaves live updates to the socket", () => {
    const options = penkraSnapshotQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options).not.toHaveProperty("refetchInterval");
  });
});

describe("Penkra instruction queries", () => {
  it("keys each remote authorship independently and never polls", () => {
    const hq = penkraInstructionsQueryOptions({ scope: "hq" });
    const client = penkraInstructionsQueryOptions({
      scope: "client-specific",
      clientId: "client-1",
    });

    expect(hq.queryKey).toEqual([...penkraQueryKeys.instructions, "hq", null]);
    expect(client.queryKey).toEqual([
      ...penkraQueryKeys.instructions,
      "client-specific",
      "client-1",
    ]);
    expect(hq.staleTime).toBe(Infinity);
    expect(hq).not.toHaveProperty("refetchInterval");
  });
});
