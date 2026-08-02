import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppRegistryClient } from "./appRegistryClient";

const summary = {
  id: "00000000-0000-4000-8000-000000000301",
  identifier: "com.penkra.canvas",
  slug: "canvas",
  displayName: "Canvas",
  summary: "Create visual documents",
  publisher: {
    slug: "penkra",
    displayName: "Penkra",
    domain: "penkra.com",
    verified: true,
  },
  latestVersion: "1.0.0",
  iconAssetId: "00000000-0000-4000-8000-000000000302",
  installCount: 4,
  rating: 5,
  ratingCount: 1,
};

describe("desktop App registry client", () => {
  it("uses the encrypted account cookie without exposing it in the result", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [summary],
        pageInfo: { nextCursor: null },
      }),
    );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com/",
      getCookie: () => "better-auth.session_token=secret",
      fetch,
    });

    const result = await client.list({ query: " Canvas ", limit: 20 });

    expect(result.items[0]).toEqual(summary);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.penkra.com/api/registry/apps?query=Canvas&limit=20",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          cookie: "better-auth.session_token=secret",
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("requires an authenticated account before network access", async () => {
    const fetch = vi.fn();
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "",
      fetch,
    });

    await expect(client.list()).rejects.toThrow("Sign in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates, uploads, and finalizes an authenticated developer submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-registry-submit-"));
    try {
      const packageBytes = Buffer.from("package");
      const signatureBytes = Buffer.from(
        JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }),
      );
      const packagePath = join(directory, "app.penkra");
      const signaturePath = join(directory, "bundle.json");
      await Promise.all([
        writeFile(packagePath, packageBytes),
        writeFile(signaturePath, signatureBytes),
      ]);
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const value = String(url);
        if (value.endsWith("/submissions") && init?.method === "POST") {
          return jsonResponse(
            {
              submissionId: "00000000-0000-4000-8000-000000000311",
              uploads: {
                package: {
                  url: "https://uploads.test/package",
                  headers: { "content-type": "application/vnd.penkra.app+zip" },
                },
                publisherSignature: {
                  url: "https://uploads.test/signature",
                  headers: { "content-type": "application/vnd.dev.sigstore.bundle+json" },
                },
              },
            },
            201,
          );
        }
        if (value.startsWith("https://uploads.test/")) return new Response(null, { status: 200 });
        if (value.endsWith("/finalize"))
          return jsonResponse({
            submissionId: "00000000-0000-4000-8000-000000000311",
            status: "uploaded",
          });
        throw new Error(`Unexpected request ${value}`);
      });
      const client = new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "cookie=value",
        fetch,
      });

      await expect(
        client.developerSubmit({
          appId: "00000000-0000-4000-8000-000000000301",
          packagePath,
          signaturePath,
          issuer: "https://accounts.google.com",
          evidence: {
            version: "1.0.0",
            compatibilityRange: ">=0.8.0",
            manifestDigest: "a".repeat(64),
            packageDigest: createHash("sha256").update(packageBytes).digest("hex"),
            readmeDigest: "b".repeat(64),
            instructionsDigest: "c".repeat(64),
            packageSizeBytes: packageBytes.length,
            permissions: [],
          },
        }),
      ).resolves.toEqual({
        submissionId: "00000000-0000-4000-8000-000000000311",
        status: "uploaded",
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed service data at the trusted boundary", async () => {
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({
          items: [{ ...summary, installCount: -1 }],
          pageInfo: { nextCursor: null },
        }),
      ),
    });

    await expect(client.list()).rejects.toThrow("invalid response");
  });

  it("preserves the registry's exact host compatibility range", async () => {
    const detail = registryDetail("a".repeat(64));
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch: vi.fn().mockResolvedValue(jsonResponse(detail)),
    });

    await expect(client.get({ slug: "canvas" })).resolves.toEqual(detail);
  });

  it("downloads a package only after digest and pinned registry-attestation verification", async () => {
    const packageBytes = Buffer.from("registry package");
    const packageDigest = createHash("sha256").update(packageBytes).digest("hex");
    const detail = registryDetail(packageDigest);
    const version = detail.versions[0]!;
    const signed = signedAttestation(detail, version);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith(`/apps/canvas/versions/1.0.0/package`)) {
        return jsonResponse({
          appId: detail.id,
          versionId: version.id,
          version: version.version,
          url: "https://downloads.test/package",
          sha256: packageDigest,
          sizeBytes: packageBytes.length,
          expiresInSeconds: 300,
        });
      }
      if (value.endsWith(`/artifacts/${version.registrySignatureArtifactId}`)) {
        return jsonResponse({
          url: "https://downloads.test/registry.jws",
          contentType: "application/jose",
          expiresInSeconds: 300,
        });
      }
      if (value === "https://downloads.test/package") {
        return new Response(packageBytes, {
          headers: { "content-length": String(packageBytes.length) },
        });
      }
      if (value === "https://downloads.test/registry.jws") return new Response(signed.jws);
      return new Response(null, { status: 404 });
    });
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch: fetch as typeof globalThis.fetch,
      trustedRegistryKeys: [signed.trustKey],
    });

    await expect(client.downloadVerifiedRelease({ app: detail, version })).resolves.toMatchObject({
      packageBytes: new Uint8Array(packageBytes),
      release: { packageDigest, keyId: signed.trustKey.kid },
    });
  });

  it("keeps arbitrary URLs and methods out of the Apps renderer API", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://downloads.test/icon",
          contentType: "image/png",
          expiresInSeconds: 300,
        }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await expect(
      client.getArtifact({
        id: "00000000-0000-4000-8000-000000000302",
        source: "asset",
      }),
    ).resolves.toEqual({
      kind: "image",
      contentType: "image/png",
      dataUrl: "data:image/png;base64,AQID",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.penkra.com/api/registry/assets/00000000-0000-4000-8000-000000000302",
      expect.objectContaining({ headers: expect.objectContaining({ cookie: "cookie=value" }) }),
    );
    expect(fetch.mock.calls[1]).toEqual([
      "https://downloads.test/icon",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  it("accepts the registry's UTF-8 Markdown media type without passing MIME parameters through", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://downloads.test/readme",
          contentType: "text/markdown; charset=utf-8",
          expiresInSeconds: 300,
        }),
      )
      .mockResolvedValueOnce(
        new Response("# Canvas\n", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
      );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await expect(
      client.getArtifact({
        id: "00000000-0000-4000-8000-000000000304",
        source: "artifact",
      }),
    ).resolves.toEqual({
      kind: "text",
      contentType: "text/markdown",
      text: "# Canvas\n",
    });
  });

  it("records an authenticated successful-install receipt without exposing a generic request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        appId: summary.id,
        firstInstalledVersionId: "00000000-0000-4000-8000-000000000303",
        installedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await client.recordSuccessfulInstall({
      appId: summary.id,
      versionId: "00000000-0000-4000-8000-000000000303",
    });

    expect(fetch).toHaveBeenCalledWith(
      `https://api.penkra.com/api/registry/apps/${summary.id}/install-receipts`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ versionId: "00000000-0000-4000-8000-000000000303" }),
        headers: expect.objectContaining({
          cookie: "cookie=value",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("reads and writes only bounded install-gated account feedback", async () => {
    const updatedAt = "2026-08-02T00:00:00.000Z";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          appId: summary.id,
          eligible: true,
          installedAt: "2026-08-01T00:00:00.000Z",
          rating: null,
          review: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ appId: summary.id, rating: 5, updatedAt }))
      .mockResolvedValueOnce(
        jsonResponse({
          appId: summary.id,
          body: "Useful",
          status: "pending",
          updatedAt,
        }),
      );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await expect(client.getFeedback({ appId: summary.id })).resolves.toMatchObject({
      appId: summary.id,
      eligible: true,
      rating: null,
    });
    await expect(client.setRating({ appId: summary.id, rating: 5 })).resolves.toEqual({
      appId: summary.id,
      rating: 5,
      updatedAt,
    });
    await expect(client.setReview({ appId: summary.id, body: "  Useful  " })).resolves.toEqual({
      appId: summary.id,
      body: "Useful",
      status: "pending",
      updatedAt,
    });

    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://api.penkra.com/api/registry/apps/${summary.id}/feedback`,
    );
    expect(fetch.mock.calls[1]).toEqual([
      `https://api.penkra.com/api/registry/apps/${summary.id}/rating`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ rating: 5 }) }),
    ]);
    expect(fetch.mock.calls[2]).toEqual([
      `https://api.penkra.com/api/registry/apps/${summary.id}/review`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ body: "Useful" }) }),
    ]);
  });

  it("rejects invalid account feedback before or at the trust boundary", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        appId: summary.id,
        eligible: true,
        installedAt: "not-a-date",
        rating: 5,
        review: null,
      }),
    );
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await expect(client.setRating({ appId: summary.id, rating: 6 })).rejects.toThrow(
      "between 1 and 5",
    );
    await expect(client.setReview({ appId: summary.id, body: "   " })).rejects.toThrow(
      "between 1 and 10000",
    );
    await expect(client.getFeedback({ appId: summary.id })).rejects.toThrow("invalid response");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("verifies and atomically reuses the last-known-good policy while offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-policy-test-"));
    try {
      const signed = signedPolicy();
      const cachePath = join(directory, "policy.jws");
      const online = new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "",
        fetch: vi.fn().mockResolvedValue(
          new Response(signed.jws, {
            headers: { "content-type": "application/jose" },
          }),
        ),
        trustedRegistryKeys: [signed.trustKey],
        policyCachePath: cachePath,
      });
      await expect(online.getSecurityPolicy()).resolves.toMatchObject({ revocations: [] });

      const offline = new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "",
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
        trustedRegistryKeys: [signed.trustKey],
        policyCachePath: cachePath,
      });
      await expect(offline.getSecurityPolicy()).resolves.toMatchObject({
        keyId: signed.trustKey.kid,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries install receipts only for the account that performed the install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-receipt-test-"));
    try {
      const queuePath = join(directory, "receipts.json");
      const failed = new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "cookie=value",
        getAccountId: async () => "account-a",
        fetch: vi.fn().mockResolvedValue(jsonResponse({ message: "offline" }, 503)),
        receiptQueuePath: queuePath,
      });
      await expect(
        failed.recordSuccessfulInstallDurably({
          appId: summary.id,
          versionId: "00000000-0000-4000-8000-000000000303",
        }),
      ).resolves.toBeUndefined();

      const otherFetch = vi.fn();
      await new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "cookie=value",
        getAccountId: async () => "account-b",
        fetch: otherFetch,
        receiptQueuePath: queuePath,
      }).reconcileInstallReceipts();
      expect(otherFetch).not.toHaveBeenCalled();

      const retryFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          appId: summary.id,
          firstInstalledVersionId: "00000000-0000-4000-8000-000000000303",
          installedAt: "2026-08-02T00:00:00.000Z",
        }),
      );
      const retry = new AppRegistryClient({
        apiUrl: "https://api.penkra.com",
        getCookie: () => "cookie=value",
        getAccountId: async () => "account-a",
        fetch: retryFetch,
        receiptQueuePath: queuePath,
      });
      await retry.reconcileInstallReceipts();
      await retry.reconcileInstallReceipts();
      expect(retryFetch).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function registryDetail(packageDigest: string) {
  return {
    ...summary,
    screenshots: [],
    versions: [
      {
        id: "00000000-0000-4000-8000-000000000303",
        version: "1.0.0",
        packageDigest,
        compatibilityRange: ">=0.8.0 <2.0.0",
        publishedAt: "2026-08-01T00:00:00.000Z",
        readmeArtifactId: "00000000-0000-4000-8000-000000000304",
        instructionsArtifactId: "00000000-0000-4000-8000-000000000305",
        publisherSignatureArtifactId: "00000000-0000-4000-8000-000000000306",
        registrySignatureArtifactId: "00000000-0000-4000-8000-000000000307",
        validationReportArtifactId: "00000000-0000-4000-8000-000000000308",
        permissions: [],
      },
    ],
  };
}

function signedAttestation(
  app: ReturnType<typeof registryDetail>,
  version: ReturnType<typeof registryDetail>["versions"][number],
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const kid = createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
  const protectedValue = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid, typ: "penkra-release+jws" }),
  ).toString("base64url");
  const payloadValue = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: "penkra-app-release",
      registry: "penkra.com",
      app: { id: app.id, identifier: app.identifier, slug: app.slug },
      publisher: {
        id: "publisher",
        slug: app.publisher.slug,
        signerIdentity: "developer@penkra.com",
        signerIssuer: "https://accounts.google.com",
      },
      version: {
        id: version.id,
        version: version.version,
        compatibilityRange: version.compatibilityRange,
        packageDigest: version.packageDigest,
        manifestDigest: "b".repeat(64),
        readmeDigest: "c".repeat(64),
        instructionsDigest: "d".repeat(64),
      },
      evidence: {
        publisherSignatureDigest: "e".repeat(64),
        validationReportDigest: "f".repeat(64),
      },
      permissions: version.permissions,
      publishedAt: version.publishedAt,
    }),
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${protectedValue}.${payloadValue}`),
    privateKey,
  ).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jws: `${protectedValue}.${payloadValue}.${signature}`,
    trustKey: {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: jwk.x!,
      kid,
      alg: "EdDSA" as const,
      use: "sig" as const,
    },
  };
}

function signedPolicy() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const kid = createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
  const protectedValue = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid, typ: "penkra-policy+jws" }),
  ).toString("base64url");
  const generatedAt = new Date();
  const payloadValue = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: "penkra-app-policy",
      registry: "penkra.com",
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      revocations: [],
    }),
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${protectedValue}.${payloadValue}`),
    privateKey,
  ).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jws: `${protectedValue}.${payloadValue}.${signature}`,
    trustKey: {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: jwk.x!,
      kid,
      alg: "EdDSA" as const,
      use: "sig" as const,
    },
  };
}
