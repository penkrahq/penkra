// FILE: appRegistryClient.ts
// Purpose: Fetches typed registry facts with the encrypted desktop account session.
// Layer: Trusted Electron main process

import type {
  DesktopAppRegistryBridge,
  DesktopRegistryAppDetail,
  DesktopRegistryAppSummary,
} from "@penkra/contracts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  verifyRegistryPolicyAttestation,
  verifyRegistryReleaseAttestation,
  type RegistryTrustKey,
  type VerifiedRegistryPolicy,
  type VerifiedRegistryRelease,
} from "./appRegistryTrust";

const APP_SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AppRegistryClient {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #getCookie: () => string;
  readonly #trustedRegistryKeys: ReadonlyArray<RegistryTrustKey>;
  readonly #policyCachePath: string | undefined;
  #memoryPolicy: { value: VerifiedRegistryPolicy; loadedAt: number } | undefined;

  constructor(input: {
    apiUrl: string;
    getCookie: () => string;
    fetch?: typeof fetch;
    trustedRegistryKeys?: ReadonlyArray<RegistryTrustKey>;
    policyCachePath?: string;
  }) {
    this.#apiUrl = input.apiUrl.replace(/\/$/, "");
    this.#getCookie = input.getCookie;
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#trustedRegistryKeys = input.trustedRegistryKeys ?? [];
    this.#policyCachePath = input.policyCachePath;
  }

  async list(
    input: Parameters<DesktopAppRegistryBridge["list"]>[0] = {},
  ): ReturnType<DesktopAppRegistryBridge["list"]> {
    const query = new URLSearchParams();
    if (input.query !== undefined) {
      const value = input.query.trim();
      if (value.length > 200) throw new Error("Registry search is too long.");
      if (value) query.set("query", value);
    }
    if (input.cursor !== undefined) {
      if (!UUID.test(input.cursor)) throw new Error("Invalid registry cursor.");
      query.set("cursor", input.cursor);
    }
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new Error("Registry page size must be between 1 and 100.");
      }
      query.set("limit", String(input.limit));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return parseCatalog(await this.#request(`/api/registry/apps${suffix}`));
  }

  async get(input: { slug: string }): ReturnType<DesktopAppRegistryBridge["get"]> {
    if (!APP_SLUG.test(input.slug)) throw new Error("Invalid App slug.");
    return parseDetail(
      await this.#request(`/api/registry/apps/${encodeURIComponent(input.slug)}`),
    );
  }

  async getArtifact(input: {
    id: string;
    source: "artifact" | "asset";
  }): ReturnType<DesktopAppRegistryBridge["getArtifact"]> {
    if (!UUID.test(input.id)) throw new Error("Invalid registry object id.");
    if (input.source !== "artifact" && input.source !== "asset") {
      throw new Error("Invalid registry object source.");
    }
    const value = await this.#request(
      `/api/registry/${input.source}s/${encodeURIComponent(input.id)}`,
    );
    if (!isRecord(value)) throw invalidResponse();
    const url = stringField(value, "url");
    this.#assertRegistryObjectUrl(url);
    const contentType = stringField(value, "contentType");
    integerField(value, "expiresInSeconds", 1);
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The registry object returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    const maximumBytes = input.source === "artifact" ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error("The registry object exceeds the allowed size.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error("The registry object exceeds the allowed size.");
    if (input.source === "artifact") {
      if (contentType !== "text/markdown" && contentType !== "text/plain") {
        throw new Error("The registry help document has an unsupported content type.");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("The registry help document is not valid UTF-8.");
      }
      return { kind: "text", contentType, text };
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      throw new Error("The registry image has an unsupported content type.");
    }
    return {
      kind: "image",
      contentType,
      dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  }

  async downloadVerifiedRelease(input: {
    app: DesktopRegistryAppDetail;
    version: DesktopRegistryAppDetail["versions"][number];
  }): Promise<{ packageBytes: Uint8Array; release: VerifiedRegistryRelease }> {
    if (input.app.slug.length === 0 || input.version.version.length === 0) throw invalidResponse();
    const packageValue = await this.#request(
      `/api/registry/apps/${encodeURIComponent(input.app.slug)}/versions/${encodeURIComponent(input.version.version)}/package`,
    );
    if (!isRecord(packageValue)) throw invalidResponse();
    const packageUrl = stringField(packageValue, "url");
    this.#assertRegistryObjectUrl(packageUrl);
    const packageDigest = digestField(packageValue, "sha256");
    const packageSize = integerField(packageValue, "sizeBytes", 1);
    if (
      uuidField(packageValue, "appId") !== input.app.id ||
      uuidField(packageValue, "versionId") !== input.version.id ||
      stringField(packageValue, "version") !== input.version.version ||
      packageDigest !== input.version.packageDigest ||
      packageSize > 64 * 1024 * 1024
    ) {
      throw invalidResponse();
    }
    integerField(packageValue, "expiresInSeconds", 1);
    const [packageBytes, attestation, trustedKeys] = await Promise.all([
      this.#downloadBytes(packageUrl, packageSize, 64 * 1024 * 1024),
      this.#downloadArtifactBytes(input.version.registrySignatureArtifactId, "application/jose", 512 * 1024),
      this.#registryTrustKeys(),
    ]);
    if (createHash("sha256").update(packageBytes).digest("hex") !== packageDigest) {
      throw new Error("Downloaded App package digest does not match the registry.");
    }
    const release = verifyRegistryReleaseAttestation({
      compactJws: new TextDecoder("utf-8", { fatal: true }).decode(attestation),
      trustedKeys,
      expected: {
        appId: input.app.id,
        identifier: input.app.identifier,
        slug: input.app.slug,
        versionId: input.version.id,
        version: input.version.version,
        compatibilityRange: input.version.compatibilityRange,
        packageDigest: input.version.packageDigest,
        publishedAt: input.version.publishedAt,
        publisherSlug: input.app.publisher.slug,
        permissions: input.version.permissions,
      },
    });
    return { packageBytes, release };
  }

  async getSecurityPolicy(): Promise<VerifiedRegistryPolicy> {
    if (this.#memoryPolicy && Date.now() - this.#memoryPolicy.loadedAt < 5 * 60_000) {
      return this.#memoryPolicy.value;
    }
    const trustedKeys = await this.#registryTrustKeys();
    try {
      const response = await this.#fetch(`${this.#apiUrl}/.well-known/penkra-app-policy.jws`, {
        headers: { accept: "application/jose" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`The registry security policy returned HTTP ${response.status}.`);
      const compactJws = await boundedText(response, 2 * 1024 * 1024);
      const policy = verifyRegistryPolicyAttestation({ compactJws, trustedKeys });
      await this.#writePolicyCache(compactJws);
      this.#memoryPolicy = { value: policy, loadedAt: Date.now() };
      return policy;
    } catch (networkError) {
      if (!this.#policyCachePath) throw networkError;
      try {
        const compactJws = await readFile(this.#policyCachePath, "utf8");
        const policy = verifyRegistryPolicyAttestation({ compactJws, trustedKeys });
        this.#memoryPolicy = { value: policy, loadedAt: Date.now() };
        return policy;
      } catch {
        throw networkError;
      }
    }
  }

  async recordSuccessfulInstall(input: { appId: string; versionId: string }): Promise<void> {
    if (!UUID.test(input.appId) || !UUID.test(input.versionId)) throw new Error("Invalid registry release identity.");
    const value = await this.#request(
      `/api/registry/apps/${encodeURIComponent(input.appId)}/install-receipts`,
      { method: "POST", body: JSON.stringify({ versionId: input.versionId }) },
    );
    if (
      !isRecord(value) ||
      uuidField(value, "appId") !== input.appId ||
      !UUID.test(stringField(value, "firstInstalledVersionId")) ||
      !Number.isFinite(Date.parse(stringField(value, "installedAt")))
    ) {
      throw invalidResponse();
    }
  }

  async #request(path: string, init: { method?: "POST"; body?: string } = {}): Promise<unknown> {
    const cookie = this.#getCookie().trim();
    if (!cookie) throw new Error("Sign in to use the Penkra App registry.");
    const response = await this.#fetch(`${this.#apiUrl}${path}`, {
      headers: {
        accept: "application/json",
        cookie,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : await response.text();
    if (!response.ok) {
      const message = isRecord(body) && typeof body.message === "string"
        ? body.message
        : `The App registry returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return body;
  }

  #assertRegistryObjectUrl(value: string): void {
    const url = new URL(value);
    if (url.username || url.password || url.protocol === "file:") throw invalidResponse();
    if (url.protocol === "https:") return;
    const api = new URL(this.#apiUrl);
    const loopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";
    if (url.protocol !== "http:" || !loopback(api.hostname) || !loopback(url.hostname)) {
      throw invalidResponse();
    }
  }

  async #downloadArtifactBytes(id: string, contentType: string, maximumBytes: number): Promise<Uint8Array> {
    const value = await this.#request(`/api/registry/artifacts/${encodeURIComponent(id)}`);
    if (!isRecord(value) || stringField(value, "contentType") !== contentType) throw invalidResponse();
    integerField(value, "expiresInSeconds", 1);
    const url = stringField(value, "url");
    this.#assertRegistryObjectUrl(url);
    return this.#downloadBytes(url, undefined, maximumBytes);
  }

  async #downloadBytes(url: string, exactBytes: number | undefined, maximumBytes: number): Promise<Uint8Array> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The registry object returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error("The registry object exceeds the allowed size.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes || (exactBytes !== undefined && bytes.byteLength !== exactBytes)) {
      throw new Error("The registry object has an invalid size.");
    }
    return bytes;
  }

  async #registryTrustKeys(): Promise<ReadonlyArray<RegistryTrustKey>> {
    if (this.#trustedRegistryKeys.length > 0) return this.#trustedRegistryKeys;
    const api = new URL(this.#apiUrl);
    const loopback = api.hostname === "localhost" || api.hostname === "127.0.0.1";
    if (!loopback) throw new Error("No trusted Penkra registry signing key is configured.");
    const response = await this.#fetch(`${this.#apiUrl}/.well-known/penkra-registry-keys.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("The local registry signing key is unavailable.");
    const value = await response.json() as unknown;
    if (!isRecord(value) || !Array.isArray(value.keys)) throw invalidResponse();
    return value.keys.map(parseRegistryTrustKey);
  }

  async #writePolicyCache(compactJws: string): Promise<void> {
    if (!this.#policyCachePath) return;
    const temporaryPath = `${this.#policyCachePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.#policyCachePath), { recursive: true });
      await writeFile(temporaryPath, compactJws, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#policyCachePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      console.warn("[penkra-app] Registry policy cache could not be updated.", error);
    }
  }
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("The registry security policy exceeds the allowed size.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("The registry security policy exceeds the allowed size.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseCatalog(value: unknown): {
  items: DesktopRegistryAppSummary[];
  pageInfo: { nextCursor: string | null };
} {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pageInfo)) {
    throw invalidResponse();
  }
  const nextCursor = value.pageInfo.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !UUID.test(nextCursor))) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseSummary),
    pageInfo: { nextCursor },
  };
}

function parseDetail(value: unknown): DesktopRegistryAppDetail {
  if (!isRecord(value) || !Array.isArray(value.screenshots) || !Array.isArray(value.versions)) {
    throw invalidResponse();
  }
  return {
    ...parseSummary(value),
    screenshots: value.screenshots.map((screenshot) => {
      if (!isRecord(screenshot)) throw invalidResponse();
      return {
        id: uuidField(screenshot, "id"),
        position: integerField(screenshot, "position", 0),
        altText: stringField(screenshot, "altText"),
      };
    }),
    versions: value.versions.map((version) => {
      if (!isRecord(version) || !Array.isArray(version.permissions)) throw invalidResponse();
      return {
        id: uuidField(version, "id"),
        version: stringField(version, "version"),
        packageDigest: digestField(version, "packageDigest"),
        compatibilityRange: stringField(version, "compatibilityRange"),
        publishedAt: isoDateField(version, "publishedAt"),
        readmeArtifactId: uuidField(version, "readmeArtifactId"),
        instructionsArtifactId: uuidField(version, "instructionsArtifactId"),
        publisherSignatureArtifactId: uuidField(version, "publisherSignatureArtifactId"),
        registrySignatureArtifactId: uuidField(version, "registrySignatureArtifactId"),
        validationReportArtifactId: uuidField(version, "validationReportArtifactId"),
        permissions: version.permissions.map((permission) => {
          if (!isRecord(permission)) throw invalidResponse();
          return {
            permission: stringField(permission, "permission"),
            required: booleanField(permission, "required"),
            rationale: stringField(permission, "rationale"),
          };
        }),
      };
    }),
  };
}

function parseSummary(value: unknown): DesktopRegistryAppSummary {
  if (!isRecord(value) || !isRecord(value.publisher)) throw invalidResponse();
  const rating = value.rating;
  if (rating !== null && (typeof rating !== "number" || rating < 1 || rating > 5)) {
    throw invalidResponse();
  }
  const iconAssetId = value.iconAssetId;
  if (iconAssetId !== null && (typeof iconAssetId !== "string" || !UUID.test(iconAssetId))) {
    throw invalidResponse();
  }
  return {
    id: uuidField(value, "id"),
    identifier: stringField(value, "identifier"),
    slug: stringField(value, "slug"),
    displayName: stringField(value, "displayName"),
    summary: stringField(value, "summary"),
    publisher: {
      slug: stringField(value.publisher, "slug"),
      displayName: stringField(value.publisher, "displayName"),
      domain: nullableStringField(value.publisher, "domain"),
      verified: booleanField(value.publisher, "verified"),
    },
    latestVersion: stringField(value, "latestVersion"),
    iconAssetId,
    installCount: integerField(value, "installCount", 0),
    rating,
    ratingCount: integerField(value, "ratingCount", 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw invalidResponse();
  return field;
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field !== null && typeof field !== "string") throw invalidResponse();
  return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw invalidResponse();
  return field;
}

function integerField(value: Record<string, unknown>, key: string, minimum: number): number {
  const field = value[key];
  if (!Number.isInteger(field) || (field as number) < minimum) throw invalidResponse();
  return field as number;
}

function uuidField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!UUID.test(field)) throw invalidResponse();
  return field;
}

function digestField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!/^[a-f0-9]{64}$/.test(field)) throw invalidResponse();
  return field;
}

function parseRegistryTrustKey(value: unknown): RegistryTrustKey {
  if (!isRecord(value)) throw invalidResponse();
  const key: RegistryTrustKey = {
    kty: stringField(value, "kty") as "OKP",
    crv: stringField(value, "crv") as "Ed25519",
    x: stringField(value, "x"),
    kid: stringField(value, "kid"),
    alg: stringField(value, "alg") as "EdDSA",
    use: stringField(value, "use") as "sig",
  };
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "EdDSA" || key.use !== "sig") {
    throw invalidResponse();
  }
  return key;
}

function isoDateField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) throw invalidResponse();
  return field;
}

function invalidResponse(): Error {
  return new Error("The App registry returned an invalid response.");
}
