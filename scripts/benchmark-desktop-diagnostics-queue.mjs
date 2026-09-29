/** Reproduce the main-thread enqueue latency comparison: bun scripts/benchmark-desktop-diagnostics-queue.mjs */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { DesktopDiagnosticsQueue } from "../apps/desktop/src/desktopDiagnosticsQueue";
import { DiagnosticsSpoolWriter } from "../packages/shared/src/diagnostics/store";

const iterations = 2_000;
const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/desktop/dist-electron/diagnosticsWorker.js",
);

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
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(3)),
    p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
    maxMs: Number(samples.at(-1).toFixed(3)),
  };
}

async function measureRealWorker(stateDir) {
  if (!fs.existsSync(workerPath))
    throw new Error(
      "Build the desktop diagnostics worker with `bun --cwd apps/desktop tsdown` first",
    );
  const realWorker = new Worker(workerPath, {
    workerData: { stateDir, appVersion: "0.14.3", process: "desktop-main" },
  });
  const pendingStarts = [];
  const ackSamples = [];
  const refillStarts = [];
  const refillSamples = [];
  let creditBlocks = 0;
  let acknowledgements = 0;
  const observedWorker = {
    on: (...args) => realWorker.on(...args),
    unref: () => realWorker.unref(),
    terminate: () => realWorker.terminate(),
    postMessage: (message) => {
      if (message.kind === "refill") refillStarts.push(performance.now());
      realWorker.postMessage(message);
    },
  };
  realWorker.on("message", (message) => {
    if (message.kind === "credits") {
      creditBlocks++;
      if (refillStarts.length) refillSamples.push(performance.now() - refillStarts.shift());
    }
    if (message.kind === "ack") {
      acknowledgements++;
      const started = pendingStarts.shift();
      if (started !== undefined) ackSamples.push(performance.now() - started);
    }
  });
  const queue = new DesktopDiagnosticsQueue(
    () => observedWorker,
    () => {
      throw new Error("The benchmark must not drop diagnostics");
    },
    undefined,
    true,
  );
  const checkpoint = { traceId, spanId, flow: "send", step: "composer.preflight" };
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    pendingStarts.push(performance.now());
    queue.enqueue("checkpoint", checkpoint);
    await waitFor(() => acknowledgements === 1, "initial worker ack");
    const enqueueSamples = [];
    for (let sent = 0, batch = 0; sent < iterations; batch++) {
      const size = Math.min(128, iterations - sent);
      const target = acknowledgements + size;
      for (let index = 0; index < size; index++, sent++) {
        const started = performance.now();
        pendingStarts.push(started);
        queue.enqueue("checkpoint", checkpoint);
        enqueueSamples.push(performance.now() - started);
      }
      await waitFor(() => acknowledgements >= target, `worker ack batch ${batch + 1}`);
    }
    await queue.drain();
    return {
      acknowledgements: acknowledgements - 1,
      creditBlocks,
      mainThreadEnqueue: percentiles(enqueueSamples),
      durableAck: percentiles(ackSamples.slice(1)),
      refillFsyncRoundTrip: percentiles(refillSamples),
    };
  } finally {
    await realWorker.terminate();
  }
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
  const realWorker = await measureRealWorker(stateDir);
  process.stdout.write(
    `${JSON.stringify({ iterations, unit: "ms", inMemoryMicrobenchmark: { priorSynchronousReservation: percentiles(oldSamples), workerCredits: percentiles(newSamples) }, realWorker }, null, 2)}\n`,
  );
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
