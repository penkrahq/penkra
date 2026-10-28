import { describe, expect, it } from "vitest";
import { httpFixture } from "./httpFixture.test-support";
import { RemoteRegistryClient } from "./registry";

const phoneId = "10000000-0000-4000-8000-000000000002";
const signal = () => new AbortController().signal;

describe("Mac device registry client", () => {
  it("posts sealed notifications with only the device credential", async () => {
    await httpFixture(
      (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/push");
        expect(request.headers.authorization).toBe("Bearer fixture-device-token");
        expect(request.headers.cookie).toBeUndefined();
        response.writeHead(202).end();
      },
      async (apiUrl) => {
        const client = new RemoteRegistryClient({ apiUrl, deviceToken: "fixture-device-token" });
        await client.push(
          { threadId: "thread", kind: "finished", sealed: { [phoneId]: "ciphertext" } },
          signal(),
        );
      },
    );
  });
  it.each(["http://example.com", "https://token@example.com", "https://example.com/?secret=value"])(
    "rejects an unsafe account endpoint before sending credentials: %s",
    (apiUrl) => {
      expect(() => new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" })).toThrow(
        "RemoteLink registry invalid-config.",
      );
    },
  );
  it("rejects invalid device ids without issuing a request or exposing the input", async () => {
    let requests = 0;
    await httpFixture(
      (_request, response) => {
        requests++;
        response.end();
      },
      async (apiUrl) => {
        const client = new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" });
        await expect(client.pair("private-invalid-value", signal())).rejects.toMatchObject({
          code: "invalid-device-id",
          message: "RemoteLink registry invalid-device-id.",
        });
        expect(requests).toBe(0);
      },
    );
  });
  it("uses device auth and the exact pairing/device routes without an account cookie", async () => {
    const requests: {
      method: string | undefined;
      path: string | undefined;
      auth: string | undefined;
      cookie: string | undefined;
      body: string;
    }[] = [];
    await httpFixture(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (part) => {
          body += part;
        });
        request.on("end", () => {
          requests.push({
            method: request.method,
            path: request.url,
            auth: request.headers.authorization,
            cookie: request.headers.cookie,
            body,
          });
          if (request.method === "GET") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify([{ phoneDeviceId: phoneId }]));
          } else {
            response.writeHead(204);
            response.end();
          }
        });
      },
      async (apiUrl) => {
        const client = new RemoteRegistryClient({ apiUrl, deviceToken: "fixture-device-token" });
        expect(await client.listPairings(signal())).toEqual([phoneId]);
        await client.pair(phoneId, signal());
        await client.unpair(phoneId, signal());
        await client.update({ appVersion: "0.14.6" }, signal());
        await client.unregister(signal());
      },
    );
    expect(requests.map((row) => [row.method, row.path, row.body])).toEqual([
      ["GET", "/v1/pairings", ""],
      ["POST", "/v1/pairings", JSON.stringify({ phoneDeviceId: phoneId })],
      ["DELETE", `/v1/pairings/${phoneId}`, ""],
      ["PATCH", "/v1/devices/self", JSON.stringify({ appVersion: "0.14.6" })],
      ["DELETE", "/v1/devices/self", ""],
    ]);
    expect(
      requests.every(
        (row) => row.auth === "Bearer fixture-device-token" && row.cookie === undefined,
      ),
    ).toBe(true);
  });

  it.each([401, 403, 302, 503])(
    "returns HTTP %s once without retry, redirect or response disclosure",
    async (status) => {
      let requests = 0;
      await httpFixture(
        (_request, response) => {
          requests++;
          response.writeHead(status, { location: "/stolen" });
          response.end("private-response-content");
        },
        async (apiUrl) => {
          const client = new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" });
          await expect(client.listPairings(signal())).rejects.toMatchObject({
            code: "http",
            status,
            message: "RemoteLink registry http.",
          });
          expect(requests).toBe(1);
        },
      );
    },
  );
  it.each([
    "not JSON",
    JSON.stringify([{ phoneDeviceId: 12 }]),
    JSON.stringify([{ phoneDeviceId: phoneId, unexpected: true }]),
  ])("rejects a malformed registry response: %s", async (body) => {
    await httpFixture(
      (_request, response) => response.end(body),
      async (apiUrl) => {
        await expect(
          new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" }).listPairings(signal()),
        ).rejects.toMatchObject({
          code: "invalid-response",
          message: "RemoteLink registry invalid-response.",
        });
      },
    );
  });
  it("cancels a pending request through its owner's signal", async () => {
    const entered = Promise.withResolvers<void>();
    await httpFixture(
      (_request, _response) => {
        entered.resolve();
      },
      async (apiUrl) => {
        const abort = new AbortController();
        const request = new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" }).listPairings(
          abort.signal,
        );
        void request.catch(() => undefined);
        await entered.promise;
        abort.abort();
        await expect(request).rejects.toMatchObject({ code: "cancelled" });
      },
    );
  });
  it("does not treat a body-bearing 200 as the mutation contract's 204", async () => {
    await httpFixture(
      (_request, response) => response.end("private"),
      async (apiUrl) => {
        await expect(
          new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" }).pair(phoneId, signal()),
        ).rejects.toMatchObject({ code: "invalid-response", status: 200 });
      },
    );
  });
});
