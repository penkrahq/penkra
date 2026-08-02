// FILE: appSessionManager.ts
// Purpose: Activates one locked-down persistent Electron session per App and Space.
// Layer: Trusted desktop App runtime

import { session, type Session } from "electron";

import type { InstalledAppPackage } from "./appInstallationState";
import {
  createAppPackageProtocolHandler,
  type AppPackageProtocolHandler,
} from "./appPackageProtocol";
import {
  createAppSessionPartition,
  decideAppNavigation,
  PENKRA_APP_SCHEME,
} from "./appRuntimePolicy";

export interface ActivateAppSessionInput {
  installedApp: InstalledAppPackage;
  spaceId: string;
}

export interface ActiveAppSession {
  appId: string;
  spaceId: string;
  partition: string;
  session: Session;
}

interface MutableProtocolTarget {
  handle: AppPackageProtocolHandler;
}

interface ActiveAppSessionRecord extends ActiveAppSession {
  protocolTarget: MutableProtocolTarget;
}

export interface AppSessionManagerDependencies {
  fromPartition?: typeof session.fromPartition;
  createProtocolHandler?: typeof createAppPackageProtocolHandler;
}

/**
 * Owns Electron session configuration for App renderers.
 *
 * Handler replacement is prepared before the live target changes, so a bad
 * verified-package path cannot break the currently active version. Mutations
 * for one App/Space partition are serialized without blocking other Apps.
 */
export class AppSessionManager {
  readonly #fromPartition: typeof session.fromPartition;
  readonly #createProtocolHandler: typeof createAppPackageProtocolHandler;
  readonly #records = new Map<string, ActiveAppSessionRecord>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(dependencies: AppSessionManagerDependencies = {}) {
    this.#fromPartition = dependencies.fromPartition ?? session.fromPartition.bind(session);
    this.#createProtocolHandler =
      dependencies.createProtocolHandler ?? createAppPackageProtocolHandler;
  }

  activate(input: ActivateAppSessionInput): Promise<ActiveAppSession> {
    const partition = createAppSessionPartition(input.installedApp.appId, input.spaceId);
    return this.#enqueue(partition, async () => {
      const nextHandler = await this.#createProtocolHandler({
        appId: input.installedApp.appId,
        packageRoot: input.installedApp.packagePath,
        entrypoint: input.installedApp.manifest.entrypoints.app,
      });
      const existing = this.#records.get(partition);
      if (existing) {
        assertRecordIdentity(existing, input.installedApp.appId, input.spaceId);
        existing.protocolTarget.handle = nextHandler;
        return publicSession(existing);
      }

      const partitionSession = this.#fromPartition(partition, { cache: true });
      const protocolTarget: MutableProtocolTarget = { handle: nextHandler };
      configureAppSession(partitionSession, input.installedApp.appId);
      await partitionSession.protocol.handle(PENKRA_APP_SCHEME, (request) =>
        protocolTarget.handle(request),
      );
      const record: ActiveAppSessionRecord = {
        appId: input.installedApp.appId,
        spaceId: input.spaceId,
        partition,
        session: partitionSession,
        protocolTarget,
      };
      this.#records.set(partition, record);
      return publicSession(record);
    });
  }

  deactivate(appId: string, spaceId: string): Promise<boolean> {
    const partition = createAppSessionPartition(appId, spaceId);
    return this.#enqueue(partition, async () => {
      const record = this.#records.get(partition);
      if (!record) return false;
      assertRecordIdentity(record, appId, spaceId);
      await record.session.protocol.unhandle(PENKRA_APP_SCHEME);
      this.#records.delete(partition);
      return true;
    });
  }

  get(appId: string, spaceId: string): ActiveAppSession | null {
    const record = this.#records.get(createAppSessionPartition(appId, spaceId));
    return record ? publicSession(record) : null;
  }

  #enqueue<Result>(partition: string, mutation: () => Promise<Result>): Promise<Result> {
    const previous = this.#queues.get(partition) ?? Promise.resolve();
    const operation = previous.then(mutation);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(partition, settled);
    void settled.finally(() => {
      if (this.#queues.get(partition) === settled) this.#queues.delete(partition);
    });
    return operation;
  }
}

function configureAppSession(partitionSession: Session, appId: string): void {
  partitionSession.on("will-download", (event) => event.preventDefault());
  partitionSession.setPermissionCheckHandler(() => false);
  partitionSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  partitionSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({ cancel: decideAppNavigation(appId, details.url).action !== "allow" });
    },
  );
}

function assertRecordIdentity(
  record: ActiveAppSessionRecord,
  appId: string,
  spaceId: string,
): void {
  if (record.appId !== appId || record.spaceId !== spaceId) {
    throw new Error("App session partition identity collision.");
  }
}

function publicSession(record: ActiveAppSessionRecord): ActiveAppSession {
  return {
    appId: record.appId,
    spaceId: record.spaceId,
    partition: record.partition,
    session: record.session,
  };
}
