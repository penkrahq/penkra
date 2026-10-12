import {
  encodeOutboundMultipart,
  invokePinnedDnsLookup,
  OutboundHttpError,
  OutboundHttpClient,
} from "@penkra/shared/outboundHttp";
import {
  assertJsonWithinLimits,
  assertOutboundUrlAllowed,
  isPublicIpAddress,
  OutboundPolicyError,
} from "@penkra/shared/outboundHttpPolicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as Http from "node:http";
import Https from "node:https";
import { syncBuiltinESMExports } from "node:module";

describe("outbound HTTP policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.5",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "2001:db8::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("admits public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it("pins requests to an exact HTTPS origin", () => {
    expect(
      assertOutboundUrlAllowed({
        url: "https://api.x.ai/v1/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }).pathname,
    ).toBe("/v1/language-models");
    expect(() =>
      assertOutboundUrlAllowed({
        url: "https://attacker.example/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
    expect(() =>
      assertOutboundUrlAllowed({
        url: "http://api.x.ai/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
  });

  it("bounds parsed JSON depth and node count", () => {
    expect(() =>
      assertJsonWithinLimits({ a: { b: { c: true } } }, { maxDepth: 2, maxNodes: 20 }),
    ).toThrowError(/depth limit/u);
    expect(() => assertJsonWithinLimits([1, 2, 3], { maxDepth: 2, maxNodes: 3 })).toThrowError(
      /node limit/u,
    );
  });

  it("encodes multipart bodies under an explicit byte budget", () => {
    const multipart = encodeOutboundMultipart(
      [
        {
          name: "file",
          filename: "voice.wav",
          contentType: "audio/wav",
          body: new Uint8Array([1, 2, 3]),
        },
      ],
      { maxBytes: 1_024 },
    );
    const body = new TextDecoder().decode(multipart.body);
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=Penkra-/u);
    expect(body).toContain('name="file"; filename="voice.wav"');
    expect(() =>
      encodeOutboundMultipart([{ name: "file", body: "oversize" }], { maxBytes: 4 }),
    ).toThrowError(OutboundHttpError);
    expect(() =>
      encodeOutboundMultipart(
        [{ name: "file", contentType: "audio/wav\r\nx-credential: leak", body: "x" }],
        { maxBytes: 1_024 },
      ),
    ).toThrowError(/content type is invalid/u);
  });
});

describe("invokePinnedDnsLookup", () => {
  const pinned = { address: "1.2.3.4", family: 4 as const };

  it("returns the legacy single-address form when all is not requested", () => {
    let result: unknown;
    invokePinnedDnsLookup(pinned, {}, (err, address, family) => {
      result = { err, address, family };
    });
    expect(result).toEqual({ err: null, address: "1.2.3.4", family: 4 });
  });

  it("returns the array form when Happy Eyeballs requests all addresses", () => {
    let result: unknown;
    invokePinnedDnsLookup(pinned, { all: true }, (err, address, family) => {
      result = { err, address, family };
    });
    expect(result).toEqual({
      err: null,
      address: [{ address: "1.2.3.4", family: 4 }],
      family: undefined,
    });
  });
});

describe("outbound request completion", () => {
  const input = {
    policy: {
      service: "event-completion-test",
      deadlineMs: 10_000,
      allowedOrigins: ["https://8.8.8.8"],
      maxRequestBytes: 1_024,
      maxResponseBytes: 1_024,
      maxRedirects: 0,
      maxConcurrent: 1,
      maxQueued: 1,
    },
    url: "https://8.8.8.8/usage",
  };

  function transport() {
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      destroy: vi.fn(),
    });
    let respond!: (response: Http.IncomingMessage) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    request.end.mockImplementation(() => started());
    const start = (
      _url: unknown,
      options: { signal: AbortSignal },
      callback: (response: Http.IncomingMessage) => void,
    ) => {
      respond = callback;
      options.signal.addEventListener("abort", () => request.emit("error", options.signal.reason), {
        once: true,
      });
      return request as unknown as Http.ClientRequest;
    };
    vi.spyOn(Https, "request").mockImplementation(start as typeof Https.request);
    syncBuiltinESMExports();
    return {
      request,
      response,
      ready,
      respond: () => respond(response as unknown as Http.IncomingMessage),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(["response", "body"])(
    "times out a silent %s and releases its admission slot",
    async (silentPart) => {
      const paths: string[] = [];
      let accept!: () => void;
      const accepted = new Promise<void>((resolve) => {
        accept = resolve;
      });
      const server = Http.createServer((request, response) => {
        paths.push(request.url!);
        if (request.url === "/silent") {
          if (silentPart === "body") {
            response.writeHead(200, { "content-type": "application/json", "content-length": "2" });
            response.write("{");
          }
          accept();
          return;
        }
        response.end("{}");
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Test server has no TCP port.");
      // Only the test transport is rerouted to this real local server. URL/DNS/admission,
      // deadline, abort and slot release still execute in the production client.
      const start = (
        url: string | URL,
        options: Https.RequestOptions,
        respond: (response: Http.IncomingMessage) => void,
      ) =>
        Http.request(
          new URL(`http://127.0.0.1:${address.port}${new URL(url).pathname}`),
          {
            method: options.method,
            headers: options.headers,
            signal: options.signal,
          },
          respond,
        );
      vi.spyOn(Https, "request").mockImplementation(start as typeof Https.request);
      syncBuiltinESMExports();
      try {
        const client = new OutboundHttpClient();
        const policy = {
          ...input.policy,
          service: `silent-${silentPart}-admission-test`,
          deadlineMs: 200,
        };
        const timedOut = expect(
          client.request({ policy, url: "https://8.8.8.8/silent" }),
        ).rejects.toMatchObject({
          name: "OutboundHttpError",
          code: "timeout",
          message: "Outbound request exceeded its 200ms deadline.",
        });
        await accepted;
        const next = client.request({
          policy: { ...policy, deadlineMs: 2_000 },
          url: "https://8.8.8.8/next",
        });
        await timedOut;
        expect((await next).status).toBe(200);
        expect(paths).toEqual(["/silent", "/next"]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.each([0, -1, Number.NaN])("rejects the invalid required deadline %s", async (deadlineMs) => {
    await expect(
      new OutboundHttpClient().request({ ...input, policy: { ...input.policy, deadlineMs } }),
    ).rejects.toMatchObject({
      code: "request",
      message: "Outbound request deadline must be a positive integer.",
    });
  });

  it("waits for the complete response body before returning", async () => {
    const wire = transport();
    let completed = false;
    const result = new OutboundHttpClient().request(input).then((response) => {
      completed = true;
      return response;
    });
    await wire.ready;
    wire.respond();
    wire.response.emit("data", Buffer.from('{"usage":'));
    await Promise.resolve();
    expect(completed).toBe(false);
    wire.response.emit("data", Buffer.from("42}"));
    wire.response.emit("end");
    expect(new TextDecoder().decode((await result).body)).toBe('{"usage":42}');
  });

  it("surfaces a network failure before the deadline", async () => {
    const wire = transport();
    const result = new OutboundHttpClient().request(input);
    const rejected = expect(result).rejects.toMatchObject({
      code: "request",
      cause: { message: "connection reset" },
    });
    await wire.ready;
    wire.request.emit("error", new Error("connection reset"));
    await rejected;
  });

  it("cancels on the caller's abort and releases admission for the next request", async () => {
    const wire = transport();
    const controller = new AbortController();
    const result = new OutboundHttpClient().request({ ...input, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({
      code: "aborted",
      cause: "user cancelled",
    });
    await wire.ready;
    controller.abort("user cancelled");
    await rejected;
    const next = transport();
    const response = new OutboundHttpClient().request(input);
    await next.ready;
    next.respond();
    next.response.emit("end");
    expect((await response).status).toBe(200);
  });
});
