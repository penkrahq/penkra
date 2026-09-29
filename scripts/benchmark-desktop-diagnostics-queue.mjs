/** Reproduce the main-thread enqueue latency comparison: bun scripts/benchmark-desktop-diagnostics-queue.mjs */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DesktopDiagnosticsQueue } from "../apps/desktop/src/desktopDiagnosticsQueue";
import { DiagnosticsSpoolWriter } from "../packages/shared/src/diagnostics/store";

const iterations = 2_000;
const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";

class ImmediateWorker extends EventEmitter {
  nextCredit = 1_025;
  unref() {
    return this;
  }
  postMessage(message) {
    if (message.kind === "refill") {
      this.emit("message", {
        kind: "credits",
        bootId: "0123456789abcdef0123456789abcdef",
        start: this.nextCredit,
        count: 1_024,
      });
      this.nextCredit += 1_024;
    } else if (message.kind === "checkpoint") {
      this.emit("message", { kind: "ack" });
    }
  }
  async terminate() {
    return 0;
  }
}

function percentiles(samples) {
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(3)),
    p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
    maxMs: Number(samples.at(-1).toFixed(3)),
  };
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-benchmark-"));
try {
  const writer = new DiagnosticsSpoolWriter({
    stateDir,
    appVersion: "0.14.3",
    process: "desktop-main",
  });
  const oldSamples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    writer.armExpectation({
      kind: "desktop.worker_ack",
      traceId,
      spanId,
      deadlineMs: 30_000,
    });
    oldSamples.push(performance.now() - start);
  }
  writer.close();

  const worker = new ImmediateWorker();
  const queue = new DesktopDiagnosticsQueue(
    () => worker,
    () => {},
    undefined,
    true,
  );
  queue.enqueue("checkpoint", { traceId, spanId, flow: "send", step: "composer.preflight" });
  worker.emit("message", {
    kind: "credits",
    bootId: "0123456789abcdef0123456789abcdef",
    start: 1,
    count: 1_024,
  });
  const newSamples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    queue.enqueue("checkpoint", { traceId, spanId, flow: "send", step: "composer.preflight" });
    newSamples.push(performance.now() - start);
  }
  process.stdout.write(
    `${JSON.stringify({ iterations, unit: "ms", priorSynchronousReservation: percentiles(oldSamples), workerCredits: percentiles(newSamples) }, null, 2)}\n`,
  );
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
