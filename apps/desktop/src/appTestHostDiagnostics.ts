// FILE: appTestHostDiagnostics.ts
// Purpose: Keeps disposable App-test diagnostics from becoming a process-lifecycle dependency.
// Layer: Trusted desktop developer harness

import type { Writable } from "node:stream";

export interface AppTestHostDiagnosticWriter {
  write(message: string): void;
  close(): void;
}

/**
 * The result file is the App test protocol. stderr is only a bounded human-readable trace, so a
 * supervisor closing its pipe must stop diagnostics rather than terminate the Electron host.
 */
export function createAppTestHostDiagnosticWriter(
  stream: Pick<Writable, "on" | "off" | "write">,
): AppTestHostDiagnosticWriter {
  let available = true;
  const onError = () => {
    available = false;
  };
  stream.on("error", onError);

  return {
    write(message) {
      if (!available) return;
      try {
        stream.write(message, (error) => {
          if (error) available = false;
        });
      } catch {
        available = false;
      }
    },
    close() {
      available = false;
      stream.off("error", onError);
    },
  };
}
