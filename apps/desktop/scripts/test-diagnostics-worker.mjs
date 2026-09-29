import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  DiagnosticsStore,
  openDiagnosticsReader,
  readLossLedger,
} from "@penkra/shared/diagnostics/store";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-worker-"));
const server = new DiagnosticsStore({
  stateDir,
  appVersion: "0.14.3",
  buildId: "abcdef123456",
  process: "server",
});
const worker = new Worker(path.join(desktopDir, "dist-electron/diagnosticsWorker.js"), {
  workerData: {
    stateDir,
    appVersion: "0.14.3",
    buildId: "abcdef123456",
    process: "desktop-main",
  },
});

try {
  let acknowledgements = 0;
  const drained = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.kind === "ack") acknowledgements++;
      if (message.kind === "drained") resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Diagnostics worker exited with ${code}`));
    });
  });
  const trace = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    threadId: "test-thread",
  };
  worker.postMessage({
    kind: "checkpoint",
    input: { ...trace, flow: "send", step: "composer.preflight" },
  });
  const armedAt = new Date().toISOString();
  worker.postMessage({ kind: "sendExpectation", input: { ...trace, armedAt } });
  worker.postMessage({
    kind: "checkpoint",
    input: {
      ...trace,
      flow: "send",
      step: "server.received",
      fields: { messageContent: "private message" },
    },
  });
  worker.postMessage({ kind: "shutdown" });
  assert.deepEqual(await drained, { kind: "drained" });
  assert.equal(acknowledgements, 3);

  const diagnosticDir = path.join(stateDir, "diagnostics");
  const spool = fs
    .readdirSync(diagnosticDir)
    .find((name) => /^spool-[a-f0-9]{32}\.jsonl$/u.test(name));
  assert.ok(spool, "worker must create a durable spool");
  const records = fs
    .readFileSync(path.join(diagnosticDir, spool), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.type !== "health");
  assert.equal(
    fs.readFileSync(path.join(diagnosticDir, spool), "utf8").includes("private message"),
    false,
  );
  assert.deepEqual(
    records.map((record) => record.type),
    ["checkpoint", "expectation_arm"],
  );
  assert.equal(records[0].data.traceId, trace.traceId);
  assert.equal(records[1].data.kind, "send.accepted");
  assert.equal(records[1].data.armedAt, armedAt);
  const lossSlots = fs
    .readdirSync(diagnosticDir)
    .filter((name) => /^loss-[a-f0-9]{32}\.bin$/u.test(name))
    .map((name) => readLossLedger(path.join(diagnosticDir, name)));
  assert.equal(
    lossSlots.some((slot) => slot?.reasons.spool === 1),
    true,
  );
  assert.equal(
    fs.readdirSync(diagnosticDir).filter((name) => name.startsWith("active-")).length,
    1,
  );

  server.checkpoint({ ...trace, flow: "send", step: "command.accepted", outcome: "ok" });
  server.importPeerSpools();
  const reader = openDiagnosticsReader(stateDir);
  assert.ok(reader);
  try {
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM expectations").get().count, 0);
    assert.equal(
      reader
        .prepare("SELECT COUNT(*) AS count FROM incidents WHERE code = 'SEND_PREFLIGHT_REJECTED'")
        .get().count,
      0,
    );
  } finally {
    reader.close();
  }
} finally {
  await worker.terminate();
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
