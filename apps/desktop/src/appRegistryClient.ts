// FILE: appRegistryClient.ts
// Purpose: Fetches typed registry facts with the encrypted desktop account session.
// Layer: Trusted Electron main process

import type {
  DesktopAppRegistryBridge,
  DesktopRegistryAccountFeedback,
  DesktopRegistryAppDetail,
  DesktopRegistryAppSummary,
} from "@penkra/contracts";
import { PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES } from "@penkra/shared/appPackageLimits";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  verifyRegistryPolicyAttestation,
  verifyRegistryReleaseAttestation,
  type RegistryTrustKey,
  type VerifiedRegistryPolicy,
  type VerifiedRegistryRelease,
} from "./appRegistryTrust";
import {
  downloadRegistryPackage,
  type DownloadedRegistryPackage,
  type RegistryPackageDownloadDiagnostic,
} from "./appRegistryPackageDownload";

const APP_SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RegistryAppIdentifierOwnership =
  | { status: "unregistered" }
  | { status: "registered-to-another-account" }
  | { status: "owned"; appId: string; publisherId: string; slug: string }
  | {
      status: "member";
      appId: string;
      publisherId: string;
      slug: string;
      role: "developer" | "publisher";
    };

export interface RegistryAppSideloadIdentity {
  developmentIdentityId: string;
  identifier: string;
  slug: string;
  identityAudience: string | null;
  registryIdentity?: { appId: string; publisherId: string };
}

export class AppRegistryClient {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #getCookie: () => string;
  readonly #getAccountId: () => Promise<string | null>;
  readonly #trustedRegistryKeys: ReadonlyArray<RegistryTrustKey>;
  readonly #policyCachePath: string | undefined;
  readonly #receiptQueuePath: string | undefined;
  #memoryPolicy: { value: VerifiedRegistryPolicy; loadedAt: number } | undefined;
  #receiptQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    apiUrl: string;
    getCookie: () => string;
    getAccountId?: () => Promise<string | null>;
    fetch?: typeof fetch;
    trustedRegistryKeys?: ReadonlyArray<RegistryTrustKey>;
    policyCachePath?: string;
    receiptQueuePath?: string;
  }) {
    this.#apiUrl = input.apiUrl.replace(/\/$/, "");
    this.#getCookie = input.getCookie;
    this.#getAccountId = input.getAccountId ?? (async () => null);
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#trustedRegistryKeys = input.trustedRegistryKeys ?? [];
    this.#policyCachePath = input.policyCachePath;
    this.#receiptQueuePath = input.receiptQueuePath;
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
    return parseDetail(await this.#request(`/api/registry/apps/${encodeURIComponent(input.slug)}`));
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
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    integerField(value, "expiresInSeconds", 1);
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The registry object returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    const maximumBytes = input.source === "artifact" ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error("The registry object exceeds the allowed size.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes)
      throw new Error("The registry object exceeds the allowed size.");
    if (input.source === "artifact") {
      if (mediaType !== "text/markdown" && mediaType !== "text/plain") {
        throw new Error("The registry help document has an unsupported content type.");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("The registry help document is not valid UTF-8.");
      }
      return { kind: "text", contentType: mediaType, text };
    }
    if (!["image/png", "image/jpeg", "image/svg+xml", "image/webp"].includes(mediaType)) {
      throw new Error("The registry image has an unsupported content type.");
    }
    return {
      kind: "image",
      contentType: mediaType,
      dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  }

  async downloadVerifiedRelease(input: {
    app: DesktopRegistryAppDetail;
    version: DesktopRegistryAppDetail["versions"][number];
  }): Promise<{ package: DownloadedRegistryPackage; release: VerifiedRegistryRelease }> {
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
      packageSize > PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES
    ) {
      throw invalidResponse();
    }
    integerField(packageValue, "expiresInSeconds", 1);
    const packageDownload = await downloadRegistryPackage({
      fetch: this.#fetch,
      url: packageUrl,
      appSlug: input.app.slug,
      version: input.version.version,
      expectedBytes: packageSize,
      maximumBytes: PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES,
      onDiagnostic: logRegistryPackageDownload,
    });
    try {
      if (packageDownload.sha256 !== packageDigest) {
        throw new Error("Downloaded App package digest does not match the registry.");
      }
      const [attestation, trustedKeys] = await Promise.all([
        this.#downloadArtifactBytes(
          input.version.registrySignatureArtifactId,
          "application/jose",
          512 * 1024,
        ),
        this.#registryTrustKeys(),
      ]);
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
      return { package: packageDownload, release };
    } catch (error) {
      await packageDownload.dispose();
      throw error;
    }
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
      if (!response.ok)
        throw new Error(`The registry security policy returned HTTP ${response.status}.`);
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
    if (!UUID.test(input.appId) || !UUID.test(input.versionId))
      throw new Error("Invalid registry release identity.");
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

  async getFeedback(input: { appId: string }): ReturnType<DesktopAppRegistryBridge["getFeedback"]> {
    assertUuid(input.appId, "App");
    return parseAccountFeedback(
      await this.#request(`/api/registry/apps/${encodeURIComponent(input.appId)}/feedback`),
    );
  }

  async setRating(input: {
    appId: string;
    rating: number;
  }): ReturnType<DesktopAppRegistryBridge["setRating"]> {
    assertUuid(input.appId, "App");
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new Error("App rating must be an integer between 1 and 5.");
    }
    return parseRating(
      await this.#request(`/api/registry/apps/${encodeURIComponent(input.appId)}/rating`, {
        method: "PUT",
        body: JSON.stringify({ rating: input.rating }),
      }),
      input.appId,
    );
  }

  async setReview(input: {
    appId: string;
    body: string;
  }): ReturnType<DesktopAppRegistryBridge["setReview"]> {
    assertUuid(input.appId, "App");
    const body = input.body.trim();
    if (!body || body.length > 10_000)
      throw new Error("App review must be between 1 and 10000 characters.");
    return parseReview(
      await this.#request(`/api/registry/apps/${encodeURIComponent(input.appId)}/review`, {
        method: "PUT",
        body: JSON.stringify({ body }),
      }),
      input.appId,
    );
  }

  async developerCreatePublisher(input: {
    slug: string;
    displayName: string;
    domain?: string;
  }): Promise<unknown> {
    return this.#request("/api/registry/publishers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async developerListPublishers(): Promise<unknown[]> {
    return this.#collectPages("/api/registry/publishers");
  }

  async developerCreateApp(input: {
    publisherId: string;
    identifier: string;
    slug: string;
    displayName: string;
    summary: string;
    visibility: "public" | "private";
  }): Promise<unknown> {
    assertUuid(input.publisherId, "publisher");
    return this.#request("/api/registry/apps", { method: "POST", body: JSON.stringify(input) });
  }

  async developerListApps(publisherId: string): Promise<unknown[]> {
    assertUuid(publisherId, "publisher");
    return this.#collectPages(`/api/registry/publishers/${encodeURIComponent(publisherId)}/apps`);
  }

  async developerGetAppIdentifierOwnership(
    identifier: string,
  ): Promise<RegistryAppIdentifierOwnership> {
    const normalized = identifier.trim().toLowerCase();
    if (!/^[a-z][a-z0-9.-]{2,254}$/.test(normalized)) {
      throw new Error("Invalid App identifier.");
    }
    const query = new URLSearchParams({ identifier: normalized });
    const value = await this.#request(`/api/registry/developer/apps/identifier-ownership?${query}`);
    if (!isRecord(value)) throw invalidResponse();
    if (value.status === "unregistered") return { status: "unregistered" };
    if (value.status === "registered-to-another-account") {
      return { status: "registered-to-another-account" };
    }
    if (value.status !== "owned" && value.status !== "member") throw invalidResponse();
    const slug = stringField(value, "slug");
    if (!APP_SLUG.test(slug)) throw invalidResponse();
    const identity = {
      appId: uuidField(value, "appId"),
      publisherId: uuidField(value, "publisherId"),
      slug,
    };
    if (value.status === "owned") return { status: "owned", ...identity };
    if (value.role !== "developer" && value.role !== "publisher") throw invalidResponse();
    return { status: "member", role: value.role, ...identity };
  }

  async developerClaimAppSideloadIdentity(input: {
    identifier: string;
    slug: string;
    identityAudience: string | null;
  }): Promise<RegistryAppSideloadIdentity> {
    const value = await this.#request("/api/registry/developer/apps/sideload-identity", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!isRecord(value)) throw invalidResponse();
    const developmentIdentityId = uuidField(value, "developmentIdentityId");
    const identifier = stringField(value, "identifier");
    const slug = stringField(value, "slug");
    const identityAudience = value.identityAudience;
    if (
      identifier !== input.identifier ||
      slug !== input.slug ||
      identityAudience !== input.identityAudience ||
      !APP_SLUG.test(slug)
    ) {
      throw invalidResponse();
    }
    if (identityAudience !== null && typeof identityAudience !== "string") {
      throw invalidResponse();
    }
    const registryIdentity = value.registryIdentity;
    return {
      developmentIdentityId,
      identifier,
      slug,
      identityAudience: identityAudience as string | null,
      ...(registryIdentity === undefined
        ? {}
        : isRecord(registryIdentity)
          ? {
              registryIdentity: {
                appId: uuidField(registryIdentity, "appId"),
                publisherId: uuidField(registryIdentity, "publisherId"),
              },
            }
          : (() => {
              throw invalidResponse();
            })()),
    };
  }

  async developerSetAppVisibility(input: {
    appId: string;
    visibility: "public" | "private";
  }): Promise<unknown> {
    assertUuid(input.appId, "App");
    return this.#request(`/api/registry/apps/${encodeURIComponent(input.appId)}/visibility`, {
      method: "PUT",
      body: JSON.stringify({ visibility: input.visibility }),
    });
  }

  async developerInviteAppUser(input: { appId: string; email: string }): Promise<unknown> {
    assertUuid(input.appId, "App");
    return this.#request(`/api/registry/apps/${encodeURIComponent(input.appId)}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email: input.email }),
    });
  }

  async developerListAppInvitations(appId: string): Promise<unknown[]> {
    assertUuid(appId, "App");
    return this.#collectPages(`/api/registry/apps/${encodeURIComponent(appId)}/invitations`);
  }

  async developerRevokeAppInvitation(input: {
    appId: string;
    invitationId: string;
  }): Promise<unknown> {
    assertUuid(input.appId, "App");
    assertUuid(input.invitationId, "invitation");
    return this.#request(
      `/api/registry/apps/${encodeURIComponent(input.appId)}/invitations/${encodeURIComponent(input.invitationId)}`,
      { method: "DELETE" },
    );
  }

  async developerInviteAppMember(input: {
    appId: string;
    email: string;
    role: "developer" | "publisher";
  }): Promise<unknown> {
    assertAppReference(input.appId);
    return this.#request(
      `/api/registry/developer/apps/${encodeURIComponent(input.appId)}/members`,
      { method: "POST", body: JSON.stringify({ email: input.email, role: input.role }) },
    );
  }

  async developerListAppMembers(appId: string): Promise<unknown[]> {
    assertAppReference(appId);
    return this.#collectPages(`/api/registry/developer/apps/${encodeURIComponent(appId)}/members`);
  }

  async developerUpdateAppMemberRole(input: {
    appId: string;
    memberId: string;
    role: "developer" | "publisher";
  }): Promise<unknown> {
    assertAppReference(input.appId);
    assertUuid(input.memberId, "member");
    return this.#request(
      `/api/registry/developer/apps/${encodeURIComponent(input.appId)}/members/${encodeURIComponent(input.memberId)}`,
      { method: "PATCH", body: JSON.stringify({ role: input.role }) },
    );
  }

  async developerRevokeAppMember(input: { appId: string; memberId: string }): Promise<unknown> {
    assertAppReference(input.appId);
    assertUuid(input.memberId, "member");
    return this.#request(
      `/api/registry/developer/apps/${encodeURIComponent(input.appId)}/members/${encodeURIComponent(input.memberId)}`,
      { method: "DELETE" },
    );
  }

  async developerListSubmissions(appId: string): Promise<unknown[]> {
    assertUuid(appId, "App");
    return this.#collectPages(`/api/registry/apps/${encodeURIComponent(appId)}/submissions`);
  }

  async developerSubmissionStatus(submissionId: string): Promise<unknown> {
    assertUuid(submissionId, "submission");
    return this.#request(`/api/registry/submissions/${encodeURIComponent(submissionId)}`);
  }

  async developerRetrySubmissionValidation(submissionId: string): Promise<unknown> {
    assertUuid(submissionId, "submission");
    return this.#request(
      `/api/registry/submissions/${encodeURIComponent(submissionId)}/retry-validation`,
      { method: "POST" },
    );
  }

  async developerRetrySubmissionPublication(submissionId: string): Promise<unknown> {
    assertUuid(submissionId, "submission");
    return this.#request(
      `/api/registry/submissions/${encodeURIComponent(submissionId)}/retry-publication`,
      { method: "POST" },
    );
  }

  async developerSubmit(input: {
    appId: string;
    packagePath: string;
    evidence: {
      version: string;
      compatibilityRange: string;
      manifestDigest: string;
      packageDigest: string;
      readmeDigest: string;
      instructionsDigest: string;
      packageSizeBytes: number;
      permissions: ReadonlyArray<{
        permission: string;
        required: boolean;
        rationale: string;
        audience?: string;
      }>;
    };
  }): Promise<unknown> {
    assertUuid(input.appId, "App");
    const packageSizeBytes = await this.#verifyDeveloperArtifact(input);
    const created = await this.#request(
      `/api/registry/apps/${encodeURIComponent(input.appId)}/submissions`,
      {
        method: "POST",
        body: JSON.stringify({
          version: input.evidence.version,
          manifestDigest: input.evidence.manifestDigest,
          packageDigest: input.evidence.packageDigest,
          readmeDigest: input.evidence.readmeDigest,
          instructionsDigest: input.evidence.instructionsDigest,
          compatibilityRange: input.evidence.compatibilityRange,
          packageSizeBytes,
          permissions: input.evidence.permissions,
        }),
      },
    );
    const response = parseSubmissionUpload(created);
    await this.#uploadDeveloperArtifact(
      response.uploads.package,
      input.packagePath,
      packageSizeBytes,
    );
    return this.#request(
      `/api/registry/submissions/${encodeURIComponent(response.submissionId)}/finalize`,
      {
        method: "POST",
      },
    );
  }

  async developerResumeSubmissionUpload(input: {
    submissionId: string;
    packagePath: string;
    evidence: { packageDigest: string; packageSizeBytes: number };
  }): Promise<unknown> {
    assertUuid(input.submissionId, "submission");
    const packageSizeBytes = await this.#verifyDeveloperArtifact(input);
    const refreshed = parseSubmissionUpload(
      await this.#request(
        `/api/registry/submissions/${encodeURIComponent(input.submissionId)}/upload`,
        { method: "POST" },
      ),
    );
    if (refreshed.submissionId !== input.submissionId) throw invalidResponse();
    await this.#uploadDeveloperArtifact(
      refreshed.uploads.package,
      input.packagePath,
      packageSizeBytes,
    );
    return this.#request(
      `/api/registry/submissions/${encodeURIComponent(input.submissionId)}/finalize`,
      { method: "POST" },
    );
  }

  async recordSuccessfulInstallDurably(input: { appId: string; versionId: string }): Promise<void> {
    const accountId = await this.#getAccountId();
    if (!accountId) {
      console.warn(
        "[penkra-app] Installed App receipt was not queued because the account identity is unavailable.",
      );
      return;
    }
    const entry = { accountId, appId: input.appId, versionId: input.versionId };
    try {
      await this.#mutateReceiptQueue((entries) => [
        ...entries.filter(
          (candidate) => candidate.accountId !== accountId || candidate.appId !== input.appId,
        ),
        entry,
      ]);
    } catch (error) {
      console.warn("[penkra-app] Installed App receipt could not be queued.", error);
    }
    try {
      await this.recordSuccessfulInstall(input);
      await this.#mutateReceiptQueue((entries) =>
        entries.filter(
          (candidate) => candidate.accountId !== accountId || candidate.appId !== input.appId,
        ),
      );
    } catch (error) {
      console.warn("[penkra-app] Installed App receipt will be retried.", error);
    }
  }

  async reconcileInstallReceipts(): Promise<void> {
    const accountId = await this.#getAccountId();
    if (!accountId || !this.#receiptQueuePath) return;
    const pending = (await this.#readReceiptQueue()).filter(
      (entry) => entry.accountId === accountId,
    );
    for (const entry of pending) {
      try {
        await this.recordSuccessfulInstall({ appId: entry.appId, versionId: entry.versionId });
        await this.#mutateReceiptQueue((entries) =>
          entries.filter(
            (candidate) =>
              candidate.accountId !== entry.accountId || candidate.appId !== entry.appId,
          ),
        );
      } catch {
        return;
      }
    }
  }

  async #request(
    path: string,
    init: { method?: "DELETE" | "PATCH" | "POST" | "PUT"; body?: string } = {},
  ): Promise<unknown> {
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
      const message =
        isRecord(body) && typeof body.message === "string"
          ? body.message
          : `The App registry returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return body;
  }

  async #collectPages(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | null = null;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const value = await this.#request(
        `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pageInfo))
        throw invalidResponse();
      items.push(...value.items);
      const next = value.pageInfo.nextCursor;
      if (next !== null && (typeof next !== "string" || !UUID.test(next))) throw invalidResponse();
      cursor = next;
    } while (cursor !== null);
    return items;
  }

  async #uploadDeveloperArtifact(
    upload: { url: string; headers: Record<string, string> },
    path: string,
    sizeBytes: number,
  ): Promise<void> {
    this.#assertRegistryObjectUrl(upload.url);
    const body = createReadStream(path);
    try {
      const response = await this.#fetch(upload.url, {
        method: "PUT",
        // A Node ReadStream has no intrinsic HTTP length. Without this exact header,
        // fetch uses chunked transfer encoding, which S3 presigned PUTs reject.
        headers: { ...upload.headers, "content-length": String(sizeBytes) },
        body: body as unknown as BodyInit,
        duplex: "half",
        signal: AbortSignal.timeout(60_000),
      } as RequestInit & { duplex: "half" });
      if (!response.ok) throw new Error(`Registry upload returned HTTP ${response.status}.`);
    } finally {
      body.destroy();
    }
  }

  async #verifyDeveloperArtifact(input: {
    packagePath: string;
    evidence: { packageDigest: string; packageSizeBytes: number };
  }): Promise<number> {
    const packageStat = await stat(input.packagePath);
    if (
      !packageStat.isFile() ||
      packageStat.size !== input.evidence.packageSizeBytes ||
      packageStat.size > PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES ||
      (await digestFile(input.packagePath)) !== input.evidence.packageDigest
    ) {
      throw new Error("The App package changed after preflight.");
    }
    return packageStat.size;
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

  async #downloadArtifactBytes(
    id: string,
    contentType: string,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    const value = await this.#request(`/api/registry/artifacts/${encodeURIComponent(id)}`);
    if (!isRecord(value) || stringField(value, "contentType") !== contentType)
      throw invalidResponse();
    integerField(value, "expiresInSeconds", 1);
    const url = stringField(value, "url");
    this.#assertRegistryObjectUrl(url);
    return this.#downloadBytes(url, undefined, maximumBytes);
  }

  async #downloadBytes(
    url: string,
    exactBytes: number | undefined,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The registry object returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error("The registry object exceeds the allowed size.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength > maximumBytes ||
      (exactBytes !== undefined && bytes.byteLength !== exactBytes)
    ) {
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
    const value = (await response.json()) as unknown;
    if (!isRecord(value) || !Array.isArray(value.keys)) throw invalidResponse();
    return value.keys.map(parseRegistryTrustKey);
  }

  async #writePolicyCache(compactJws: string): Promise<void> {
    if (!this.#policyCachePath) return;
    const temporaryPath = temporaryWritePath(this.#policyCachePath);
    try {
      await mkdir(dirname(this.#policyCachePath), { recursive: true });
      await writeFile(temporaryPath, compactJws, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#policyCachePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      console.warn("[penkra-app] Registry policy cache could not be updated.", error);
    }
  }

  #mutateReceiptQueue(
    transition: (entries: InstallReceiptQueueEntry[]) => InstallReceiptQueueEntry[],
  ): Promise<void> {
    const operation = this.#receiptQueue.then(async () => {
      if (!this.#receiptQueuePath) return;
      const entries = transition(await this.#readReceiptQueue());
      await writeAtomic(this.#receiptQueuePath, JSON.stringify({ schemaVersion: 1, entries }));
    });
    this.#receiptQueue = operation.catch(() => undefined);
    return operation;
  }

  async #readReceiptQueue(): Promise<InstallReceiptQueueEntry[]> {
    if (!this.#receiptQueuePath) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#receiptQueuePath, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("The App install receipt queue is invalid.");
    }
    return parsed.entries.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("The App install receipt queue is invalid.");
      const accountId = stringField(candidate, "accountId");
      const appId = uuidField(candidate, "appId");
      const versionId = uuidField(candidate, "versionId");
      return { accountId, appId, versionId };
    });
  }
}

type InstallReceiptQueueEntry = { accountId: string; appId: string; versionId: string };

function logRegistryPackageDownload(diagnostic: RegistryPackageDownloadDiagnostic): void {
  const method = diagnostic.event === "failed" ? console.warn : console.info;
  method("[penkra-app-install] Registry package download", diagnostic);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = temporaryWritePath(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function temporaryWritePath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("The registry security policy exceeds the allowed size.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes)
    throw new Error("The registry security policy exceeds the allowed size.");
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
        registrySignatureArtifactId: uuidField(version, "registrySignatureArtifactId"),
        validationReportArtifactId: uuidField(version, "validationReportArtifactId"),
        permissions: version.permissions.map((permission) => {
          if (!isRecord(permission)) throw invalidResponse();
          return {
            permission: stringField(permission, "permission"),
            required: booleanField(permission, "required"),
            rationale: stringField(permission, "rationale"),
            ...(permission.audience === undefined
              ? {}
              : { audience: stringField(permission, "audience") }),
          };
        }),
      };
    }),
  };
}

function parseSummary(value: unknown): DesktopRegistryAppSummary {
  if (!isRecord(value) || !isRecord(value.publisher)) throw invalidResponse();
  const visibility = value.visibility;
  if (visibility !== "public" && visibility !== "private") throw invalidResponse();
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
    visibility,
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

function parseAccountFeedback(value: unknown): DesktopRegistryAccountFeedback {
  if (!isRecord(value) || value.eligible !== true) throw invalidResponse();
  const rating = value.rating;
  if (
    rating !== null &&
    (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5)
  ) {
    throw invalidResponse();
  }
  const review = value.review;
  let parsedReview: DesktopRegistryAccountFeedback["review"] = null;
  if (review !== null) {
    if (!isRecord(review)) throw invalidResponse();
    const status = stringField(review, "status");
    if (!["pending", "published", "rejected", "removed"].includes(status)) throw invalidResponse();
    parsedReview = {
      body: stringField(review, "body"),
      status: status as NonNullable<DesktopRegistryAccountFeedback["review"]>["status"],
      updatedAt: isoDateField(review, "updatedAt"),
    };
  }
  return {
    appId: uuidField(value, "appId"),
    eligible: true,
    installedAt: isoDateField(value, "installedAt"),
    rating: rating as number | null,
    review: parsedReview,
  };
}

function parseRating(
  value: unknown,
  expectedAppId: string,
): {
  appId: string;
  rating: number;
  updatedAt: string;
} {
  if (!isRecord(value)) throw invalidResponse();
  const appId = uuidField(value, "appId");
  const rating = integerField(value, "rating", 1);
  if (appId !== expectedAppId || rating > 5) throw invalidResponse();
  return { appId, rating, updatedAt: isoDateField(value, "updatedAt") };
}

function parseReview(
  value: unknown,
  expectedAppId: string,
): {
  appId: string;
  body: string;
  status: "pending";
  updatedAt: string;
} {
  if (!isRecord(value)) throw invalidResponse();
  const appId = uuidField(value, "appId");
  if (appId !== expectedAppId || value.status !== "pending") throw invalidResponse();
  return {
    appId,
    body: stringField(value, "body"),
    status: "pending",
    updatedAt: isoDateField(value, "updatedAt"),
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

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`Invalid registry ${label} id.`);
}

function assertAppReference(value: string): void {
  if (!UUID.test(value) && !/^[a-z][a-z0-9.-]{2,254}$/.test(value)) {
    throw new Error("Invalid App ID.");
  }
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

async function digestFile(path: string): Promise<string> {
  const value = createHash("sha256");
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest("hex");
}

function parseSubmissionUpload(value: unknown): {
  submissionId: string;
  uploads: {
    package: { url: string; headers: Record<string, string> };
  };
} {
  if (!isRecord(value) || !isRecord(value.uploads)) throw invalidResponse();
  const parseUpload = (candidate: unknown) => {
    if (!isRecord(candidate) || !isRecord(candidate.headers)) throw invalidResponse();
    const headers: Record<string, string> = {};
    for (const [key, header] of Object.entries(candidate.headers)) {
      if (typeof header !== "string") throw invalidResponse();
      headers[key] = header;
    }
    return { url: stringField(candidate, "url"), headers };
  };
  return {
    submissionId: uuidField(value, "submissionId"),
    uploads: {
      package: parseUpload(value.uploads.package),
    },
  };
}
