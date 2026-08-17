// FILE: appFrameDocumentRegistry.ts
// Purpose: Serves Runtime v2 App documents from opaque App×Space origins in the shell session.
// Layer: Trusted desktop App runtime

import type { Protocol } from "electron";

import type { InstalledAppPackage } from "./appInstallationState";
import {
  createAppPackageProtocolHandler,
  type AppPackageProtocolHandler,
} from "./appPackageProtocol";
import { createAppDocumentUrlForOrigin, PENKRA_APP_SCHEME } from "./appRuntimePolicy";

interface AppFrameDocumentRecord {
  appId: string;
  spaceId: string;
  origin: string;
  handle: AppPackageProtocolHandler;
}

export interface AppFrameDocumentRegistryOptions {
  protocol: Pick<Protocol, "handle" | "unhandle">;
  runtimeScriptPath: string;
  resolveOrigin(appId: string, spaceId: string): string;
  createProtocolHandler?: typeof createAppPackageProtocolHandler;
}

export class AppFrameDocumentRegistry {
  readonly #protocol: AppFrameDocumentRegistryOptions["protocol"];
  readonly #runtimeScriptPath: string;
  readonly #resolveOrigin: AppFrameDocumentRegistryOptions["resolveOrigin"];
  readonly #createProtocolHandler: typeof createAppPackageProtocolHandler;
  readonly #records = new Map<string, AppFrameDocumentRecord>();
  readonly #queues = new Map<string, Promise<void>>();
  #started = false;

  constructor(options: AppFrameDocumentRegistryOptions) {
    this.#protocol = options.protocol;
    this.#runtimeScriptPath = options.runtimeScriptPath;
    this.#resolveOrigin = options.resolveOrigin;
    this.#createProtocolHandler = options.createProtocolHandler ?? createAppPackageProtocolHandler;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#protocol.handle(PENKRA_APP_SCHEME, (request) => this.#handle(request));
    this.#started = true;
  }

  activate(installedApp: InstalledAppPackage, spaceId: string): Promise<string> {
    if (!this.#started)
      return Promise.reject(new Error("App frame document registry is not started."));
    const origin = this.#resolveOrigin(installedApp.appId, spaceId);
    return this.#enqueue(origin, async () => {
      const handle = await this.#createProtocolHandler({
        origin,
        packageRoot: installedApp.packagePath,
        entrypoint: installedApp.manifest.entrypoints.app,
        runtimeScriptPath: this.#runtimeScriptPath,
      });
      const existing = this.#records.get(origin);
      if (existing && (existing.appId !== installedApp.appId || existing.spaceId !== spaceId)) {
        throw new Error("App frame origin identity collision.");
      }
      this.#records.set(origin, { appId: installedApp.appId, spaceId, origin, handle });
      return createAppDocumentUrlForOrigin(origin, installedApp.manifest.entrypoints.app);
    });
  }

  deactivate(appId: string, spaceId: string): Promise<boolean> {
    const origin = this.#resolveOrigin(appId, spaceId);
    return this.#enqueue(origin, async () => {
      const existing = this.#records.get(origin);
      if (!existing) return false;
      if (existing.appId !== appId || existing.spaceId !== spaceId) {
        throw new Error("App frame origin identity collision.");
      }
      this.#records.delete(origin);
      return true;
    });
  }

  getOrigin(appId: string, spaceId: string): string | null {
    const origin = this.#resolveOrigin(appId, spaceId);
    return this.#records.has(origin) ? origin : null;
  }

  async dispose(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#records.clear();
    await this.#protocol.unhandle(PENKRA_APP_SCHEME);
  }

  async #handle(request: Request): Promise<Response> {
    let origin: string;
    try {
      const url = new URL(request.url);
      origin = `${PENKRA_APP_SCHEME}://${url.hostname}`;
    } catch {
      return notFound();
    }
    const record = this.#records.get(origin);
    return record ? record.handle(request) : notFound();
  }

  #enqueue<Result>(origin: string, mutation: () => Promise<Result>): Promise<Result> {
    const previous = this.#queues.get(origin) ?? Promise.resolve();
    const operation = previous.then(mutation);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(origin, settled);
    void settled.finally(() => {
      if (this.#queues.get(origin) === settled) this.#queues.delete(origin);
    });
    return operation;
  }
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
