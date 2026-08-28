// FILE: appCommandPipeServer.ts
// Purpose: Exposes the trusted App operation broker to the registered command gateway.
// Layer: Desktop local capability bridge

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";

import type { DesktopAppTabDescriptor } from "@penkra/contracts";

import type { AppOperationBroker } from "./appOperationBroker";
import type { AppOperationCatalog } from "./appOperationCatalog";
import type { AppRegistryClient } from "./appRegistryClient";
import { resolveDesktopPlatformAdapter } from "./desktopPlatform";
import type { ProviderCredentialVault } from "./providerCredentialVault";

export const PENKRA_APP_COMMAND_PIPE_ENV = "PENKRA_APP_COMMAND_PIPE";
export const PENKRA_APP_COMMAND_TOKEN_ENV = "PENKRA_APP_COMMAND_TOKEN";
const MAX_REQUEST_BYTES = 1024 * 1024;

type Request = {
  id: string;
  token: string;
  method:
    | "catalog.list"
    | "catalog.help"
    | "skills.list"
    | "core.open"
    | "operations.invoke"
    | "tabs.current"
    | "tabs.list"
    | "tabs.snapshot"
    | "tabs.find"
    | "tabs.screenshot"
    | "tabs.click"
    | "tabs.hover"
    | "tabs.type"
    | "tabs.press"
    | "tabs.select"
    | "tabs.scroll"
    | "tabs.wait"
    | "tabs.handle-dialog"
    | "tabs.upload"
    | "developer.publishers.list"
    | "developer.publishers.create"
    | "developer.apps.list"
    | "developer.apps.create"
    | "developer.apps.visibility.set"
    | "developer.app-access.invite"
    | "developer.app-access.list"
    | "developer.app-access.revoke"
    | "developer.submissions.list"
    | "developer.submissions.get"
    | "developer.submissions.retry-validation"
    | "developer.submissions.retry-publication"
    | "developer.submissions.resume-upload"
    | "developer.submissions.create"
    | "developer.sideload"
    | "providers.credentials.store"
    | "providers.credentials.claim"
    | "providers.credentials.issue-lease"
    | "providers.credentials.consume-lease"
    | "providers.credentials.has"
    | "providers.credentials.remove"
    | "providers.credentials.fingerprint";
  params?: unknown;
};

interface AppTabObserverBridge {
  snapshot(
    tabId: string,
    options?: { target?: string; depth?: number; boxes?: boolean; outputPath?: string },
  ): Promise<unknown>;
  find(tabId: string, query: string): Promise<unknown>;
  screenshot(tabId: string, outputPath?: string): Promise<unknown>;
  click(tabId: string, reference: string, observe?: boolean): Promise<unknown>;
  hover(tabId: string, reference: string, observe?: boolean): Promise<unknown>;
  type(tabId: string, reference: string, text: string, observe?: boolean): Promise<unknown>;
  press(tabId: string, key: string, observe?: boolean): Promise<unknown>;
  select(tabId: string, reference: string, value: string, observe?: boolean): Promise<unknown>;
  scroll(tabId: string, deltaX: number, deltaY: number, observe?: boolean): Promise<unknown>;
  wait(tabId: string, text: string, timeoutMs: number): Promise<unknown>;
  handleDialog(tabId: string, accept: boolean, text?: string): Promise<unknown>;
  upload(tabId: string, reference: string, paths: ReadonlyArray<string>): Promise<unknown>;
}

export function resolveAppCommandPipePath(_userDataPath: string): string {
  if (resolveDesktopPlatformAdapter().paths.pathSyntax === "windows") {
    return `\\\\.\\pipe\\penkra-app-command-${process.pid}-${Crypto.randomUUID()}`;
  }
  if (!process.getuid) throw new Error("Unix App command sockets require a numeric user ID.");
  const directory = Path.join("/tmp", `penkra-${process.getuid()}`);
  return Path.join(directory, `app-${process.pid}-${Crypto.randomBytes(6).toString("hex")}.sock`);
}

export class AppCommandPipeServer {
  readonly #server: Net.Server;
  readonly #sockets = new Set<Net.Socket>();
  readonly #path: string;
  readonly #token: string;
  readonly #catalog: AppOperationCatalog;
  readonly #broker: AppOperationBroker;
  readonly #tabs: {
    list(): ReadonlyArray<DesktopAppTabDescriptor>;
    current(): DesktopAppTabDescriptor | null;
  };
  readonly #observer: AppTabObserverBridge;
  readonly #registry: AppRegistryClient | null;
  readonly #sideload:
    | ((input: { sourcePath: string; spaceId?: string }) => Promise<unknown>)
    | null;
  readonly #open:
    | ((input: {
        path?: string;
        url?: string;
        requestedApp?: string;
        spaceId: string;
        threadId: string;
      }) => Promise<unknown>)
    | null;
  readonly #providerCredentialVault: ProviderCredentialVault;
  #started = false;
  readonly #usesWindowsPipe = resolveDesktopPlatformAdapter().paths.pathSyntax === "windows";

  constructor(input: {
    path: string;
    token: string;
    catalog: AppOperationCatalog;
    broker: AppOperationBroker;
    tabs: {
      list(): ReadonlyArray<DesktopAppTabDescriptor>;
      current(): DesktopAppTabDescriptor | null;
    };
    observer: AppTabObserverBridge;
    registry?: AppRegistryClient | null;
    sideload?: (input: { sourcePath: string; spaceId?: string }) => Promise<unknown>;
    open?: (input: {
      path?: string;
      url?: string;
      requestedApp?: string;
      spaceId: string;
      threadId: string;
    }) => Promise<unknown>;
    providerCredentialVault: ProviderCredentialVault;
  }) {
    this.#path = input.path;
    this.#token = input.token;
    this.#catalog = input.catalog;
    this.#broker = input.broker;
    this.#tabs = input.tabs;
    this.#observer = input.observer;
    this.#registry = input.registry ?? null;
    this.#sideload = input.sideload ?? null;
    this.#open = input.open ?? null;
    this.#providerCredentialVault = input.providerCredentialVault;
    this.#server = Net.createServer((socket) => this.#accept(socket));
  }

  get environment(): NodeJS.ProcessEnv {
    return {
      [PENKRA_APP_COMMAND_PIPE_ENV]: this.#path,
      [PENKRA_APP_COMMAND_TOKEN_ENV]: this.#token,
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (!this.#usesWindowsPipe) {
      await FS.promises.mkdir(Path.dirname(this.#path), { recursive: true, mode: 0o700 });
      await FS.promises.chmod(Path.dirname(this.#path), 0o700);
      await FS.promises.rm(this.#path, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#path, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    if (!this.#usesWindowsPipe) await FS.promises.chmod(this.#path, 0o600);
    this.#started = true;
  }

  async dispose(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (this.#started) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      this.#started = false;
    }
    if (!this.#usesWindowsPipe) await FS.promises.rm(this.#path, { force: true });
  }

  #accept(socket: Net.Socket): void {
    this.#sockets.add(socket);
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      const raw = bytes.subarray(0, newline).toString("utf8");
      socket.pause();
      void this.#handle(raw)
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((error) => {
          const normalized = toError(error);
          const code =
            typeof (normalized as Error & { code?: unknown }).code === "string"
              ? (normalized as Error & { code: string }).code
              : "APP_COMMAND_FAILED";
          socket.end(
            `${JSON.stringify({ ok: false, error: { code, message: normalized.message } })}\n`,
          );
        });
    });
    const release = () => this.#sockets.delete(socket);
    socket.on("close", release);
    socket.on("error", release);
  }

  async #handle(raw: string): Promise<unknown> {
    const request = JSON.parse(raw) as Request;
    if (!request || typeof request !== "object" || typeof request.id !== "string") {
      throw new Error("Invalid App command request.");
    }
    const supplied = Buffer.from(typeof request.token === "string" ? request.token : "");
    const expected = Buffer.from(this.#token);
    if (supplied.length !== expected.length || !Crypto.timingSafeEqual(supplied, expected)) {
      throw new Error("Invalid App command capability.");
    }
    const params = asRecord(request.params);
    switch (request.method) {
      case "providers.credentials.store":
        return {
          ok: true,
          id: request.id,
          result: {
            reference: await this.#providerCredentialVault.store(
              requiredString(params.secret, "secret"),
              undefined,
              optionalString(params.reference, "reference") ?? undefined,
            ),
          },
        };
      case "providers.credentials.claim":
        return {
          ok: true,
          id: request.id,
          result: {
            reference: await this.#providerCredentialVault.claim(
              requiredString(params.secret, "secret"),
              requiredString(params.reference, "reference"),
            ),
          },
        };
      case "providers.credentials.issue-lease":
        return {
          ok: true,
          id: request.id,
          result: {
            capability: this.#providerCredentialVault.issueLease(
              requiredString(params.reference, "reference"),
            ),
          },
        };
      case "providers.credentials.consume-lease":
        return {
          ok: true,
          id: request.id,
          result: {
            secret: this.#providerCredentialVault.consumeLease(
              requiredString(params.capability, "capability"),
            ),
          },
        };
      case "providers.credentials.has":
        return {
          ok: true,
          id: request.id,
          result: {
            exists: this.#providerCredentialVault.has(
              requiredString(params.reference, "reference"),
            ),
          },
        };
      case "providers.credentials.fingerprint":
        return {
          ok: true,
          id: request.id,
          result: {
            fingerprint: this.#providerCredentialVault.fingerprint(
              requiredString(params.secret, "secret"),
            ),
          },
        };
      case "providers.credentials.remove":
        await this.#providerCredentialVault.remove(requiredString(params.reference, "reference"));
        return { ok: true, id: request.id, result: {} };
      case "tabs.list":
        return { ok: true, id: request.id, result: this.#scopedTabs(params) };
      case "tabs.current":
        return {
          ok: true,
          id: request.id,
          result: this.#scopedCurrentTab(params),
        };
      case "tabs.snapshot":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.snapshot(this.#tab(params).id, observationOptions(params)),
        };
      case "tabs.find":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.find(
            this.#tab(params).id,
            requiredString(params.query, "query"),
          ),
        };
      case "tabs.screenshot": {
        const tab = this.#scopedCurrentTab(params);
        if (!tab) {
          throw new Error(
            "The caller Thread does not currently own the visible App tab. Open or focus its App tab before taking a screenshot.",
          );
        }
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.screenshot(
            tab.id,
            optionalString(params.outputPath, "outputPath") ?? undefined,
          ),
        };
      }
      case "tabs.click":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.click(
            this.#tab(params).id,
            requiredString(params.target, "target"),
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.hover":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.hover(
            this.#tab(params).id,
            requiredString(params.target, "target"),
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.type":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.type(
            this.#tab(params).id,
            requiredString(params.target, "target"),
            requiredStringAllowEmpty(params.text, "text"),
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.press":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.press(
            this.#tab(params).id,
            requiredString(params.key, "key"),
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.select":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.select(
            this.#tab(params).id,
            requiredString(params.target, "target"),
            requiredStringAllowEmpty(params.value, "value"),
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.scroll":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.scroll(
            this.#tab(params).id,
            optionalNumber(params.deltaX, "deltaX") ?? 0,
            optionalNumber(params.deltaY, "deltaY") ?? 0,
            optionalBoolean(params.observe, "observe") ?? false,
          ),
        };
      case "tabs.handle-dialog":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.handleDialog(
            this.#tab(params).id,
            optionalBoolean(params.accept, "accept") ?? true,
            optionalString(params.text, "text") ?? undefined,
          ),
        };
      case "tabs.upload":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.upload(
            this.#tab(params).id,
            requiredString(params.target, "target"),
            requiredStringArray(params.paths, "paths"),
          ),
        };
      case "tabs.wait":
        return {
          ok: true,
          id: request.id,
          result: await this.#observer.wait(
            this.#tab(params).id,
            requiredString(params.text, "text"),
            optionalNumber(params.timeoutMs, "timeoutMs") ?? 10_000,
          ),
        };
      case "catalog.list": {
        const context = this.#context(params);
        return { ok: true, id: request.id, result: this.#catalog.list(context.spaceId) };
      }
      case "catalog.help": {
        const context = this.#context(params);
        const slug = requiredString(params.slug, "slug");
        const operation = optionalString(params.operation, "operation");
        return {
          ok: true,
          id: request.id,
          result: await this.#catalog.help({
            spaceId: context.spaceId,
            slug,
            ...(operation === null ? {} : { operation }),
          }),
        };
      }
      case "skills.list":
        return {
          ok: true,
          id: request.id,
          result: await this.#catalog.skills(requiredString(params.spaceId, "spaceId")),
        };
      case "core.open": {
        if (!this.#open) throw new Error("Penkra open is unavailable.");
        const context = this.#context(params);
        const path = optionalString(params.path, "path");
        const url = optionalString(params.url, "url");
        if ((path === null) === (url === null)) throw new Error("Supply exactly one path or URL.");
        const requestedApp = optionalString(params.requestedApp, "requestedApp");
        return {
          ok: true,
          id: request.id,
          result: await this.#open({
            ...(path === null ? {} : { path }),
            ...(url === null ? {} : { url }),
            ...(requestedApp === null ? {} : { requestedApp }),
            spaceId: context.spaceId,
            threadId: context.threadId,
          }),
        };
      }
      case "operations.invoke": {
        const context = this.#context(params);
        const slug = requiredString(params.app, "app");
        const operation = requiredString(params.operation, "operation");
        const requestedTabId = optionalString(params.tabId, "tabId");
        const tabId = requestedTabId ?? (context.slug === slug ? context.id : undefined);
        const result = await this.#broker.invoke({
          app: slug,
          operation,
          input: params.input ?? {},
          spaceId: context.spaceId,
          threadId: context.threadId,
          callerKind: "agent",
          ...(tabId === undefined ? {} : { tabId }),
        });
        return { ok: true, id: request.id, result };
      }
      case "developer.publishers.list":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerListPublishers(),
        };
      case "developer.publishers.create":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerCreatePublisher({
            slug: requiredString(params.slug, "slug"),
            displayName: requiredString(params.displayName, "displayName"),
            ...(optionalString(params.domain, "domain") === null
              ? {}
              : { domain: optionalString(params.domain, "domain")! }),
          }),
        };
      case "developer.apps.list":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerListApps(
            requiredString(params.publisherId, "publisherId"),
          ),
        };
      case "developer.apps.create":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerCreateApp({
            publisherId: requiredString(params.publisherId, "publisherId"),
            identifier: requiredString(params.identifier, "identifier"),
            slug: requiredString(params.slug, "slug"),
            displayName: requiredString(params.displayName, "displayName"),
            summary: requiredString(params.summary, "summary"),
            visibility: requiredVisibility(params.visibility),
          }),
        };
      case "developer.apps.visibility.set":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerSetAppVisibility({
            appId: requiredString(params.appId, "appId"),
            visibility: requiredVisibility(params.visibility),
          }),
        };
      case "developer.app-access.invite":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerInviteAppUser({
            appId: requiredString(params.appId, "appId"),
            email: requiredString(params.email, "email"),
          }),
        };
      case "developer.app-access.list":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerListAppInvitations(
            requiredString(params.appId, "appId"),
          ),
        };
      case "developer.app-access.revoke":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerRevokeAppInvitation({
            appId: requiredString(params.appId, "appId"),
            invitationId: requiredString(params.invitationId, "invitationId"),
          }),
        };
      case "developer.submissions.list":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerListSubmissions(
            requiredString(params.appId, "appId"),
          ),
        };
      case "developer.submissions.get":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerSubmissionStatus(
            requiredString(params.submissionId, "submissionId"),
          ),
        };
      case "developer.submissions.retry-validation":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerRetrySubmissionValidation(
            requiredString(params.submissionId, "submissionId"),
          ),
        };
      case "developer.submissions.retry-publication":
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerRetrySubmissionPublication(
            requiredString(params.submissionId, "submissionId"),
          ),
        };
      case "developer.submissions.resume-upload": {
        if (
          !params.evidence ||
          typeof params.evidence !== "object" ||
          Array.isArray(params.evidence)
        )
          throw new Error("evidence is required.");
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerResumeSubmissionUpload({
            submissionId: requiredString(params.submissionId, "submissionId"),
            packagePath: requiredString(params.packagePath, "packagePath"),
            evidence: params.evidence as Parameters<
              AppRegistryClient["developerResumeSubmissionUpload"]
            >[0]["evidence"],
          }),
        };
      }
      case "developer.submissions.create": {
        if (
          !params.evidence ||
          typeof params.evidence !== "object" ||
          Array.isArray(params.evidence)
        )
          throw new Error("evidence is required.");
        return {
          ok: true,
          id: request.id,
          result: await this.#requireRegistry().developerSubmit({
            appId: requiredString(params.appId, "appId"),
            packagePath: requiredString(params.packagePath, "packagePath"),
            evidence: params.evidence as Parameters<
              AppRegistryClient["developerSubmit"]
            >[0]["evidence"],
          }),
        };
      }
      case "developer.sideload": {
        if (!this.#sideload) {
          throw new Error("App sideloading is unavailable in this Penkra process.");
        }
        const spaceId = optionalString(params.spaceId, "spaceId");
        return {
          ok: true,
          id: request.id,
          result: await this.#sideload({
            sourcePath: requiredString(params.sourcePath, "sourcePath"),
            ...(spaceId === null ? {} : { spaceId }),
          }),
        };
      }
      default:
        throw new Error("Unknown App command method.");
    }
  }

  #requireRegistry(): AppRegistryClient {
    if (!this.#registry) throw new Error("The authenticated App registry is unavailable.");
    return this.#registry;
  }

  #context(params: Record<string, unknown>): DesktopAppTabDescriptor {
    const explicitTabId = optionalString(params.tabId, "tabId");
    const explicitSpaceId = optionalString(params.spaceId, "spaceId");
    const explicitThreadId = optionalString(params.threadId, "threadId");
    if ((explicitSpaceId === null) !== (explicitThreadId === null)) {
      throw new Error("spaceId and threadId must be supplied together.");
    }
    const tab = explicitTabId
      ? this.#tabs.list().find((candidate) => candidate.id === explicitTabId)
      : explicitSpaceId === null
        ? this.#tabs.current()
        : undefined;
    if (explicitSpaceId !== null && explicitThreadId !== null) {
      if (tab && (tab.spaceId !== explicitSpaceId || tab.threadId !== explicitThreadId)) {
        throw new Error(`App tab ${tab.id} does not belong to the requested Space and Thread.`);
      }
      return (
        tab ?? {
          id: "",
          rendererId: -1,
          appId: "",
          slug: "",
          name: "",
          iconDataUrl: null,
          spaceId: explicitSpaceId,
          threadId: explicitThreadId,
          route: "/",
          status: "ready",
          documentUrl: "",
        }
      );
    }
    if (!tab)
      throw new Error(
        explicitTabId
          ? `App tab ${explicitTabId} is not open.`
          : "No current App tab. Open an App or pass --tab-id.",
      );
    return tab;
  }

  #scope(params: Record<string, unknown>): { spaceId: string; threadId: string } {
    return {
      spaceId: requiredString(params.spaceId, "spaceId"),
      threadId: requiredString(params.threadId, "threadId"),
    };
  }

  #scopedTabs(params: Record<string, unknown>): ReadonlyArray<DesktopAppTabDescriptor> {
    const scope = this.#scope(params);
    return this.#tabs
      .list()
      .filter((tab) => tab.spaceId === scope.spaceId && tab.threadId === scope.threadId);
  }

  #scopedCurrentTab(params: Record<string, unknown>): DesktopAppTabDescriptor | null {
    const scope = this.#scope(params);
    const current = this.#tabs.current();
    return current?.spaceId === scope.spaceId && current.threadId === scope.threadId
      ? current
      : null;
  }

  #tab(params: Record<string, unknown>): DesktopAppTabDescriptor {
    const tabId = requiredString(params.tabId, "tabId");
    const tab = this.#scopedTabs(params).find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`App tab ${tabId} is not open in the caller Thread and Space.`);
    return tab;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("App command params must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value, name);
  if (result === null) throw new Error(`${name} is required.`);
  return result;
}

function requiredStringAllowEmpty(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value.map((entry) => requiredString(entry, name));
}

function requiredVisibility(value: unknown): "public" | "private" {
  const visibility = requiredString(value, "visibility");
  if (visibility !== "public" && visibility !== "private") {
    throw new Error("visibility must be public or private.");
  }
  return visibility;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function observationOptions(params: Record<string, unknown>): {
  target?: string;
  depth?: number;
  boxes?: boolean;
  outputPath?: string;
} {
  const target = optionalString(params.target, "target");
  const depth = optionalNumber(params.depth, "depth");
  const boxes = optionalBoolean(params.boxes, "boxes");
  const outputPath = optionalString(params.outputPath, "outputPath");
  return {
    ...(target === null ? {} : { target }),
    ...(depth === null ? {} : { depth }),
    ...(boxes === null ? {} : { boxes }),
    ...(outputPath === null ? {} : { outputPath }),
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
