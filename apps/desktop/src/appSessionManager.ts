// FILE: appSessionManager.ts
// Purpose: Activates one locked-down persistent Electron session per App and Space.
// Layer: Trusted desktop App runtime

import { session, type Session } from "electron";

import type { InstalledAppPackage } from "./appInstallationState";
import type { AppStandardPermissionName } from "./appStandardPermissions";
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
  getStandardPermission?: (
    appId: string,
    spaceId: string,
    permission: AppStandardPermissionName,
  ) => boolean;
  requestStandardPermissions?: (input: {
    appId: string;
    appName: string;
    spaceId: string;
    permissions: ReadonlyArray<AppStandardPermissionName>;
  }) => Promise<boolean>;
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
  readonly #getStandardPermission: NonNullable<
    AppSessionManagerDependencies["getStandardPermission"]
  >;
  readonly #requestStandardPermissions: NonNullable<
    AppSessionManagerDependencies["requestStandardPermissions"]
  >;

  constructor(dependencies: AppSessionManagerDependencies = {}) {
    this.#fromPartition = dependencies.fromPartition ?? session.fromPartition.bind(session);
    this.#createProtocolHandler =
      dependencies.createProtocolHandler ?? createAppPackageProtocolHandler;
    this.#getStandardPermission = dependencies.getStandardPermission ?? (() => false);
    this.#requestStandardPermissions =
      dependencies.requestStandardPermissions ?? (async () => false);
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
      configureAppSession(partitionSession, {
        appId: input.installedApp.appId,
        appName: input.installedApp.name,
        spaceId: input.spaceId,
        getPermission: this.#getStandardPermission,
        requestPermissions: this.#requestStandardPermissions,
      });
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

  /**
   * Erases the complete persistent Chromium partition for one App in one Space.
   * Callers must deactivate the runtime first so a live renderer cannot race
   * the destructive clear or immediately recreate state.
   */
  eraseData(appId: string, spaceId: string): Promise<void> {
    const partition = createAppSessionPartition(appId, spaceId);
    return this.#enqueue(partition, async () => {
      if (this.#records.has(partition)) {
        throw new Error(`${appId} must be inactive in Space ${spaceId} before its data is erased.`);
      }
      const partitionSession = this.#fromPartition(partition, { cache: true });
      await partitionSession.clearData();
      await partitionSession.clearAuthCache();
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

function configureAppSession(
  partitionSession: Session,
  input: {
    appId: string;
    appName: string;
    spaceId: string;
    getPermission: NonNullable<AppSessionManagerDependencies["getStandardPermission"]>;
    requestPermissions: NonNullable<AppSessionManagerDependencies["requestStandardPermissions"]>;
  },
): void {
  partitionSession.on("will-download", (event) => event.preventDefault());
  partitionSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission === "clipboard-sanitized-write") return true;
    const requested = standardPermissionNames(permission, details);
    return (
      requested.length > 0 &&
      requested.every((name) => input.getPermission(input.appId, input.spaceId, name))
    );
  });
  partitionSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === "clipboard-sanitized-write") return callback(true);
    const requested = standardPermissionNames(permission, details);
    if (requested.length === 0) return callback(false);
    if (requested.every((name) => input.getPermission(input.appId, input.spaceId, name)))
      return callback(true);
    void input
      .requestPermissions({
        appId: input.appId,
        appName: input.appName,
        spaceId: input.spaceId,
        permissions: requested,
      })
      .then(callback, () => callback(false));
  });
  partitionSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: decideAppNavigation(input.appId, details.url).action !== "allow" });
  });
}

function standardPermissionNames(
  permission: string,
  details: unknown,
): AppStandardPermissionName[] {
  if (permission === "notifications") return ["notifications"];
  if (permission === "clipboard-read") return ["clipboard-read"];
  if (permission !== "media") return [];
  const result: AppStandardPermissionName[] = [];
  const mediaTypes =
    details &&
    typeof details === "object" &&
    "mediaTypes" in details &&
    Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : [];
  if (mediaTypes.includes("audio")) result.push("microphone");
  if (mediaTypes.includes("video")) result.push("camera");
  return result;
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
