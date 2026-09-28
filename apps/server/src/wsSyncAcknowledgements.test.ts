import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { installDiagnosticsStore } from "./diagnostics/recorder";
import { DiagnosticsStore, openDiagnosticsReader } from "./diagnostics/store";
import { makeSyncAcknowledgements } from "./wsSyncAcknowledgements";

describe("makeSyncAcknowledgements", () => {
  it("records an arbitrary delivery backlog without waiting for an acknowledgement", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(1));

    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 1_000 }, (_, index) => index + 1),
        (sequence) => lease.recordDelivery(sequence),
      ),
    );
    await Effect.runPromise(
      acknowledgements.acknowledge(1, {
        deliveryId: lease.deliveryId,
        appliedSequence: 1_000,
      }),
    );
  });

  it("accepts monotonic cumulative cursors and ignores redundant older cursors", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(2));
    await Effect.runPromise(lease.recordDelivery(9));

    await Effect.runPromise(
      acknowledgements.acknowledge(2, {
        deliveryId: lease.deliveryId,
        appliedSequence: 7,
      }),
    );
    await Effect.runPromise(
      acknowledgements.acknowledge(2, {
        deliveryId: lease.deliveryId,
        appliedSequence: 6,
      }),
    );
    await Effect.runPromise(
      acknowledgements.acknowledge(2, {
        deliveryId: lease.deliveryId,
        appliedSequence: 9,
      }),
    );
  });

  it("rejects stale delivery identities and cursors ahead of delivery", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(3));
    await Effect.runPromise(lease.recordDelivery(9));

    await expect(
      Effect.runPromise(
        acknowledgements.acknowledge(3, {
          deliveryId: "stale",
          appliedSequence: 9,
        }),
      ),
    ).rejects.toMatchObject({ code: "SYNC_ACKNOWLEDGEMENT_STALE" });
    await expect(
      Effect.runPromise(
        acknowledgements.acknowledge(3, {
          deliveryId: lease.deliveryId,
          appliedSequence: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "SYNC_ACKNOWLEDGEMENT_AHEAD" });
    await Effect.runPromise(lease.close);
  });

  it("records a refused acknowledgement ahead of delivery", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-sync-ack-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const uninstall = installDiagnosticsStore(store);
    try {
      const acknowledgements = makeSyncAcknowledgements();
      const lease = await Effect.runPromise(acknowledgements.open(7));
      await Effect.runPromise(lease.recordDelivery(9));
      await expect(
        Effect.runPromise(
          acknowledgements.acknowledge(7, { deliveryId: lease.deliveryId, appliedSequence: 10 }),
        ),
      ).rejects.toMatchObject({ code: "SYNC_ACKNOWLEDGEMENT_AHEAD" });
      const db = openDiagnosticsReader(stateDir)!;
      expect(
        db.prepare("SELECT code, where_name, expected_json, actual_json FROM incidents").get(),
      ).toMatchObject({
        code: "COMMAND_REJECTED",
        where_name: "server.sync_ack",
        expected_json: '{"sequence":9}',
        actual_json: '{"sequence":10,"clientId":7}',
      });
      db.close();
      await Effect.runPromise(lease.close);
    } finally {
      uninstall();
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("supersedes the old connection lease without waiting for an in-flight cursor", async () => {
    const acknowledgements = makeSyncAcknowledgements();
    const oldLease = await Effect.runPromise(acknowledgements.open(4));
    await Effect.runPromise(oldLease.recordDelivery(1));
    const newLease = await Effect.runPromise(acknowledgements.open(4));

    await expect(Effect.runPromise(oldLease.recordDelivery(2))).rejects.toMatchObject({
      code: "SYNC_SUBSCRIPTION_SUPERSEDED",
    });
    await Effect.runPromise(newLease.recordDelivery(2));
  });
});
