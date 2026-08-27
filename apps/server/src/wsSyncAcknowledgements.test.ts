import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeSyncAcknowledgements } from "./wsSyncAcknowledgements";

describe("makeSyncAcknowledgements", () => {
  it("holds a delivery until its cumulative sequence is acknowledged", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(1));
    const delivery = await Effect.runPromise(lease.beginDelivery(42));
    let settled = false;
    const waiting = Effect.runPromise(delivery.wait).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    await Effect.runPromise(
      acknowledgements.acknowledge(1, {
        deliveryId: delivery.deliveryId,
        appliedSequence: 42,
      }),
    );
    await waiting;
    expect(settled).toBe(true);
  });

  it("rejects stale delivery IDs and acknowledgements behind the delivered sequence", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(2));
    const delivery = await Effect.runPromise(lease.beginDelivery(9));

    await expect(
      Effect.runPromise(
        acknowledgements.acknowledge(2, {
          deliveryId: "stale",
          appliedSequence: 9,
        }),
      ),
    ).rejects.toMatchObject({ code: "SYNC_ACKNOWLEDGEMENT_STALE" });
    await expect(
      Effect.runPromise(
        acknowledgements.acknowledge(2, {
          deliveryId: delivery.deliveryId,
          appliedSequence: 8,
        }),
      ),
    ).rejects.toMatchObject({ code: "SYNC_ACKNOWLEDGEMENT_BEHIND" });
    await Effect.runPromise(lease.close);
  });

  it("supersedes the old connection lease and releases its pending wait", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const oldLease = await Effect.runPromise(acknowledgements.open(3));
    const oldDelivery = await Effect.runPromise(oldLease.beginDelivery(1));
    const oldWait = Effect.runPromise(oldDelivery.wait);

    await Effect.runPromise(acknowledgements.open(3));

    await expect(oldWait).rejects.toMatchObject({ code: "SYNC_SUBSCRIPTION_SUPERSEDED" });
    await expect(Effect.runPromise(oldLease.beginDelivery(2))).rejects.toMatchObject({
      code: "SYNC_SUBSCRIPTION_SUPERSEDED",
    });
  });
});
