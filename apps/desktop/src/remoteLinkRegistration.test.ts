import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RemoteLinkRegistrationOwner } from "./remoteLinkRegistration";
import type { RemoteLinkCredentials } from "./remoteLinkCredentialVault";
import { deferred } from "./deferred.test-support";

const privateKey = Buffer.from(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  "hex",
).toString("base64");
const publicKey = Buffer.from(
  "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  "hex",
).toString("base64");
const registration = (value: number) => ({
  deviceId: "10000000-0000-4000-8000-000000000001",
  deviceToken: Buffer.alloc(32, value).toString("base64url"),
});
async function fixture(handler: RequestListener, run: (apiUrl: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}
function owner(apiUrl: string, request?: typeof fetch) {
  const records = new Map<string, RemoteLinkCredentials>();
  let account: { accountId: string; cookie: string } | null = {
    accountId: "a",
    cookie: "session=private",
  };
  const instance = new RemoteLinkRegistrationOwner({
    apiUrl,
    ...(request ? { fetch: request } : {}),
    metadata: { name: "Test Mac", model: "Test model", appVersion: "0.14.6" },
    account: async () => account,
    vault: {
      read: async (id) => records.get(id) ?? null,
      getOrCreate: async (id) => {
        if (!records.has(id))
          records.set(id, { identityPrivateKey: privateKey, registration: null });
        return records.get(id)!;
      },
      register: async (id, key, next) => {
        if (records.get(id)?.identityPrivateKey !== key) throw new Error("Identity changed");
        records.set(id, { identityPrivateKey: key, registration: next });
      },
    },
  });
  return {
    instance,
    records,
    setAccount: (next: typeof account) => {
      account = next;
    },
  };
}
const signal = () => new AbortController().signal;

describe("desktop-owned RemoteLink registration", () => {
  it("uses the account-session-observing request transport", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(registration(1), { status: 201 }),
    );
    const { instance } = owner("https://account.example.test", request);
    expect((await instance.ensure("a", signal())).registration).toEqual(registration(1));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].toString()).toBe("https://account.example.test/v1/devices");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("cookie")).toBe("session=private");
  });
  it("registers once, sends only the public identity, and renews the token only on explicit sign-in", async () => {
    let requests = 0;
    const bodies: unknown[] = [];
    await fixture(
      (request, response) => {
        expect(request.url).toBe("/v1/devices");
        expect(request.headers.cookie).toBe("session=private");
        expect(request.headers.authorization).toBeUndefined();
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests++;
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.writeHead(201).end(JSON.stringify(registration(requests)));
        });
      },
      async (url) => {
        const { instance, records } = owner(url);
        const first = await instance.ensure("a", signal());
        expect(first.registration).toEqual(registration(1));
        await instance.ensure("a", signal());
        expect(requests).toBe(1);
        const renewed = await instance.renewAfterSignIn("a", signal());
        expect(renewed?.registration).toEqual(registration(2));
        expect(records.get("a")?.identityPrivateKey).toBe(privateKey);
        expect(bodies).toEqual(
          Array(2).fill({
            kind: "mac",
            name: "Test Mac",
            model: "Test model",
            appVersion: "0.14.6",
            identityKey: publicKey,
          }),
        );
        expect(JSON.stringify(bodies)).not.toContain(privateKey);
      },
    );
  });

  it("sign-in does not enable phone access or register an unused identity", async () => {
    await fixture(
      () => {
        throw new Error("No request expected");
      },
      async (url) => {
        const { instance, records } = owner(url);
        expect(await instance.renewAfterSignIn("a", signal())).toBeNull();
        records.set("a", { identityPrivateKey: privateKey, registration: null });
        expect((await instance.renewAfterSignIn("a", signal()))?.registration).toBeNull();
      },
    );
  });

  it.each([401, 403, 302, 503])(
    "HTTP %s preserves the prior registration and never retries",
    async (status) => {
      let requests = 0;
      await fixture(
        (_request, response) => {
          requests++;
          response.writeHead(status, { location: "/wrong" }).end("private-server-response");
        },
        async (url) => {
          const { instance, records } = owner(url);
          const old = { identityPrivateKey: privateKey, registration: registration(1) };
          records.set("a", old);
          await expect(instance.renewAfterSignIn("a", signal())).rejects.toMatchObject({
            code: "http",
            status,
          });
          expect(records.get("a")).toEqual(old);
          expect(requests).toBe(1);
        },
      );
    },
  );

  it("an account switch during the response cannot store a token for the wrong account", async () => {
    const pending = deferred();
    const release = deferred();
    await fixture(
      (_request, response) => {
        pending.resolve();
        void release.promise.then(() =>
          response.writeHead(201).end(JSON.stringify(registration(2))),
        );
      },
      async (url) => {
        const { instance, records, setAccount } = owner(url);
        const old = { identityPrivateKey: privateKey, registration: registration(1) };
        records.set("a", old);
        const renewing = instance.renewAfterSignIn("a", signal());
        try {
          await pending.promise;
          setAccount({ accountId: "b", cookie: "session=other" });
          release.resolve();
          await expect(renewing).rejects.toMatchObject({ code: "account-changed" });
          expect(records.get("a")).toEqual(old);
          expect(records.has("b")).toBe(false);
        } finally {
          release.resolve();
        }
      },
    );
  });

  it("invalidation cancels an in-flight request and a queued renewal without rotating stored tokens", async () => {
    const pending = deferred();
    await fixture(
      () => pending.resolve(),
      async (url) => {
        const { instance, records } = owner(url);
        const old = { identityPrivateKey: privateKey, registration: registration(1) };
        records.set("a", old);
        const first = instance.renewAfterSignIn("a", signal());
        const second = instance.renewAfterSignIn("a", signal());
        const checked = Promise.all([
          expect(first).rejects.toMatchObject({ code: "cancelled" }),
          expect(second).rejects.toMatchObject({ code: "cancelled" }),
        ]);
        await pending.promise;
        instance.invalidate();
        await checked;
        expect(records.get("a")).toEqual(old);
      },
    );
  });

  it("rejects malformed credential responses without logging or retaining response content", async () => {
    await fixture(
      (_request, response) => response.writeHead(201).end('{"deviceToken":"private-invalid"}'),
      async (url) => {
        const { instance, records } = owner(url);
        await expect(instance.ensure("a", signal())).rejects.toMatchObject({
          code: "invalid-response",
          message: "RemoteLink registration invalid-response.",
        });
        expect(records.get("a")?.registration).toBeNull();
      },
    );
  });
});
