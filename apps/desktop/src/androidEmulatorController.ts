// FILE: androidEmulatorController.ts
// Purpose: Controls an Android Emulator through its SDK-shipped authenticated gRPC protocol.
// Layer: Trusted desktop simulator transport

import * as Grpc from "@grpc/grpc-js";
import * as ProtoLoader from "@grpc/proto-loader";
import type { AppSimulatorButton, AppSimulatorSwipeInput } from "@penkra/sdk";

import type {
  AndroidEmulatorController,
  AndroidEmulatorControllerFactory,
  AndroidEmulatorEndpoint,
} from "./androidEmulatorSessionHost";
import type { SimulatorNativeCommandRunner } from "./simulatorNativeCommand";
import type { SimulatorFrame, SimulatorFrameSubscription } from "./simulatorManager";

const DEFAULT_SWIPE_DURATION_MS = 300;
const SWIPE_FRAME_MS = 16;

interface DynamicGrpcClient {
  close(): void;
  [method: string]: unknown;
}

interface DynamicGrpcStream {
  on(event: "data", listener: (value: ScreenshotResponse) => void): this;
  on(event: "error", listener: (error: Error & { code?: number }) => void): this;
  on(event: "end", listener: () => void): this;
  cancel(): void;
}

interface ScreenshotResponse {
  image?: Uint8Array;
  width?: number;
  height?: number;
  format?: { width?: number; height?: number };
}

export class DefaultAndroidEmulatorControllerFactory implements AndroidEmulatorControllerFactory {
  readonly #commands: SimulatorNativeCommandRunner;
  readonly #adb: string;

  constructor(input: { commands: SimulatorNativeCommandRunner; adb: string }) {
    this.#commands = input.commands;
    this.#adb = input.adb;
  }

  async connect(
    endpoint: AndroidEmulatorEndpoint,
    serial: string,
  ): Promise<AndroidEmulatorController> {
    const definition = await ProtoLoader.load(endpoint.protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const root = Grpc.loadPackageDefinition(definition) as Record<string, unknown>;
    const Controller = nestedValue(root, ["android", "emulation", "control", "EmulatorController"]);
    if (typeof Controller !== "function") {
      throw controllerError(
        "INVALID_EMULATOR_PROTOCOL",
        "Android Emulator controller service is unavailable.",
      );
    }
    const client = new (Controller as new (
      target: string,
      credentials: Grpc.ChannelCredentials,
    ) => DynamicGrpcClient)(endpoint.target, Grpc.credentials.createInsecure());
    return new GrpcAndroidEmulatorController({
      client,
      token: endpoint.token,
      serial,
      adb: this.#adb,
      commands: this.#commands,
    });
  }
}

export class GrpcAndroidEmulatorController implements AndroidEmulatorController {
  readonly #client: DynamicGrpcClient;
  readonly #metadata: Grpc.Metadata;
  readonly #serial: string;
  readonly #adb: string;
  readonly #commands: SimulatorNativeCommandRunner;
  #width = 0;
  #height = 0;
  #closed = false;

  constructor(input: {
    client: DynamicGrpcClient;
    token: string;
    serial: string;
    adb: string;
    commands: SimulatorNativeCommandRunner;
  }) {
    this.#client = input.client;
    this.#metadata = new Grpc.Metadata();
    this.#metadata.set("authorization", `Bearer ${input.token}`);
    this.#serial = input.serial;
    this.#adb = input.adb;
    this.#commands = input.commands;
  }

  async capture(): Promise<{ dataUrl: string }> {
    const screenshot = await this.#screenshot();
    const bytes = screenshot.image ? Buffer.from(screenshot.image) : Buffer.alloc(0);
    if (bytes.length === 0) {
      throw controllerError("EMPTY_FRAME", "Android Emulator returned an empty frame.");
    }
    return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  }

  subscribeFrames(
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): SimulatorFrameSubscription {
    if (this.#closed) {
      throw controllerError("SESSION_NOT_READY", "Android Emulator controller is closed.");
    }
    const method = this.#client.streamScreenshot;
    if (typeof method !== "function") {
      throw controllerError("INVALID_EMULATOR_PROTOCOL", "Missing streamScreenshot RPC.");
    }
    let stopped = false;
    const stream = (
      method as (request: unknown, metadata: Grpc.Metadata) => DynamicGrpcStream
    ).call(this.#client, { format: "PNG", display: 0 }, this.#metadata);
    stream.on("data", (screenshot) => {
      if (stopped || !screenshot.image || screenshot.image.byteLength === 0) return;
      const width = Number(screenshot.format?.width ?? screenshot.width ?? 0);
      const height = Number(screenshot.format?.height ?? screenshot.height ?? 0);
      if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) return;
      this.#width = width;
      this.#height = height;
      onFrame({ mimeType: "image/png", data: new Uint8Array(screenshot.image) });
    });
    stream.on("error", (error) => {
      if (!stopped && error.code !== Grpc.status.CANCELLED) onError(error);
    });
    stream.on("end", () => {
      if (!stopped) onError(controllerError("FRAME_STREAM_ENDED", "Android frame stream ended."));
    });
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        stream.cancel();
      },
    };
  }

  async tap(point: { x: number; y: number }): Promise<void> {
    const { x, y } = await this.#coordinates(point);
    await this.#touch(x, y, 1);
    await this.#touch(x, y, 0);
  }

  async swipe(input: AppSimulatorSwipeInput): Promise<void> {
    const from = await this.#coordinates(input.from);
    const to = await this.#coordinates(input.to);
    const duration = input.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
    const steps = Math.max(1, Math.ceil(duration / SWIPE_FRAME_MS));
    await this.#touch(from.x, from.y, 1);
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      await delay(duration / steps);
      await this.#touch(
        Math.round(from.x + (to.x - from.x) * progress),
        Math.round(from.y + (to.y - from.y) * progress),
        step === steps ? 0 : 1,
      );
    }
  }

  async type(text: string): Promise<void> {
    await this.#unary("sendKey", { text });
  }

  async press(button: AppSimulatorButton): Promise<void> {
    const key = {
      home: "KEYCODE_HOME",
      back: "KEYCODE_BACK",
      "app-switcher": "KEYCODE_APP_SWITCH",
      power: "KEYCODE_POWER",
      "volume-up": "KEYCODE_VOLUME_UP",
      "volume-down": "KEYCODE_VOLUME_DOWN",
    }[button];
    // The emulator gRPC service accepts Android-specific W3C key names but can
    // acknowledge them without delivering a system navigation event. ADB's
    // input keyevent command is the platform-standard hardware-button path and
    // targets this session's explicit emulator serial.
    await this.#commands.run({
      executable: this.#adb,
      args: ["-s", this.#serial, "shell", "input", "keyevent", key],
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
  }

  async rotate(orientation: "portrait" | "landscape"): Promise<void> {
    await this.#commands.run({
      executable: this.#adb,
      args: [
        "-s",
        this.#serial,
        "shell",
        "settings",
        "put",
        "system",
        "accelerometer_rotation",
        "0",
      ],
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
    await this.#commands.run({
      executable: this.#adb,
      args: [
        "-s",
        this.#serial,
        "shell",
        "settings",
        "put",
        "system",
        "user_rotation",
        orientation === "portrait" ? "0" : "1",
      ],
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
    this.#width = 0;
    this.#height = 0;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.close();
  }

  async #screenshot(): Promise<ScreenshotResponse> {
    const screenshot = await this.#unary<ScreenshotResponse>("getScreenshot", { format: "PNG" });
    const width = Number(screenshot.format?.width ?? screenshot.width ?? 0);
    const height = Number(screenshot.format?.height ?? screenshot.height ?? 0);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw controllerError("INVALID_FRAME", "Android Emulator returned invalid frame geometry.");
    }
    this.#width = width;
    this.#height = height;
    return screenshot;
  }

  async #coordinates(point: { x: number; y: number }): Promise<{ x: number; y: number }> {
    if (this.#width < 1 || this.#height < 1) await this.#screenshot();
    return {
      x: Math.round(point.x * Math.max(0, this.#width - 1)),
      y: Math.round(point.y * Math.max(0, this.#height - 1)),
    };
  }

  async #touch(x: number, y: number, pressure: number): Promise<void> {
    await this.#unary("sendTouch", {
      touches: [{ x, y, identifier: 0, pressure }],
      display: 0,
    });
  }

  #unary<T = unknown>(methodName: string, request: unknown): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        controllerError("SESSION_NOT_READY", "Android Emulator controller is closed."),
      );
    }
    const method = this.#client[methodName];
    if (typeof method !== "function") {
      return Promise.reject(
        controllerError("INVALID_EMULATOR_PROTOCOL", `Missing ${methodName} RPC.`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      (
        method as (
          request: unknown,
          metadata: Grpc.Metadata,
          callback: (error: Grpc.ServiceError | null, response: T) => void,
        ) => void
      ).call(this.#client, request, this.#metadata, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  }
}

function nestedValue(root: Record<string, unknown>, path: ReadonlyArray<string>): unknown {
  let value: unknown = root;
  for (const part of path) {
    if (!value || typeof value !== "object" || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controllerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
