import { EventEmitter } from "node:events";
import { DiagnosticsSpoolWriter } from "@penkra/shared/diagnostics/store";
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
const worker = new StalledWorker();
const queue = new DesktopDiagnosticsQueue(
  () => worker,
  () => {},
  undefined,
  true,
);
queue.enqueue("checkpoint", { sequence: 0 });
worker.emit("message", { kind: "credits", ...writer.reserveWorkerCredits(4) });
queue.enqueue("checkpoint", {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  flow: "send",
  step: "composer.preflight",
});
process.kill(process.pid, "SIGKILL");
