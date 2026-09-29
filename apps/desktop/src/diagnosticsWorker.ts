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
  | {
      readonly kind: "checkpoint";
      readonly input: CheckpointInput;
      readonly expectationId?: string;
    }
  | { readonly kind: "incident"; readonly input: IncidentInput; readonly expectationId?: string }
  | {
      readonly kind: "sendExpectation";
      readonly input: { traceId: string; spanId: string; threadId?: string; armedAt?: string };
      readonly expectationId?: string;
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
  let settled = false;
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
    settled = message.kind !== "shutdown";
  } catch (cause) {
    if (cause instanceof TypeError) {
      try {
        writer.recordDrop("spool");
        settled = true;
      } catch {
        process.stderr.write("[diagnostics] desktop worker loss count failed\n");
      }
    }
    process.stderr.write("[diagnostics] desktop worker write failed\n");
  } finally {
    if (message.kind !== "shutdown") {
      if (settled && message.expectationId) {
        try {
          writer.resolveExpectation(message.expectationId, message.input);
        } catch {
          process.stderr.write("[diagnostics] desktop worker receipt failed\n");
        }
      }
      parentPort?.postMessage({ kind: "ack" });
    }
  }
});
process.once("exit", close);
