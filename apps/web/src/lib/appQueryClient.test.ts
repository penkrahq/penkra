import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./appQueryClient";

describe("app request retry policy", () => {
  it("surfaces a failing query on its first failure and lets an explicit fetch retry", async () => {
    const client = createAppQueryClient();
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValueOnce("ok");
    const options = { queryKey: ["retry-policy"], queryFn };
    try {
      await expect(client.fetchQuery(options)).rejects.toThrow("request failed");
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(options.queryKey)?.error?.message).toBe("request failed");
      await expect(client.fetchQuery(options)).resolves.toBe("ok");
      expect(queryFn).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  });

  it("surfaces a failing mutation on its first failure", async () => {
    const client = createAppQueryClient();
    const mutationFn = vi.fn().mockRejectedValue(new Error("write failed"));
    try {
      const mutation = client
        .getMutationCache()
        .build(client, { mutationKey: ["write-policy"], mutationFn });
      await expect(mutation.execute(undefined)).rejects.toThrow("write failed");
      expect(mutationFn).toHaveBeenCalledTimes(1);
    } finally {
      client.clear();
    }
  });
});
