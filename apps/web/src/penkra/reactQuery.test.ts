import { describe, expect, it } from "vitest";

import { penkraSnapshotQueryOptions } from "./reactQuery";

describe("Penkra snapshot query", () => {
  it("uses the query only for bootstrap and leaves live updates to the socket", () => {
    const options = penkraSnapshotQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options).not.toHaveProperty("refetchInterval");
  });
});
