import Crypto from "node:crypto";

import type {
  AppSimulatorButton,
  AppSimulatorCreateDeviceInput,
  AppSimulatorDeviceType,
  AppSimulatorEnvironment,
  AppSimulatorPlatform,
  AppSimulatorRuntime,
  AppSimulatorSetupRequest,
  AppSimulatorSavedDevice,
  AppSimulatorSessionState,
  AppSimulatorSwipeInput,
  AppSimulatorTarget,
} from "@penkra/sdk";

export interface SimulatorOwner {
  appId: string;
  spaceId: string;
  tabId: string;
}

export interface SimulatorScope {
  appId: string;
  spaceId: string;
}

export interface SimulatorStoredDevice {
  id: string;
  platform: AppSimulatorPlatform;
  runtimeId: string;
  deviceTypeId: string;
  formFactor: AppSimulatorSavedDevice["formFactor"];
  name: string;
  appId: string;
  spaceId: string;
}

interface OwnedSimulatorDevice extends SimulatorStoredDevice, AppSimulatorSavedDevice {}

export interface DesktopSimulatorManagerOptions {
  initialDevices?: ReadonlyArray<SimulatorStoredDevice>;
  persistDevices?(devices: ReadonlyArray<SimulatorStoredDevice>): Promise<void>;
}

export interface SimulatorAdapterOpenInput {
  device: AppSimulatorSavedDevice;
  signal: AbortSignal;
  onPhase(phase: "preparing" | "booting"): void;
  onExit(error: Error): void;
}

export interface SimulatorFrame {
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
}

export interface SimulatorFrameSubscription {
  stop(): void;
}

export interface SimulatorAdapter {
  readonly platform: AppSimulatorPlatform;
  availability(): Promise<AppSimulatorEnvironment["platforms"][number]>;
  listRuntimes(): Promise<ReadonlyArray<AppSimulatorRuntime>>;
  listDeviceTypes(runtimeId?: string): Promise<ReadonlyArray<AppSimulatorDeviceType>>;
  createDevice(input: AppSimulatorCreateDeviceInput): Promise<AppSimulatorSavedDevice>;
  eraseDevice(device: AppSimulatorSavedDevice): Promise<AppSimulatorSavedDevice>;
  deleteDevice(device: AppSimulatorSavedDevice): Promise<void>;
  requestSetup(runtimeId: string | undefined, signal: AbortSignal): Promise<void>;
  open(input: SimulatorAdapterOpenInput): Promise<AppSimulatorTarget>;
  close(device: AppSimulatorSavedDevice): Promise<void>;
  capture(device: AppSimulatorSavedDevice): Promise<{ dataUrl: string }>;
  subscribeFrames?(
    device: AppSimulatorSavedDevice,
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): Promise<SimulatorFrameSubscription>;
  tap(device: AppSimulatorSavedDevice, point: { x: number; y: number }): Promise<void>;
  swipe(device: AppSimulatorSavedDevice, input: AppSimulatorSwipeInput): Promise<void>;
  type(device: AppSimulatorSavedDevice, text: string): Promise<void>;
  press(device: AppSimulatorSavedDevice, button: AppSimulatorButton): Promise<void>;
  rotate(device: AppSimulatorSavedDevice, orientation: "portrait" | "landscape"): Promise<void>;
}

interface LiveSimulatorSession {
  owner: SimulatorOwner;
  deviceId: string;
  controller: AbortController;
  state: AppSimulatorSessionState;
  closing: Promise<void> | undefined;
}

interface SimulatorSetupTask {
  owner: SimulatorOwner;
  controller: AbortController;
  promise: Promise<AppSimulatorEnvironment>;
}

export type SimulatorStateListener = (
  owner: SimulatorOwner,
  state: AppSimulatorSessionState,
) => void;

export class DesktopSimulatorManager {
  readonly #adapters = new Map<AppSimulatorPlatform, SimulatorAdapter>();
  readonly #devices = new Map<string, OwnedSimulatorDevice>();
  readonly #sessions = new Map<string, LiveSimulatorSession>();
  readonly #setupTasks = new Map<string, SimulatorSetupTask>();
  readonly #leaseTabIdByDeviceId = new Map<string, string>();
  readonly #listeners = new Set<SimulatorStateListener>();
  readonly #versionByTabId = new Map<string, number>();
  readonly #persistDevices: DesktopSimulatorManagerOptions["persistDevices"];
  #deviceMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    adapters: ReadonlyArray<SimulatorAdapter>,
    options: DesktopSimulatorManagerOptions = {},
  ) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.platform)) {
        throw new Error(`Duplicate simulator adapter for ${adapter.platform}.`);
      }
      this.#adapters.set(adapter.platform, adapter);
    }
    this.#persistDevices = options.persistDevices;
    for (const stored of options.initialDevices ?? []) {
      if (this.#devices.has(stored.id)) {
        throw new Error(`Duplicate stored simulator device ID: ${stored.id}.`);
      }
      this.#devices.set(stored.id, {
        ...stored,
        state: "stopped",
        lastError: null,
      });
    }
  }

  subscribe(listener: SimulatorStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async subscribeFrames(
    owner: SimulatorOwner,
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): Promise<SimulatorFrameSubscription> {
    const session = this.#requireReadySession(owner);
    const device = this.#requireOwnedDevice(owner, session.deviceId);
    const adapter = this.#requireAdapter(device.platform);
    if (adapter.subscribeFrames) {
      return adapter.subscribeFrames(toPublicDevice(device), onFrame, onError);
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => void capture(), 200);
      timer.unref();
    };
    const capture = async () => {
      if (stopped) return;
      try {
        const result = await adapter.capture(toPublicDevice(device));
        const frame = frameFromDataUrl(result.dataUrl);
        if (!stopped) onFrame(frame);
      } catch (error) {
        if (!stopped) onError(asError(error));
      } finally {
        schedule();
      }
    };
    void capture();
    return {
      stop: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  async getEnvironment(): Promise<AppSimulatorEnvironment> {
    const adapters = [...this.#adapters.values()];
    const [platforms, runtimeGroups] = await Promise.all([
      Promise.all(adapters.map((adapter) => adapter.availability())),
      Promise.all(adapters.map((adapter) => adapter.listRuntimes())),
    ]);
    return { platforms, runtimes: runtimeGroups.flat() };
  }

  async listRuntimes(): Promise<ReadonlyArray<AppSimulatorRuntime>> {
    const groups = await Promise.all(
      [...this.#adapters.values()].map((adapter) => adapter.listRuntimes()),
    );
    return groups.flat();
  }

  async listDeviceTypes(runtimeId?: string): Promise<ReadonlyArray<AppSimulatorDeviceType>> {
    const groups = await Promise.all(
      [...this.#adapters.values()].map((adapter) => adapter.listDeviceTypes(runtimeId)),
    );
    return groups.flat();
  }

  listDevices(scope: SimulatorScope): ReadonlyArray<AppSimulatorSavedDevice> {
    return [...this.#devices.values()]
      .filter((device) => sameScope(device, scope))
      .map(toPublicDevice);
  }

  async createDevice(
    scope: SimulatorScope,
    input: AppSimulatorCreateDeviceInput,
  ): Promise<AppSimulatorSavedDevice> {
    const types = await this.listDeviceTypes(input.runtimeId);
    const deviceType = types.find(
      (candidate) => candidate.id === input.deviceTypeId && candidate.runtimeId === input.runtimeId,
    );
    if (!deviceType) throw simulatorError("DEVICE_TYPE_NOT_FOUND", "Device type is unavailable.");
    const adapter = this.#requireAdapter(deviceType.platform);
    const created = await adapter.createDevice(input);
    const id = created.id || Crypto.randomUUID();
    if (this.#devices.has(id)) {
      throw simulatorError("DEVICE_ID_CONFLICT", "Simulator returned a duplicate device ID.");
    }
    const owned: OwnedSimulatorDevice = {
      ...created,
      id,
      ...scope,
      state: "stopped",
    };
    try {
      await this.#commitDeviceMutation(() => {
        if (this.#devices.has(id)) {
          throw simulatorError("DEVICE_ID_CONFLICT", "Simulator returned a duplicate device ID.");
        }
        this.#devices.set(id, owned);
        return () => this.#devices.delete(id);
      });
    } catch (error) {
      if (errorCode(error) === "DEVICE_ID_CONFLICT") throw error;
      try {
        await adapter.deleteDevice(toPublicDevice(owned));
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Simulator device persistence failed and the native device could not be removed.",
          ),
          { code: "DEVICE_CREATE_ROLLBACK_FAILED" },
        );
      }
      throw error;
    }
    return toPublicDevice(owned);
  }

  async eraseDevice(scope: SimulatorScope, deviceId: string): Promise<AppSimulatorSavedDevice> {
    const device = this.#requireOwnedDevice(scope, deviceId);
    if (this.#leaseTabIdByDeviceId.has(deviceId)) {
      throw simulatorError("DEVICE_BUSY", "Stop the running device before erasing it.");
    }
    const erased = await this.#requireAdapter(device.platform).eraseDevice(toPublicDevice(device));
    const next: OwnedSimulatorDevice = {
      ...device,
      ...erased,
      id: device.id,
      ...scope,
    };
    await this.#commitDeviceMutation(() => {
      const previous = this.#devices.get(device.id);
      this.#devices.set(device.id, next);
      return () => {
        if (previous) this.#devices.set(device.id, previous);
      };
    });
    return toPublicDevice(next);
  }

  async deleteDevice(scope: SimulatorScope, deviceId: string): Promise<void> {
    const device = this.#requireOwnedDevice(scope, deviceId);
    if (this.#leaseTabIdByDeviceId.has(deviceId)) {
      throw simulatorError("DEVICE_BUSY", "Stop the running device before deleting it.");
    }
    await this.#requireAdapter(device.platform).deleteDevice(toPublicDevice(device));
    await this.#commitDeviceMutation(() => {
      const previous = this.#devices.get(deviceId);
      this.#devices.delete(deviceId);
      return () => {
        if (previous) this.#devices.set(deviceId, previous);
      };
    });
  }

  requestSetup(
    owner: SimulatorOwner,
    input: AppSimulatorSetupRequest,
  ): Promise<AppSimulatorEnvironment> {
    const existing = this.#setupTasks.get(owner.tabId);
    if (existing) {
      if (!sameOwner(existing.owner, owner)) {
        return Promise.reject(simulatorError("SETUP_BUSY", "This tab already owns runtime setup."));
      }
      return existing.promise;
    }
    const controller = new AbortController();
    const task: SimulatorSetupTask = {
      owner: { ...owner },
      controller,
      promise: Promise.resolve({ platforms: [], runtimes: [] }),
    };
    task.promise = this.#runSetup(task, input).finally(() => {
      if (this.#setupTasks.get(owner.tabId) === task) this.#setupTasks.delete(owner.tabId);
    });
    this.#setupTasks.set(owner.tabId, task);
    return task.promise;
  }

  cancelSetup(owner: SimulatorOwner): void {
    const task = this.#setupTasks.get(owner.tabId);
    if (!task || !sameOwner(task.owner, owner)) return;
    task.controller.abort(simulatorError("SETUP_CANCELLED", "Runtime setup was cancelled."));
  }

  async #runSetup(
    task: SimulatorSetupTask,
    input: AppSimulatorSetupRequest,
  ): Promise<AppSimulatorEnvironment> {
    const adapter = this.#requireAdapter(input.platform);
    if (input.runtimeId) {
      const runtime = (await adapter.listRuntimes()).find(
        (candidate) => candidate.id === input.runtimeId,
      );
      if (!runtime) throw simulatorError("RUNTIME_NOT_FOUND", "Simulator runtime is unavailable.");
      if (runtime.platform !== input.platform) {
        throw simulatorError("INVALID_INPUT", "Simulator runtime platform does not match.");
      }
    } else {
      const availability = await adapter.availability();
      if (availability.status !== "setup-required") {
        throw simulatorError("SETUP_NOT_REQUIRED", "Simulator platform setup is not required.");
      }
    }
    await adapter.requestSetup(input.runtimeId, task.controller.signal);
    return this.getEnvironment();
  }

  async open(owner: SimulatorOwner, deviceId: string): Promise<AppSimulatorSessionState> {
    const existing = this.#sessions.get(owner.tabId);
    if (existing?.deviceId === deviceId && existing.state.open) return cloneState(existing.state);
    if (existing) await this.close(owner);

    const device = this.#requireOwnedDevice(owner, deviceId);
    const leasedBy = this.#leaseTabIdByDeviceId.get(deviceId);
    if (leasedBy && leasedBy !== owner.tabId) {
      throw simulatorError("DEVICE_BUSY", "This saved device is already running.");
    }

    const controller = new AbortController();
    const session: LiveSimulatorSession = {
      owner: { ...owner },
      deviceId,
      controller,
      closing: undefined,
      state: this.#nextState(owner.tabId, {
        open: true,
        phase: "preparing",
        device: {
          ...toPublicDevice(device),
          state: "preparing",
          lastError: null,
        },
        target: null,
        orientation: "portrait",
        lastError: null,
      }),
    };
    this.#sessions.set(owner.tabId, session);
    this.#leaseTabIdByDeviceId.set(deviceId, owner.tabId);
    this.#updateDeviceState(deviceId, "preparing", null);
    this.#emit(session);

    try {
      const target = await this.#requireAdapter(device.platform).open({
        device: toPublicDevice(device),
        signal: controller.signal,
        onPhase: (phase) => {
          if (this.#sessions.get(owner.tabId) !== session || controller.signal.aborted) return;
          this.#updateDeviceState(deviceId, phase, null);
          session.state = this.#nextState(owner.tabId, {
            ...session.state,
            phase,
            device: {
              ...toPublicDevice(device),
              state: phase,
              lastError: null,
            },
          });
          this.#emit(session);
        },
        onExit: (error) => this.#handleAdapterExit(session, error),
      });
      if (this.#sessions.get(owner.tabId) !== session || controller.signal.aborted) {
        throw simulatorError("SESSION_CANCELLED", "Simulator session was cancelled.");
      }
      if (session.state.phase === "failed") {
        throw simulatorError(
          "NATIVE_SESSION_EXITED",
          session.state.lastError ?? "Simulator exited.",
        );
      }
      this.#updateDeviceState(deviceId, "ready", null);
      session.state = this.#nextState(owner.tabId, {
        ...session.state,
        phase: "ready",
        device: { ...toPublicDevice(device), state: "ready", lastError: null },
        target,
      });
      this.#emit(session);
      return cloneState(session.state);
    } catch (error) {
      if (this.#sessions.get(owner.tabId) !== session) throw error;
      const message = formatError(error);
      this.#leaseTabIdByDeviceId.delete(deviceId);
      this.#updateDeviceState(deviceId, "failed", message);
      session.state = this.#nextState(owner.tabId, {
        ...session.state,
        phase: "failed",
        device: {
          ...toPublicDevice(device),
          state: "failed",
          lastError: message,
        },
        target: null,
        lastError: message,
      });
      this.#emit(session);
      throw error;
    }
  }

  async close(owner: SimulatorOwner): Promise<void> {
    const session = this.#sessions.get(owner.tabId);
    if (!session || !sameOwner(session.owner, owner)) return;
    if (session.closing) return session.closing;
    const closing = this.#closeSession(session);
    session.closing = closing;
    try {
      await closing;
    } finally {
      if (session.closing === closing) session.closing = undefined;
    }
  }

  async #closeSession(session: LiveSimulatorSession): Promise<void> {
    const { owner } = session;
    session.controller.abort(simulatorError("SESSION_CANCELLED", "Simulator session closed."));
    const device = this.#devices.get(session.deviceId);
    if (device) {
      this.#updateDeviceState(device.id, "stopping", null);
      session.state = this.#nextState(owner.tabId, {
        ...session.state,
        phase: "stopping",
        device: {
          ...toPublicDevice(device),
          state: "stopping",
          lastError: null,
        },
      });
      this.#emit(session);
      try {
        await this.#requireAdapter(device.platform).close(toPublicDevice(device));
      } catch (error) {
        const message = formatError(error);
        this.#updateDeviceState(device.id, "failed", message);
        session.state = this.#nextState(owner.tabId, {
          ...session.state,
          phase: "failed",
          device: {
            ...toPublicDevice(device),
            state: "failed",
            lastError: message,
          },
          target: null,
          lastError: message,
        });
        this.#emit(session);
        throw error;
      }
      this.#updateDeviceState(device.id, "stopped", null);
    }
    if (this.#sessions.get(owner.tabId) === session) this.#sessions.delete(owner.tabId);
    if (this.#leaseTabIdByDeviceId.get(session.deviceId) === owner.tabId) {
      this.#leaseTabIdByDeviceId.delete(session.deviceId);
    }
    session.state = this.#nextState(owner.tabId, closedSimulatorState());
    this.#emit(session);
  }

  async closeTab(tabId: string): Promise<void> {
    const setup = this.#setupTasks.get(tabId);
    setup?.controller.abort(simulatorError("SETUP_CANCELLED", "Simulator tab closed."));
    const session = this.#sessions.get(tabId);
    if (session) await this.close(session.owner);
    await setup?.promise.catch(() => undefined);
  }

  getState(owner: SimulatorOwner): AppSimulatorSessionState {
    const session = this.#sessions.get(owner.tabId);
    if (!session || !sameOwner(session.owner, owner)) {
      return {
        ...closedSimulatorState(),
        version: this.#versionByTabId.get(owner.tabId) ?? 0,
      };
    }
    return cloneState(session.state);
  }

  getTarget(owner: SimulatorOwner): AppSimulatorTarget {
    const session = this.#requireReadySession(owner);
    return { ...session.state.target! } as AppSimulatorTarget;
  }

  async capture(owner: SimulatorOwner): Promise<{ dataUrl: string }> {
    const { device } = this.#readyDevice(owner);
    return this.#requireAdapter(device.platform).capture(device);
  }

  async tap(owner: SimulatorOwner, point: { x: number; y: number }): Promise<void> {
    assertNormalizedPoint(point);
    const { device } = this.#readyDevice(owner);
    await this.#requireAdapter(device.platform).tap(device, point);
  }

  async swipe(owner: SimulatorOwner, input: AppSimulatorSwipeInput): Promise<void> {
    assertNormalizedPoint(input.from);
    assertNormalizedPoint(input.to);
    if (
      input.durationMs !== undefined &&
      (!Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 10_000)
    ) {
      throw simulatorError("INVALID_INPUT", "Swipe duration must be between 0 and 10000ms.");
    }
    const { device } = this.#readyDevice(owner);
    await this.#requireAdapter(device.platform).swipe(device, input);
  }

  async type(owner: SimulatorOwner, text: string): Promise<void> {
    if (typeof text !== "string" || text.length > 10_000) {
      throw simulatorError("INVALID_INPUT", "Typed text must contain at most 10000 characters.");
    }
    const { device } = this.#readyDevice(owner);
    await this.#requireAdapter(device.platform).type(device, text);
  }

  async press(owner: SimulatorOwner, button: AppSimulatorButton): Promise<void> {
    const { device } = this.#readyDevice(owner);
    await this.#requireAdapter(device.platform).press(device, button);
  }

  async rotate(
    owner: SimulatorOwner,
    orientation: "portrait" | "landscape",
  ): Promise<AppSimulatorSessionState> {
    const { session, device } = this.#readyDevice(owner);
    await this.#requireAdapter(device.platform).rotate(device, orientation);
    session.state = this.#nextState(owner.tabId, {
      ...session.state,
      orientation,
    });
    this.#emit(session);
    return cloneState(session.state);
  }

  async dispose(): Promise<void> {
    for (const setup of this.#setupTasks.values()) {
      setup.controller.abort(simulatorError("SETUP_CANCELLED", "Simulator host closed."));
    }
    await Promise.allSettled([...this.#setupTasks.values()].map((setup) => setup.promise));
    await Promise.all([...this.#sessions.values()].map((session) => this.close(session.owner)));
    this.#listeners.clear();
  }

  diagnostics(): {
    savedDeviceCount: number;
    liveSessionCount: number;
    leasedDeviceCount: number;
    sessions: ReadonlyArray<{
      appId: string;
      spaceId: string;
      tabId: string;
      deviceId: string;
      phase: AppSimulatorSessionState["phase"];
    }>;
  } {
    return {
      savedDeviceCount: this.#devices.size,
      liveSessionCount: this.#sessions.size,
      leasedDeviceCount: this.#leaseTabIdByDeviceId.size,
      sessions: [...this.#sessions.values()].map((session) => ({
        ...session.owner,
        deviceId: session.deviceId,
        phase: session.state.phase,
      })),
    };
  }

  #readyDevice(owner: SimulatorOwner): {
    session: LiveSimulatorSession;
    device: AppSimulatorSavedDevice;
  } {
    const session = this.#requireReadySession(owner);
    const device = this.#devices.get(session.deviceId);
    if (!device || !sameScope(device, owner)) {
      throw simulatorError("DEVICE_NOT_FOUND", "Saved device is unavailable.");
    }
    return { session, device: toPublicDevice(device) };
  }

  #requireReadySession(owner: SimulatorOwner): LiveSimulatorSession {
    const session = this.#sessions.get(owner.tabId);
    if (
      !session ||
      !sameOwner(session.owner, owner) ||
      session.state.phase !== "ready" ||
      !session.state.target
    ) {
      throw simulatorError("SESSION_NOT_READY", "Simulator session is not ready.");
    }
    return session;
  }

  #requireOwnedDevice(scope: SimulatorScope, deviceId: string): OwnedSimulatorDevice {
    const device = this.#devices.get(deviceId);
    if (!device || !sameScope(device, scope)) {
      throw simulatorError("DEVICE_NOT_FOUND", "Saved device is unavailable.");
    }
    return device;
  }

  #requireAdapter(platform: AppSimulatorPlatform): SimulatorAdapter {
    const adapter = this.#adapters.get(platform);
    if (!adapter)
      throw simulatorError("PLATFORM_UNSUPPORTED", "Simulator platform is unsupported.");
    return adapter;
  }

  #updateDeviceState(
    deviceId: string,
    state: AppSimulatorSavedDevice["state"],
    lastError: string | null,
  ): void {
    const device = this.#devices.get(deviceId);
    if (!device) return;
    device.state = state;
    device.lastError = lastError;
  }

  #nextState(
    tabId: string,
    state: Omit<AppSimulatorSessionState, "version"> | AppSimulatorSessionState,
  ): AppSimulatorSessionState {
    const version = (this.#versionByTabId.get(tabId) ?? 0) + 1;
    this.#versionByTabId.set(tabId, version);
    return { ...state, version };
  }

  #emit(session: LiveSimulatorSession): void {
    const state = cloneState(session.state);
    for (const listener of this.#listeners) listener({ ...session.owner }, state);
  }

  #handleAdapterExit(session: LiveSimulatorSession, error: Error): void {
    if (this.#sessions.get(session.owner.tabId) !== session || session.controller.signal.aborted) {
      return;
    }
    const message = formatError(error);
    this.#leaseTabIdByDeviceId.delete(session.deviceId);
    this.#updateDeviceState(session.deviceId, "failed", message);
    const device = this.#devices.get(session.deviceId);
    session.state = this.#nextState(session.owner.tabId, {
      ...session.state,
      phase: "failed",
      device: device ? { ...toPublicDevice(device), state: "failed", lastError: message } : null,
      target: null,
      lastError: message,
    });
    this.#emit(session);
  }

  #commitDeviceMutation(mutate: () => () => void): Promise<void> {
    const operation = this.#deviceMutationQueue.then(async () => {
      const rollback = mutate();
      try {
        await this.#persistDevices?.(this.#storedDevices());
      } catch (error) {
        rollback();
        throw error;
      }
    });
    this.#deviceMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  #storedDevices(): ReadonlyArray<SimulatorStoredDevice> {
    return [...this.#devices.values()].map(
      ({ state: _state, lastError: _lastError, ...stored }) => ({ ...stored }),
    );
  }
}

function closedSimulatorState(): AppSimulatorSessionState {
  return {
    version: 0,
    open: false,
    phase: "closed",
    device: null,
    target: null,
    orientation: "portrait",
    lastError: null,
  };
}

function toPublicDevice(device: OwnedSimulatorDevice): AppSimulatorSavedDevice {
  const { appId: _appId, spaceId: _spaceId, ...publicDevice } = device;
  return { ...publicDevice };
}

function cloneState(state: AppSimulatorSessionState): AppSimulatorSessionState {
  return {
    ...state,
    device: state.device ? { ...state.device } : null,
    target: state.target ? ({ ...state.target } as AppSimulatorTarget) : null,
  };
}

function sameScope(left: SimulatorScope, right: SimulatorScope): boolean {
  return left.appId === right.appId && left.spaceId === right.spaceId;
}

function sameOwner(left: SimulatorOwner, right: SimulatorOwner): boolean {
  return left.tabId === right.tabId && sameScope(left, right);
}

function assertNormalizedPoint(point: { x: number; y: number }): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    throw simulatorError("INVALID_INPUT", "Simulator coordinates must be between 0 and 1.");
  }
}

function simulatorError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function frameFromDataUrl(dataUrl: string): SimulatorFrame {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw simulatorError("INVALID_FRAME", "Simulator returned an invalid image frame.");
  return {
    mimeType: match[1] as SimulatorFrame["mimeType"],
    data: Buffer.from(match[2]!, "base64"),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
