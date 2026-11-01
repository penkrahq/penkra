import { createReadStream, fstatSync } from "node:fs";

let rendererCredential: string | undefined;

/** Consume the desktop's one-use inherited pipe before server startup can spawn children. */
export async function initializeRendererCredential(): Promise<void> {
  const pipePresent = process.env.PENKRA_RENDERER_PIPE === "1";
  delete process.env.PENKRA_RENDERER_PIPE;
  rendererCredential = undefined;
  if (pipePresent) {
    try {
      const descriptor = fstatSync(3);
      // On Unix a Node stdio pipe is a socket. In particular, fd 3 can be
      // libuv's own kqueue when no pipe was passed: never read or close it.
      if (!descriptor.isSocket() && !(process.platform === "win32" && descriptor.isFIFO())) {
        throw new Error("Renderer credential pipe missing");
      }
      rendererCredential = await new Promise<string | undefined>((resolve) => {
        let value = "";
        const stream = createReadStream("", { fd: 3, autoClose: true, encoding: "utf8" });
        stream.on("data", (chunk) => {
          value += chunk;
          if (value.length > 64) stream.destroy();
        });
        stream.once("error", () => resolve(undefined));
        stream.once("close", () => resolve(/^[a-f0-9]{64}$/i.test(value) ? value : undefined));
      });
    } catch {
      rendererCredential = undefined;
    }
  }
  if (!rendererCredential)
    console.warn("Renderer credential unavailable; connections are external unless paired.");
}

export function getRendererCredential(): string | undefined {
  return rendererCredential;
}
