import { parentPort, workerData } from "node:worker_threads";
import {
  DiagnosticsSpoolWriter,
  type CheckpointInput,
  type DiagnosticsOptions,
  type IncidentInput,
} from "@penkra/shared/diagnostics/store";
import { DIAGNOSTIC_LIMITS } from "@penkra/shared/diagnostics/limits";

type DiagnosticsMessage =
  | { readonly kind: "shutdown" }
  | { readonly kind: "checkpoint"; readonly input: CheckpointInput }
  | { readonly kind: "incident"; readonly input: IncidentInput }
  | {
      readonly kind: "sendExpectation";
      readonly input: { traceId: string; spanId: string; threadId?: string; armedAt?: string };
    };

const writer = new DiagnosticsSpoolWriter(workerData as DiagnosticsOptions);
const stopHealthSampling = writer.startHealthSampling();
let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  stopHealthSampling();
  writer.close();
};
parentPort?.on("message", (message: DiagnosticsMessage) => {
  try {
    switch (message.kind) {
      case "shutdown":
        close();
        parentPort?.postMessage({ kind: "drained" });
        parentPort?.close();
        break;
      case "checkpoint":
        writer.checkpoint(message.input);
        break;
      case "incident":
        writer.incident(message.input);
        break;
      case "sendExpectation":
        writer.armExpectation({
          ...message.input,
          kind: "send.accepted",
          deadlineMs: DIAGNOSTIC_LIMITS.sendAcceptedMs,
        });
        break;
    }
  } catch {
    process.stderr.write("[diagnostics] desktop worker write failed\n");
  }
});
process.once("exit", close);
