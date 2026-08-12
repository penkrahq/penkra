export type AppSimulatorPlatform = "android" | "ios";

export type AppSimulatorFormFactor = "phone" | "tablet";

export interface AppSimulatorPlatformAvailability {
  platform: AppSimulatorPlatform;
  supported: boolean;
  status: "available" | "setup-required" | "unsupported";
  message: string | null;
}

export interface AppSimulatorRuntime {
  id: string;
  platform: AppSimulatorPlatform;
  name: string;
  version: string;
  status: "available" | "installing" | "missing" | "incompatible";
  installable: boolean;
  message: string | null;
}

export interface AppSimulatorDeviceType {
  id: string;
  platform: AppSimulatorPlatform;
  runtimeId: string;
  formFactor: AppSimulatorFormFactor;
  name: string;
}

export interface AppSimulatorSavedDevice {
  id: string;
  platform: AppSimulatorPlatform;
  runtimeId: string;
  deviceTypeId: string;
  formFactor: AppSimulatorFormFactor;
  name: string;
  state: "stopped" | "preparing" | "booting" | "ready" | "stopping" | "failed";
  lastError: string | null;
}

export type AppSimulatorTarget =
  | {
      platform: "ios";
      udid: string;
    }
  | {
      platform: "android";
      serial: string;
    };

export interface AppSimulatorSessionState {
  version: number;
  open: boolean;
  phase: "closed" | "preparing" | "booting" | "ready" | "stopping" | "failed";
  device: AppSimulatorSavedDevice | null;
  target: AppSimulatorTarget | null;
  orientation: "portrait" | "landscape";
  lastError: string | null;
}

export interface AppSimulatorEnvironment {
  platforms: ReadonlyArray<AppSimulatorPlatformAvailability>;
  runtimes: ReadonlyArray<AppSimulatorRuntime>;
}

export interface AppSimulatorSetupRequest {
  platform: AppSimulatorPlatform;
  runtimeId?: string;
}

export interface AppSimulatorCreateDeviceInput {
  runtimeId: string;
  deviceTypeId: string;
  name?: string;
}

export interface AppSimulatorSwipeInput {
  from: { x: number; y: number };
  to: { x: number; y: number };
  durationMs?: number;
}

export type AppSimulatorButton =
  | "home"
  | "back"
  | "app-switcher"
  | "power"
  | "volume-up"
  | "volume-down";
