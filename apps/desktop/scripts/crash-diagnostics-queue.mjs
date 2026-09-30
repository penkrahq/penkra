import { EventEmitter } from "node:events";
import { DiagnosticsSpoolWriter } from "@penkra/shared/diagnostics/store";
import { DIAGNOSTIC_LIMITS } from "@penkra/shared/diagnostics/limits";
import { DesktopDiagnosticsQueue } from "../src/desktopDiagnosticsQueue.ts";

class StalledWorker extends EventEmitter {
  unref() {}
  postMessage() {}
}

const writer = new DiagnosticsSpoolWriter({
  stateDir: process.argv[2],
  appVersion: "0.14.3",
  process: "desktop-main",
});
const queue = new DesktopDiagnosticsQueue(
  () => new StalledWorker(),
  (reason, count) => writer.recordDrop(reason, count),
  (_kind, input) =>
    writer.armExpectation({
      traceId: input.traceId,
      spanId: input.spanId,
      kind: "desktop.worker_ack",
      deadlineMs: DIAGNOSTIC_LIMITS.desktopWorkerAckMs,
    }),
);
queue.enqueue("checkpoint", {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  flow: "send",
  step: "composer.preflight",
});
process.kill(process.pid, "SIGKILL");
