import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";

export async function httpFixture(
  handler: RequestListener,
  run: (origin: string, server: ReturnType<typeof createServer>) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
}
