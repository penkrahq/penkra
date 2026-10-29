// macOS path-change events for RemoteLink. This never infers relay reachability.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function watchRemoteNetworkPath(input: {
  signal: AbortSignal;
  onPath: () => void;
  onError: (error: Error) => void;
}): Promise<void> {
  if (process.platform !== "darwin" || input.signal.aborted) return Promise.resolve();
  const name = "penkra-network-path-monitor";
  const executable = [
    join(__dirname, "../resources/native", name),
    join(__dirname, "../prod-resources/native", name),
    join(process.resourcesPath, "native", name),
  ].find((path) => existsSync(path));
  if (!executable) {
    input.onError(new Error("The macOS network path monitor is missing."));
    return Promise.resolve();
  }
  const child = spawn(executable, [], { stdio: ["ignore", "pipe", "ignore"] });
  let pending = "";
  let failed = false;
  const fail = (error: Error) => {
    if (failed || input.signal.aborted) return;
    failed = true;
    input.onError(error);
  };
  const abort = () => child.kill("SIGTERM");
  input.signal.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    if (pending.length > 4096) {
      fail(new Error("The macOS network path monitor sent an oversized event."));
      child.kill("SIGTERM");
      return;
    }
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line !== "path-satisfied") {
        fail(new Error("The macOS network path monitor sent an invalid event."));
        child.kill("SIGTERM");
        return;
      }
      if (!input.signal.aborted) input.onPath();
    }
  });
  child.once("error", (error) => fail(error));
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      input.signal.removeEventListener("abort", abort);
      fail(new Error(`The macOS network path monitor exited (${signal ?? code}).`));
      resolve();
    });
  });
}
