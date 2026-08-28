// FILE: developmentAppSideloadRegistry.ts
// Purpose: Registers and watches multiple runtime-loaded Apps in Penkra development.
// Layer: Desktop development runtime

import * as Path from "node:path";

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import {
  bootstrapDevelopmentSideload,
  type AuthorizeDevelopmentSideload,
  type DevelopmentAppSideloadResult,
} from "./developmentAppSideload";
import {
  watchDevelopmentAppSideload,
  type DevelopmentAppSideloadWatcher,
} from "./developmentAppSideloadWatcher";

type LoadDevelopmentApp = typeof bootstrapDevelopmentSideload;
type WatchDevelopmentApp = typeof watchDevelopmentAppSideload;

interface RegisteredDevelopmentApp {
  appId: string;
  sourcePath: string;
  spaceId: string;
  watcher: DevelopmentAppSideloadWatcher;
}

export class DevelopmentAppSideloadRegistry {
  readonly #runtime: Pick<DesktopAppRuntime, "packages" | "installations">;
  readonly #load: LoadDevelopmentApp;
  readonly #watch: WatchDevelopmentApp;
  readonly #onApplied: (result: DevelopmentAppSideloadResult) => void | Promise<void>;
  readonly #onError: (
    error: unknown,
    context: { appId: string; sourcePath: string; spaceId: string },
  ) => void;
  readonly #authorize: AuthorizeDevelopmentSideload | undefined;
  readonly #registrations = new Map<string, RegisteredDevelopmentApp>();
  #operations: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(input: {
    runtime: Pick<DesktopAppRuntime, "packages" | "installations">;
    onApplied?: (result: DevelopmentAppSideloadResult) => void | Promise<void>;
    onError?: (
      error: unknown,
      context: { appId: string; sourcePath: string; spaceId: string },
    ) => void;
    load?: LoadDevelopmentApp;
    watch?: WatchDevelopmentApp;
    authorize?: AuthorizeDevelopmentSideload;
  }) {
    this.#runtime = input.runtime;
    this.#load = input.load ?? bootstrapDevelopmentSideload;
    this.#watch = input.watch ?? watchDevelopmentAppSideload;
    this.#onApplied = input.onApplied ?? (() => undefined);
    this.#onError = input.onError ?? (() => undefined);
    this.#authorize = input.authorize;
  }

  register(sourcePath: string, spaceId: string): Promise<DevelopmentAppSideloadResult> {
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error("The development App sideload registry is closed.");
      const result = await this.#load(
        this.#runtime,
        Path.resolve(sourcePath),
        spaceId,
        this.#authorize,
      );
      const key = registrationKey(result.spaceId, result.appId);
      const existing = this.#registrations.get(key);
      if (existing?.sourcePath === result.sourcePath) return result;
      if (existing) {
        this.#registrations.delete(key);
        await existing.watcher.close();
      }

      const context = {
        appId: result.appId,
        sourcePath: result.sourcePath,
        spaceId: result.spaceId,
      };
      const watcher = this.#watch({
        sourcePath: result.sourcePath,
        reload: async () => {
          const reloaded = await this.#load(
            this.#runtime,
            result.sourcePath,
            result.spaceId,
            this.#authorize,
          );
          if (reloaded.status !== "current") await this.#onApplied(reloaded);
        },
        onError: (error) => this.#onError(error, context),
      });
      this.#registrations.set(key, { ...context, watcher });
      return result;
    });
  }

  close(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      const registrations = [...this.#registrations.values()];
      this.#registrations.clear();
      await Promise.all(registrations.map((registration) => registration.watcher.close()));
    });
  }

  #enqueue<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function registrationKey(spaceId: string, appId: string): string {
  return `${spaceId}\u0000${appId}`;
}
