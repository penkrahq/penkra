import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { NoiseCipher } from "./noise";
import { TunnelChannel } from "./tunnelChannel";
import { encodeHttpBody, type TunnelEnvelope } from "./tunnelCodec";
import { RemoteHttpBridge } from "./httpBridge";
import { httpFixture } from "./httpFixture.test-support";

function harness(origin: string) {
  const events = new EventEmitter();
  const outcomes = new Map<
    number,
    {
      status?: number;
      bytes: number;
      hash: ReturnType<typeof createHash>;
      done: boolean;
      error?: string;
    }
  >();
  const observations: { id: number; event: string; bytes?: number }[] = [];
  const tasks = new Set<Promise<void>>();
  let failure: unknown;
  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task
      .catch((error) => {
        failure = error;
        events.emit("change");
      })
      .finally(() => tasks.delete(task));
  };
  const key1 = new Uint8Array(32).fill(1),
    key2 = new Uint8Array(32).fill(2);
  let bridge: RemoteHttpBridge;
  let phone: TunnelChannel;
  const mac = new TunnelChannel(
    { send: new NoiseCipher(key1), receive: new NoiseCipher(key2) },
    async (bytes) => {
      const envelope = phone.receive(bytes);
      events.emit("change");
      if (!envelope || !("id" in envelope)) return;
      let state = outcomes.get(envelope.id);
      if (!state) {
        state = { bytes: 0, hash: createHash("sha256"), done: false };
        outcomes.set(envelope.id, state);
      }
      if (envelope.t === "http.res") state.status = envelope.status;
      if (envelope.t === "error") {
        state.error = envelope.reason;
        state.done = true;
      }
      if (envelope.t === "http.body") {
        const part = Buffer.from(envelope.body, "base64");
        state.bytes += part.byteLength;
        state.hash.update(part);
        state.done = envelope.more === undefined;
        track(phone.send({ t: "ack", id: envelope.id, seq: envelope.seq }));
      }
      events.emit("change");
    },
  );
  phone = new TunnelChannel(
    { send: new NoiseCipher(key2), receive: new NoiseCipher(key1) },
    async (bytes) => {
      const envelope = mac.receive(bytes);
      events.emit("change");
      if (envelope?.t === "http" || envelope?.t === "http.body" || envelope?.t === "http.cancel")
        track(bridge.accept(envelope));
    },
  );
  bridge = new RemoteHttpBridge({
    origin,
    credential: "fixture-token",
    channel: mac,
    observe: (event) => {
      observations.push(event);
      events.emit("change");
    },
  });
  const waitFor = (predicate: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (failure || predicate()) {
          events.off("change", check);
          if (failure) reject(failure);
          else resolve();
        }
      };
      events.on("change", check);
      check();
    });
  return {
    phone,
    mac,
    bridge,
    outcomes,
    observations,
    waitFor,
    async send(envelope: TunnelEnvelope) {
      await phone.send(envelope);
    },
    async close() {
      mac.close();
      phone.close();
      await bridge.close();
      await Promise.allSettled(tasks);
    },
  };
}

async function* fileBody() {
  for (let i = 0; i < 80; i++) yield Buffer.alloc(64 * 1024, 31);
}

describe("RemoteLink HTTP request bridge", () => {
  it("drains and ACKs in-flight chunks after an early rejection, without an extra upload error", async () => {
    await httpFixture(
      (_request, response) => {
        response.writeHead(413);
        response.end("too large");
      },
      async (origin) => {
        const peer = harness(origin);
        try {
          await peer.send({
            t: "http",
            id: 1,
            method: "POST",
            path: "/api/attachments/upload?type=file",
          });
          await peer.waitFor(() => peer.outcomes.get(1)?.done === true);
          for await (const packet of encodeHttpBody({ id: 1, body: fileBody() }))
            await peer.send(packet.envelope);
          await peer.waitFor(() => peer.phone.window.snapshot().bytes === 0);
          expect(peer.outcomes.get(1)?.status).toBe(413);
          expect(peer.outcomes.get(1)?.error).toBeUndefined();
          expect(peer.mac.signal.aborted).toBe(false);
        } finally {
          await peer.close();
        }
      },
    );
  });

  it("drains remaining upload chunks after a connection failure and serves another request", async () => {
    await httpFixture(
      (request, response) => {
        if (request.url?.startsWith("/api/attachments/upload")) request.socket.destroy();
        else response.end("ok");
      },
      async (origin) => {
        const peer = harness(origin);
        try {
          await peer.send({
            t: "http",
            id: 1,
            method: "POST",
            path: "/api/attachments/upload?type=file",
          });
          await peer.waitFor(() => peer.outcomes.get(1)?.error !== undefined);
          for await (const packet of encodeHttpBody({ id: 1, body: fileBody() }))
            await peer.send(packet.envelope);
          await peer.waitFor(() => peer.phone.window.snapshot().bytes === 0);
          await peer.send({ t: "http", id: 2, method: "GET", path: "/attachments/file" });
          await peer.waitFor(() => peer.outcomes.get(2)?.done === true);
          expect(peer.outcomes.get(2)?.bytes).toBe(2);
          expect(peer.mac.signal.aborted).toBe(false);
        } finally {
          await peer.close();
        }
      },
    );
  });

  it("bridges encrypted upload chunks to a real HTTP endpoint and streams its response", async () => {
    const uploaded = Promise.withResolvers<{
      bytes: number;
      hash: string;
      auth: string | undefined;
    }>();
    await httpFixture(
      (request, response) => {
        let bytes = 0;
        const hash = createHash("sha256");
        request.on("data", (part: Buffer) => {
          bytes += part.byteLength;
          hash.update(part);
        });
        request.on("end", () => {
          uploaded.resolve({
            bytes,
            hash: hash.digest("hex"),
            auth: request.headers.authorization,
          });
          response.writeHead(201);
          response.end("stored");
        });
      },
      async (origin) => {
        const peer = harness(origin);
        try {
          await peer.send({
            t: "http",
            id: 1,
            method: "POST",
            path: "/api/attachments/upload?type=file",
            contentType: "application/octet-stream",
          });
          const hash = createHash("sha256");
          for await (const part of fileBody()) hash.update(part);
          for await (const packet of encodeHttpBody({ id: 1, body: fileBody() }))
            await peer.send(packet.envelope);
          await peer.waitFor(() => peer.outcomes.get(1)?.done === true);
          await peer.waitFor(
            () =>
              peer.phone.window.snapshot().bytes === 0 && peer.mac.window.snapshot().bytes === 0,
          );
          expect(await uploaded.promise).toEqual({
            bytes: 5 * 1024 * 1024,
            hash: hash.digest("hex"),
            auth: "Bearer fixture-token",
          });
          expect(peer.outcomes.get(1)?.status).toBe(201);
          expect(peer.outcomes.get(1)?.bytes).toBe(6);
          expect(peer.outcomes.get(1)?.error).toBeUndefined();
        } finally {
          await peer.close();
        }
      },
    );
  });

  it("cancels one open request while another request completes", async () => {
    const waiting = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    await httpFixture(
      (request, response) => {
        if (request.url === "/attachments/wait") {
          request.on("close", () => disconnected.resolve());
          waiting.resolve();
        } else response.end("independent");
      },
      async (origin) => {
        const peer = harness(origin);
        try {
          await peer.send({ t: "http", id: 1, method: "GET", path: "/attachments/wait" });
          await waiting.promise;
          await peer.send({ t: "http", id: 2, method: "GET", path: "/attachments/other" });
          await peer.send({ t: "http.cancel", id: 1 });
          await disconnected.promise;
          await peer.waitFor(() => peer.outcomes.get(2)?.done === true);
          expect(peer.outcomes.get(2)?.bytes).toBe(11);
          expect(peer.mac.signal.aborted).toBe(false);
          expect(peer.observations).toContainEqual({ id: 1, event: "cancelled" });
        } finally {
          await peer.close();
        }
      },
    );
  });

  it("refuses forbidden paths without HTTP access and leaves the session usable", async () => {
    let requests = 0;
    await httpFixture(
      (_request, response) => {
        requests++;
        response.end("ok");
      },
      async (origin) => {
        const peer = harness(origin);
        try {
          await peer.send({ t: "http", id: 1, method: "GET", path: "/api/auth/sessions" });
          await peer.waitFor(() => peer.outcomes.get(1)?.done === true);
          expect(peer.outcomes.get(1)?.error).toBe("forbidden-path");
          expect(requests).toBe(0);
          await peer.send({ t: "http", id: 2, method: "GET", path: "/attachments/file" });
          await peer.waitFor(() => peer.outcomes.get(2)?.done === true);
          expect(requests).toBe(1);
        } finally {
          await peer.close();
        }
      },
    );
  });
});
