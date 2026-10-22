import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { appCommandTimeoutMs } from "./appRuntimeCli.ts";

/** Backend-only subscription on the existing authenticated desktop command pipe. */
export function subscribeAppSkillChanges(
  changed: () => void,
  failed: (error: Error) => void,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const path = env.PENKRA_APP_COMMAND_PIPE;
    const token = env.PENKRA_APP_COMMAND_TOKEN;
    const adminToken = env.PENKRA_APP_COMMAND_ADMIN_TOKEN;
    if (!path || !token || !adminToken) {
      reject(new Error("App skill changes require the desktop backend capability."));
      return;
    }
    const id = randomUUID();
    const socket = createConnection(path);
    let ready = false;
    let closed = false;
    let bytes = "";
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        if (ready) failed(error);
        else reject(error);
      }
    };
    // Only subscription admission uses the existing command request deadline.
    // A subscribed stream has no idle deadline and is never automatically retried.
    const timer = setTimeout(
      () => finish(new Error("Desktop App skill subscription was not acknowledged.")),
      appCommandTimeoutMs("skills.subscribe"),
    );
    const abort = () => finish(new Error("App skill subscription was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ id, token, adminToken, method: "skills.subscribe" })}\n`),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      bytes += chunk;
      let newline: number;
      while ((newline = bytes.indexOf("\n")) >= 0) {
        if (closed) return;
        const line = bytes.slice(0, newline);
        bytes = bytes.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (!ready) {
            if (frame.id !== id || frame.ok !== true || frame.result?.subscribed !== true)
              throw new Error("Desktop rejected the App skill subscription.");
            ready = true;
            clearTimeout(timer);
            resolve(() => finish());
          } else {
            if (frame.type !== "skills.changed")
              throw new Error("Invalid desktop App skill change.");
            changed();
          }
        } catch (cause) {
          finish(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    });
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("Desktop App skill subscription closed.")));
  });
}
