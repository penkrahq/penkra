import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { guardCommit } from "./guardedCommit.ts";

const meta = { eventType: "runtime.error", threadIds: ["t"] };

describe("guardCommit", () => {
  it("retries a transient failure and returns the result", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      guardCommit(
        meta,
        Effect.suspend(() =>
          ++calls < 3 ? Effect.fail(new Error("database or disk is full")) : Effect.succeed("ok"),
        ),
        [1, 1, 1],
      ),
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("waits out a full disk without dropping the event, then catches up", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      guardCommit(
        meta,
        Effect.suspend(() =>
          ++calls < 8 ? Effect.fail(new Error("database or disk is full")) : Effect.succeed("done"),
        ),
        [1],
        1,
      ),
    );
    expect(result).toBe("done");
    expect(calls).toBe(8);
  });

  it("drops a non-disk failure after the retries and keeps the consumer alive", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      guardCommit(
        meta,
        Effect.suspend(() => (calls++, Effect.die(new Error("constraint failed")))),
        [1, 1],
      ),
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("keeps consuming a provider stream after one commit fails", async () => {
    const seen: number[] = [];
    const commit = (n: number) =>
      n === 2 ? Effect.die(new Error("constraint failed")) : Effect.sync(() => seen.push(n));
    await Effect.runPromise(
      Stream.runForEach(Stream.fromIterable([1, 2, 3, 4]), (n) =>
        guardCommit(meta, commit(n), [1]),
      ),
    );
    expect(seen).toEqual([1, 3, 4]);
  });

  it("without the guard the same failure ends the consumer", async () => {
    const seen: number[] = [];
    const commit = (n: number) =>
      n === 2 ? Effect.die(new Error("database or disk is full")) : Effect.sync(() => seen.push(n));
    await expect(
      Effect.runPromise(Stream.runForEach(Stream.fromIterable([1, 2, 3, 4]), commit)),
    ).rejects.toBeDefined();
    expect(seen).toEqual([1]);
  });
});
