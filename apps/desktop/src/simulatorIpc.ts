// FILE: simulatorIpc.ts
// Purpose: Validates hostile renderer calls before dispatching to the owned simulator manager.
// Layer: Desktop IPC boundary

import type {
  AppSimulatorButton,
  AppSimulatorSetupRequest,
  AppSimulatorSwipeInput,
} from "@penkra/sdk";

import type { DesktopSimulatorManager, SimulatorOwner } from "./simulatorManager";

export interface SimulatorViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SimulatorViewportController {
  setViewport(owner: SimulatorOwner, bounds: SimulatorViewportBounds | null): Promise<void> | void;
}

export async function invokeSimulatorCall(input: {
  manager: DesktopSimulatorManager;
  owner: SimulatorOwner;
  method: string;
  value: unknown;
  viewport: SimulatorViewportController;
  authorizeSetup?(input: AppSimulatorSetupRequest): Promise<boolean>;
}): Promise<unknown> {
  const { manager, owner, method, value } = input;
  switch (method) {
    case "getEnvironment":
      return manager.getEnvironment();
    case "listRuntimes":
      return manager.listRuntimes();
    case "listDeviceTypes":
      return manager.listDeviceTypes(optionalString(value, "Simulator runtime ID"));
    case "listDevices":
      return manager.listDevices(owner);
    case "createDevice": {
      const record = requiredRecord(value, "Simulator device input");
      return manager.createDevice(owner, {
        runtimeId: requiredString(record.runtimeId, "Simulator runtime ID"),
        deviceTypeId: requiredString(record.deviceTypeId, "Simulator device type ID"),
        ...(record.name === undefined
          ? {}
          : { name: boundedString(record.name, "Simulator device name", 256) }),
      });
    }
    case "eraseDevice":
      return manager.eraseDevice(owner, requiredString(value, "Simulator device ID"));
    case "deleteDevice":
      return manager.deleteDevice(owner, requiredString(value, "Simulator device ID"));
    case "requestSetup": {
      const request = setupRequest(value);
      if (!(await input.authorizeSetup?.(request))) {
        throw Object.assign(new Error("Runtime setup was cancelled."), { code: "SETUP_CANCELLED" });
      }
      return manager.requestSetup(owner, request);
    }
    case "cancelSetup":
      manager.cancelSetup(owner);
      return undefined;
    case "open":
      return manager.open(owner, requiredString(value, "Simulator device ID"));
    case "close":
      return manager.close(owner);
    case "getState":
      return manager.getState(owner);
    case "setViewport":
      return input.viewport.setViewport(owner, viewportBounds(value));
    case "getTarget":
      return manager.getTarget(owner);
    case "capture":
      return manager.capture(owner);
    case "tap":
      return manager.tap(owner, normalizedPoint(value, "Simulator tap"));
    case "swipe": {
      const record = requiredRecord(value, "Simulator swipe");
      const swipe: AppSimulatorSwipeInput = {
        from: normalizedPoint(record.from, "Simulator swipe start"),
        to: normalizedPoint(record.to, "Simulator swipe end"),
        ...(record.durationMs === undefined
          ? {}
          : {
              durationMs: boundedNumber(record.durationMs, "Simulator swipe duration", 0, 10_000),
            }),
      };
      return manager.swipe(owner, swipe);
    }
    case "type":
      return manager.type(owner, boundedString(value, "Simulator text", 10_000, true));
    case "press":
      return manager.press(owner, simulatorButton(value));
    case "rotate":
      if (value !== "portrait" && value !== "landscape") {
        throw invalidInput("Simulator orientation must be portrait or landscape.");
      }
      return manager.rotate(owner, value);
    default:
      throw Object.assign(new Error(`Unsupported simulator method: ${method}.`), {
        code: "METHOD_NOT_FOUND",
      });
  }
}

function setupRequest(value: unknown): AppSimulatorSetupRequest {
  const record = requiredRecord(value, "Simulator setup request");
  const platform = requiredString(record.platform, "Simulator platform");
  if (platform !== "ios" && platform !== "android") {
    throw invalidInput("Simulator platform must be ios or android.");
  }
  const runtimeId = optionalString(record.runtimeId, "Simulator runtime ID");
  return { platform, ...(runtimeId ? { runtimeId } : {}) };
}

function viewportBounds(value: unknown): SimulatorViewportBounds | null {
  if (value === null) return null;
  const record = requiredRecord(value, "Simulator viewport");
  return {
    x: boundedNumber(record.x, "Simulator viewport x", -1_000_000, 1_000_000),
    y: boundedNumber(record.y, "Simulator viewport y", -1_000_000, 1_000_000),
    width: boundedNumber(record.width, "Simulator viewport width", 0, 100_000),
    height: boundedNumber(record.height, "Simulator viewport height", 0, 100_000),
  };
}

function normalizedPoint(value: unknown, label: string): { x: number; y: number } {
  const record = requiredRecord(value, label);
  return {
    x: boundedNumber(record.x, `${label} x`, 0, 1),
    y: boundedNumber(record.y, `${label} y`, 0, 1),
  };
}

function simulatorButton(value: unknown): AppSimulatorButton {
  const buttons: ReadonlyArray<AppSimulatorButton> = [
    "home",
    "back",
    "app-switcher",
    "power",
    "volume-up",
    "volume-down",
  ];
  if (typeof value !== "string" || !buttons.includes(value as AppSimulatorButton)) {
    throw invalidInput("Simulator button is invalid.");
  }
  return value as AppSimulatorButton;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  return boundedString(value, label, 512);
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw invalidInput(`${label} must contain at most ${maximum} characters.`);
  }
  return value;
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_INPUT" });
}
