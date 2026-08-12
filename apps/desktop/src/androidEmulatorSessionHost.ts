// FILE: androidEmulatorSessionHost.ts
// Purpose: Owns one hidden Android Emulator process and controller client per leased saved AVD.
// Layer: Trusted desktop simulator lifecycle

import type { AppSimulatorButton, AppSimulatorSwipeInput } from "@penkra/sdk";

import type { AndroidEmulatorSessionHost } from "./androidSimulatorAdapter";
import type { SimulatorFrame, SimulatorFrameSubscription } from "./simulatorManager";

export interface AndroidEmulatorEndpoint {
  target: string;
  token: string;
  protoPath: string;
}

export interface AndroidEmulatorInstance {
  serial: string;
  endpoint: AndroidEmulatorEndpoint;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

export interface AndroidEmulatorLauncher {
  start(input: {
    avdName: string;
    signal: AbortSignal;
    onPhase(phase: "preparing" | "booting"): void;
  }): Promise<AndroidEmulatorInstance>;
  erase(avdName: string): Promise<void>;
}

export interface AndroidEmulatorController {
  capture(): Promise<{ dataUrl: string }>;
  subscribeFrames(
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): SimulatorFrameSubscription;
  tap(point: { x: number; y: number }): Promise<void>;
  swipe(input: AppSimulatorSwipeInput): Promise<void>;
  type(text: string): Promise<void>;
  press(button: AppSimulatorButton): Promise<void>;
  rotate(orientation: "portrait" | "landscape"): Promise<void>;
  close(): Promise<void>;
}

export interface AndroidEmulatorControllerFactory {
  connect(endpoint: AndroidEmulatorEndpoint, serial: string): Promise<AndroidEmulatorController>;
}

interface LiveAndroidSession {
  instance: AndroidEmulatorInstance;
  controller: AndroidEmulatorController;
  closing: boolean;
}

export class DefaultAndroidEmulatorSessionHost implements AndroidEmulatorSessionHost {
  readonly #launcher: AndroidEmulatorLauncher;
  readonly #controllers: AndroidEmulatorControllerFactory;
  readonly #sessions = new Map<string, LiveAndroidSession>();
  readonly #opening = new Set<string>();

  constructor(input: {
    launcher: AndroidEmulatorLauncher;
    controllers: AndroidEmulatorControllerFactory;
  }) {
    this.#launcher = input.launcher;
    this.#controllers = input.controllers;
  }

  async open(input: {
    avdName: string;
    signal: AbortSignal;
    onPhase(phase: "preparing" | "booting"): void;
    onExit(error: Error): void;
  }): Promise<{ serial: string }> {
    if (this.#sessions.has(input.avdName) || this.#opening.has(input.avdName)) {
      throw sessionError("DEVICE_BUSY", "This Android device is already running.");
    }
    this.#opening.add(input.avdName);
    let instance: AndroidEmulatorInstance | undefined;
    let controller: AndroidEmulatorController | undefined;
    try {
      instance = await this.#launcher.start(input);
      if (input.signal.aborted)
        throw sessionError("SESSION_CANCELLED", "Simulator session was cancelled.");
      controller = await this.#controllers.connect(instance.endpoint, instance.serial);
      if (input.signal.aborted)
        throw sessionError("SESSION_CANCELLED", "Simulator session was cancelled.");
      const session: LiveAndroidSession = { instance, controller, closing: false };
      this.#sessions.set(input.avdName, session);
      void instance.exited.then((exit) =>
        this.#handleUnexpectedExit(input.avdName, session, input.onExit, exit),
      );
      return { serial: instance.serial };
    } catch (error) {
      await settleCleanup(controller, instance);
      throw error;
    } finally {
      this.#opening.delete(input.avdName);
    }
  }

  async close(avdName: string): Promise<void> {
    const session = this.#sessions.get(avdName);
    if (!session) return;
    this.#sessions.delete(avdName);
    session.closing = true;
    const errors = await cleanup(session.controller, session.instance);
    if (errors.length > 0) {
      throw Object.assign(new AggregateError(errors, "Android Emulator cleanup failed."), {
        code: "SESSION_CLEANUP_FAILED",
      });
    }
  }

  async erase(avdName: string): Promise<void> {
    if (this.#sessions.has(avdName) || this.#opening.has(avdName)) {
      throw sessionError("DEVICE_BUSY", "Stop the Android device before erasing it.");
    }
    await this.#launcher.erase(avdName);
  }

  async capture(avdName: string): Promise<{ dataUrl: string }> {
    return this.#require(avdName).controller.capture();
  }

  async subscribeFrames(
    avdName: string,
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): Promise<SimulatorFrameSubscription> {
    return this.#require(avdName).controller.subscribeFrames(onFrame, onError);
  }

  async tap(avdName: string, point: { x: number; y: number }): Promise<void> {
    await this.#require(avdName).controller.tap(point);
  }

  async swipe(avdName: string, input: AppSimulatorSwipeInput): Promise<void> {
    await this.#require(avdName).controller.swipe(input);
  }

  async type(avdName: string, text: string): Promise<void> {
    await this.#require(avdName).controller.type(text);
  }

  async press(avdName: string, button: AppSimulatorButton): Promise<void> {
    await this.#require(avdName).controller.press(button);
  }

  async rotate(avdName: string, orientation: "portrait" | "landscape"): Promise<void> {
    await this.#require(avdName).controller.rotate(orientation);
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#sessions.keys()].map((name) => this.close(name)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0)
      throw new AggregateError(errors, "Android Emulator host cleanup failed.");
  }

  diagnostics(): { liveAvdNames: ReadonlyArray<string>; openingAvdNames: ReadonlyArray<string> } {
    return {
      liveAvdNames: [...this.#sessions.keys()],
      openingAvdNames: [...this.#opening],
    };
  }

  #require(avdName: string): LiveAndroidSession {
    const session = this.#sessions.get(avdName);
    if (!session || session.closing) {
      throw sessionError("SESSION_NOT_READY", "Android Emulator session is not ready.");
    }
    return session;
  }

  async #handleUnexpectedExit(
    avdName: string,
    session: LiveAndroidSession,
    onExit: (error: Error) => void,
    exit: { exitCode: number | null; signal: NodeJS.Signals | null },
  ): Promise<void> {
    if (session.closing || this.#sessions.get(avdName) !== session) return;
    this.#sessions.delete(avdName);
    session.closing = true;
    try {
      await session.controller.close();
    } catch {
      // The owning manager publishes native process failure; controller cleanup is best effort here.
    }
    onExit(
      sessionError(
        "NATIVE_SESSION_EXITED",
        `Android Emulator exited unexpectedly (code ${exit.exitCode ?? "unknown"}${
          exit.signal ? `, signal ${exit.signal}` : ""
        }).`,
      ),
    );
  }
}

async function settleCleanup(
  controller: AndroidEmulatorController | undefined,
  instance: AndroidEmulatorInstance | undefined,
): Promise<void> {
  await Promise.allSettled([
    controller?.close() ?? Promise.resolve(),
    instance?.stop() ?? Promise.resolve(),
  ]);
}

async function cleanup(
  controller: AndroidEmulatorController,
  instance: AndroidEmulatorInstance,
): Promise<unknown[]> {
  const results = await Promise.allSettled([controller.close(), instance.stop()]);
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function sessionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
