import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { installDiagnosticsStore } from "./recorder";
import { DiagnosticsStore, openDiagnosticsReader } from "./store";
import { makeSyncAcknowledgements } from "../wsSyncAcknowledgements";
import { makeWsStreamAdmission } from "../wsStreamAdmission";
import {
  recordMcpAuthorityRejected,
  recordMcpScopeDenied,
} from "../agentGateway/mcpWriteDiagnostics";

const roots: string[] = [];
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-hotspot-diagnostics-"));
  roots.push(stateDir);
  const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
  const uninstall = installDiagnosticsStore(store);
  return {
    stateDir,
    close: () => {
      uninstall();
      store.close();
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production failure incidents", () => {
  it("records a denied MCP capability by stable name", () => {
    const { stateDir, close } = fixture();
    recordMcpScopeDenied({ threadId: "thread-3", turnId: null, capability: "thread:write" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "SCOPE_DENIED",
      context_json: '{"capability":"thread:write"}',
    });
    db.close();
    close();
  });
  it("records the inactive caller turn with its failed authority check", () => {
    const { stateDir, close } = fixture();
    recordMcpAuthorityRejected({
      trace: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" },
      threadId: "thread-3",
      arrivedTurnId: "turn-old",
      expectedTurnId: "turn-old",
      observedTurnId: "turn-new",
      failedCheck: "authorized_turn_no_longer_active",
    });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, actual_json, context_json FROM incidents").get()).toMatchObject(
      {
        code: "CALLER_TURN_INACTIVE",
        actual_json: '{"accepted":false,"activeTurnId":"turn-new","callerTurnId":"turn-old"}',
        context_json: '{"mcpCheck":"authorized_turn_no_longer_active"}',
      },
    );
    db.close();
    close();
  });
  it("names the failed synchronization acknowledgement check", async () => {
    const { stateDir, close } = fixture();
    const acknowledgements = makeSyncAcknowledgements();
    const lease = await Effect.runPromise(acknowledgements.open(7));
    await Effect.runPromise(lease.recordDelivery(9));
    await Effect.runPromise(
      acknowledgements
        .acknowledge(7, { deliveryId: "stale", appliedSequence: 9 })
        .pipe(Effect.exit),
    );
    await Effect.runPromise(
      acknowledgements
        .acknowledge(8, { deliveryId: "stale", appliedSequence: 9 })
        .pipe(Effect.exit),
    );
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT code, context_json FROM incidents ORDER BY context_json").all(),
    ).toMatchObject([
      { code: "SYNC_ACK_STALE", context_json: '{"check":"delivery_matches"}' },
      { code: "SYNC_ACK_STALE", context_json: '{"check":"lease_exists"}' },
    ]);
    db.close();
    close();
  });

  it("records stream admission reason without a subscription key", async () => {
    const { stateDir, close } = fixture();
    const admission = await Effect.runPromise(makeWsStreamAdmission());
    const lease = await Effect.runPromise(
      admission.acquire(3, { key: "private-subscription-key", threadId: "thread-3" }),
    );
    await Effect.runPromise(
      admission
        .acquire(3, { key: "private-subscription-key", threadId: "thread-3" })
        .pipe(Effect.exit),
    );
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "REJECTED_STREAMING_RPC_ADMISSION",
      context_json: '{"reason":"duplicate"}',
    });
    db.close();
    expect(
      fs
        .readFileSync(path.join(stateDir, "diagnostics", "diagnostics.sqlite"))
        .includes("private-subscription-key"),
    ).toBe(false);
    await Effect.runPromise(admission.release(lease));
    close();
  });
});
