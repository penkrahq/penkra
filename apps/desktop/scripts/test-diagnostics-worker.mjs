import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-worker-"));
const worker = new Worker(path.join(desktopDir, "dist-electron/diagnosticsWorker.js"), {
  workerData: {
    stateDir,
    appVersion: "0.14.3",
    buildId: "abcdef123456",
    process: "desktop-main",
  },
});

try {
  const drained = new Promise((resolve, reject) => {
    worker.once("message", resolve);
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
  worker.postMessage({ kind: "shutdown" });
  assert.deepEqual(await drained, { kind: "drained" });

  const diagnosticDir = path.join(stateDir, "diagnostics");
  const spool = fs.readdirSync(diagnosticDir).find((name) => name.startsWith("spool-"));
  assert.ok(spool, "worker must create a durable spool");
  const records = fs
    .readFileSync(path.join(diagnosticDir, spool), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.type !== "health");
  assert.deepEqual(
    records.map((record) => record.type),
    ["checkpoint", "expectation_arm"],
  );
  assert.equal(records[0].data.traceId, trace.traceId);
  assert.equal(records[1].data.kind, "send.accepted");
  assert.equal(records[1].data.armedAt, armedAt);
  assert.equal(
    fs.readdirSync(diagnosticDir).some((name) => name.startsWith("active-")),
    false,
  );
} finally {
  await worker.terminate();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
