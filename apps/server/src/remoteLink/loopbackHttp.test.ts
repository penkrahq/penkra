import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openLoopbackHttp } from "./loopbackHttp";
import { TunnelSendWindow, TUNNEL_MAX_INFLIGHT_BYTES } from "./sendWindow";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";
import { httpFixture as fixture } from "./httpFixture.test-support";

async function textBody(body: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString();
}

describe("RemoteLink loopback HTTP", () => {
  it("preserves an early HTTP rejection without waiting for the upload to end", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(413);
        response.end("too large");
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "POST",
          path: "/api/attachments/upload?type=file",
        });
        try {
          const response = await transfer.response;
          expect(response.status).toBe(413);
          expect(await textBody(response.body)).toBe("too large");
          await expect(transfer.write(Buffer.from("late"))).rejects.toMatchObject({
            code: "invalid-state",
          });
          expect(transfer.signal.aborted).toBe(false);
        } finally {
          transfer.close();
        }
      },
    );
  });

  it("refuses concurrent writes and writes after request EOF", async () => {
    await fixture(
      (request, response) => {
        request.resume();
        request.on("end", () => response.end("ok"));
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "POST",
          path: "/api/attachments/cancel",
        });
        try {
          const writing = transfer.write(Buffer.from("{}"));
          await expect(transfer.write(Buffer.from("{}"))).rejects.toMatchObject({
            code: "invalid-state",
          });
          await writing;
          transfer.end();
          expect(() => transfer.end()).toThrow("invalid-state");
          await expect(transfer.write(Buffer.from("{}"))).rejects.toMatchObject({
            code: "invalid-state",
          });
          expect(await textBody((await transfer.response).body)).toBe("ok");
        } finally {
          transfer.close();
        }
      },
    );
  });

  it("pauses a real download at the send window and resumes after acknowledgements", async () => {
    const chunk = Buffer.alloc(32 * 1024, 23);
    const expectedHash = createHash("sha256");
    for (let i = 0; i < 800; i++) expectedHash.update(chunk);
    await fixture(
      (_request, response) => {
        let remaining = 800;
        const pump = () => {
          while (remaining > 0) {
            remaining--;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          response.end();
        };
        pump();
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/file",
        });
        const window = new TunnelSendWindow();
        const full = Promise.withResolvers<void>();
        const receivedHash = createHash("sha256");
        let received = 0;
        let buffered: { seq: number; bytes: Uint8Array }[] = [];
        let acknowledging = false;
        const consume = (seq: number, bytes: Uint8Array) => {
          received += bytes.byteLength;
          receivedHash.update(bytes);
          window.acknowledge(1, seq);
        };
        try {
          const response = await transfer.response;
          const producer = (async () => {
            let seq = 0;
            for await (const part of response.body) {
              for (
                let offset = 0;
                offset < part.byteLength;
                offset += NOISE_MAX_MESSAGE_BYTES - 16
              ) {
                const bytes = part.subarray(offset, offset + NOISE_MAX_MESSAGE_BYTES - 16);
                const reservation = window.reserve(
                  { id: 1, seq, bytes: bytes.byteLength + 16 },
                  transfer.signal,
                );
                if (window.snapshot().waiting) full.resolve();
                const lease = await reservation;
                lease.sent();
                if (acknowledging) consume(seq, bytes);
                else buffered.push({ seq, bytes });
                seq++;
              }
            }
          })();
          await full.promise;
          expect(window.snapshot().waiting).toBe(1);
          expect(window.snapshot().bytes).toBeLessThanOrEqual(TUNNEL_MAX_INFLIGHT_BYTES);
          expect(received).toBe(0);
          acknowledging = true;
          for (const entry of buffered) consume(entry.seq, entry.bytes);
          buffered = [];
          await producer;
          expect(received).toBe(25 * 1024 * 1024);
          expect(receivedHash.digest("hex")).toBe(expectedHash.digest("hex"));
          expect(window.snapshot().bytes).toBe(0);
          expect(transfer.signal.aborted).toBe(false);
        } finally {
          transfer.close();
          window.close();
        }
      },
    );
  });

  it("cancellation releases a download blocked on an acknowledgement", async () => {
    await fixture(
      (_request, response) => {
        response.write(Buffer.alloc(1024));
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/file",
        });
        const window = new TunnelSendWindow();
        try {
          let remaining = TUNNEL_MAX_INFLIGHT_BYTES;
          let seq = 0;
          while (remaining) {
            const bytes = Math.min(remaining, NOISE_MAX_MESSAGE_BYTES);
            (await window.reserve({ id: 1, seq: seq++, bytes })).sent();
            remaining -= bytes;
          }
          const iterator = (await transfer.response).body[Symbol.asyncIterator]();
          const part = await iterator.next();
          expect(part.done).toBe(false);
          const blocked = window.reserve({ id: 2, seq: 0, bytes: 1 }, transfer.signal);
          expect(window.snapshot().waiting).toBe(1);
          transfer.close();
          await expect(blocked).rejects.toMatchObject({ code: "cancelled" });
          expect(window.snapshot().waiting).toBe(0);
          await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
        } finally {
          transfer.close();
          window.close();
        }
      },
    );
  });

  it("streams a file incrementally, preserves metadata, and excludes private response headers", async () => {
    const first = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<{
      bytes: number;
      hash: string;
      auth: string | undefined;
      url: string | undefined;
    }>();
    await fixture(
      (request, response) => {
        let bytes = 0;
        const hash = createHash("sha256");
        request.on("data", (part: Buffer) => {
          bytes += part.length;
          hash.update(part);
          first.resolve();
        });
        request.on("end", () => {
          observed.resolve({
            bytes,
            hash: hash.digest("hex"),
            auth: request.headers.authorization,
            url: request.url,
          });
          response.writeHead(201, { "content-type": "text/plain", "set-cookie": "private=value" });
          response.end("accepted");
        });
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "POST",
          path: "/api/attachments/upload?type=file&name=test.bin",
          contentType: "application/octet-stream",
        });
        try {
          const chunk = Buffer.alloc(64 * 1024, 17);
          const hash = createHash("sha256");
          await transfer.write(chunk);
          hash.update(chunk);
          await first.promise; // The endpoint receives bytes before the upload ends.
          for (let i = 1; i < 400; i++) {
            await transfer.write(chunk);
            hash.update(chunk);
          }
          transfer.end();
          const response = await transfer.response;
          expect(response.status).toBe(201);
          expect(response.headers).toEqual({ "content-type": "text/plain" });
          expect(await textBody(response.body)).toBe("accepted");
          expect(await observed.promise).toEqual({
            bytes: 25 * 1024 * 1024,
            hash: hash.digest("hex"),
            auth: "Bearer fixture",
            url: "/api/attachments/upload?type=file&name=test.bin",
          });
          expect(transfer.signal.aborted).toBe(false);
        } finally {
          transfer.close();
        }
        expect(transfer.signal.aborted).toBe(true);
      },
    );
  });

  it("does not follow redirects or forward cookies", async () => {
    let requests = 0;
    await fixture(
      (_request, response) => {
        requests++;
        response.writeHead(302, { location: "/attachments/other", "set-cookie": "secret=value" });
        response.end();
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/file",
        });
        try {
          const response = await transfer.response;
          expect(response.status).toBe(302);
          expect(response.headers["set-cookie"]).toBeUndefined();
          await textBody(response.body);
          expect(requests).toBe(1);
        } finally {
          transfer.close();
        }
      },
    );
  });

  it("cancels an outstanding request without cancelling another transfer", async () => {
    const waiting = Promise.withResolvers<void>();
    await fixture(
      (request, response) => {
        if (request.url === "/attachments/wait") waiting.resolve();
        else response.end("independent");
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/wait",
        });
        await waiting.promise;
        transfer.close();
        transfer.close();
        await expect(transfer.response).rejects.toMatchObject({ code: "cancelled" });
        const other = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/other",
        });
        try {
          expect(await textBody((await other.response).body)).toBe("independent");
        } finally {
          other.close();
        }
      },
    );
  });

  it("fails a truncated response and aborts its transfer signal", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial", () => response.destroy());
      },
      async (origin) => {
        const transfer = openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/file",
        });
        try {
          await expect(
            (async () => textBody((await transfer.response).body))(),
          ).rejects.toMatchObject({ code: expect.stringMatching(/failed$/) });
          expect(transfer.signal.aborted).toBe(true);
        } finally {
          transfer.close();
        }
      },
    );
  });

  it("refuses non-loopback origins before sending credentials", () => {
    for (const origin of [
      "https://127.0.0.1",
      "http://example.com",
      "http://user:pass@127.0.0.1",
      "http://127.0.0.1/path",
    ]) {
      expect(() =>
        openLoopbackHttp({
          origin,
          credential: "fixture",
          method: "GET",
          path: "/attachments/file",
        }),
      ).toThrow("invalid-origin");
    }
  });
});
