// FILE: appleAppiumAutomation.ts
// Purpose: Owns isolated XCUITest/WebDriverAgent sessions behind the Apple simulator adapter.
// Layer: Trusted desktop simulator automation

import OS from "node:os";
import Path from "node:path";

import type { AppSimulatorButton, AppSimulatorSwipeInput } from "@penkra/sdk";

import type { AppleSimulatorAutomation } from "./appleSimulatorAdapter";
import type { AppleAppiumServer } from "./appleAppiumServer";
import { reserveSimulatorLoopbackPort } from "./simulatorLoopbackPort";

const APPIUM_SESSION_START_TIMEOUT_MS = 10 * 60_000;
const APPIUM_SESSION_DELETE_TIMEOUT_MS = 5_000;

interface AppleAutomationSession {
  sessionId: string;
  mjpegPort: number;
  onExit(error: Error): void;
  width: number;
  height: number;
}

export interface AppleAppiumRequest {
  (input: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export class AppiumAppleSimulatorAutomation implements AppleSimulatorAutomation {
  readonly #server: AppleAppiumServer;
  readonly #request: AppleAppiumRequest;
  readonly #allocatePort: () => Promise<number>;
  readonly #sessionStartTimeoutMs: number;
  readonly #sessionDeleteTimeoutMs: number;
  readonly #derivedDataRoot: string;
  readonly #sessions = new Map<string, AppleAutomationSession>();
  #serverExited = false;

  constructor(input: {
    server: AppleAppiumServer;
    request?: AppleAppiumRequest;
    allocatePort?: () => Promise<number>;
    sessionStartTimeoutMs?: number;
    sessionDeleteTimeoutMs?: number;
    derivedDataRoot?: string;
  }) {
    this.#server = input.server;
    this.#request = input.request ?? appiumRequest;
    this.#allocatePort = input.allocatePort ?? reserveSimulatorLoopbackPort;
    this.#sessionStartTimeoutMs = input.sessionStartTimeoutMs ?? APPIUM_SESSION_START_TIMEOUT_MS;
    this.#sessionDeleteTimeoutMs = input.sessionDeleteTimeoutMs ?? APPIUM_SESSION_DELETE_TIMEOUT_MS;
    this.#derivedDataRoot =
      input.derivedDataRoot ?? Path.join(OS.tmpdir(), "penkra-apple-wda-derived-data");
    void this.#server.exited.then((exit) => {
      this.#serverExited = true;
      const error = automationError(
        "NATIVE_SESSION_EXITED",
        `Appium exited unexpectedly (code ${exit.exitCode ?? "unknown"}${
          exit.signal ? `, signal ${exit.signal}` : ""
        }).`,
      );
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      for (const session of sessions) session.onExit(error);
    });
  }

  async open(input: {
    udid: string;
    signal: AbortSignal;
    usePreinstalledWda?: boolean;
    onExit(error: Error): void;
  }): Promise<void> {
    if (this.#serverExited) throw automationError("APPIUM_UNAVAILABLE", "Appium is not running.");
    if (this.#sessions.has(input.udid)) {
      throw automationError(
        "DEVICE_BUSY",
        "This Apple simulator already has an automation session.",
      );
    }
    const [wdaPort, mjpegPort] = await Promise.all([this.#allocatePort(), this.#allocatePort()]);
    const requestSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.#sessionStartTimeoutMs),
    ]);
    let response: unknown;
    try {
      response = await this.#createSession({ ...input, signal: requestSignal }, wdaPort, mjpegPort);
    } catch (error) {
      if (requestSignal.aborted) {
        await this.#server.stop().catch(() => undefined);
        throw automationError(
          input.signal.aborted ? "SESSION_CANCELLED" : "APPIUM_SESSION_TIMEOUT",
          input.signal.aborted
            ? "Apple Simulator startup was cancelled."
            : "Apple Simulator automation did not start in time.",
        );
      }
      throw error;
    }
    const sessionId = readSessionId(response);
    if (!sessionId)
      throw automationError("APPIUM_SESSION_FAILED", "Appium returned no session ID.");
    if (input.signal.aborted) {
      await this.#deleteSession(sessionId).catch(() => undefined);
      throw automationError("SESSION_CANCELLED", "Simulator session was cancelled.");
    }
    this.#sessions.set(input.udid, {
      sessionId,
      mjpegPort,
      onExit: input.onExit,
      width: 0,
      height: 0,
    });
  }

  async close(udid: string): Promise<void> {
    const session = this.#sessions.get(udid);
    if (!session) return;
    this.#sessions.delete(udid);
    await this.#deleteSession(session.sessionId);
  }

  async tap(udid: string, point: { x: number; y: number }): Promise<void> {
    const session = await this.#sessionWithSize(udid);
    const target = pixelPoint(session, point);
    await this.#actions(session, [
      { type: "pointerMove", duration: 0, x: target.x, y: target.y },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ]);
  }

  async swipe(udid: string, input: AppSimulatorSwipeInput): Promise<void> {
    const session = await this.#sessionWithSize(udid);
    const from = pixelPoint(session, input.from);
    const to = pixelPoint(session, input.to);
    await this.#actions(session, [
      { type: "pointerMove", duration: 0, x: from.x, y: from.y },
      { type: "pointerDown", button: 0 },
      {
        type: "pointerMove",
        duration: input.durationMs ?? 300,
        x: to.x,
        y: to.y,
      },
      { type: "pointerUp", button: 0 },
    ]);
  }

  async type(udid: string, text: string): Promise<void> {
    const session = this.#require(udid);
    await this.#request({
      method: "POST",
      url: this.#sessionUrl(session, "/keys"),
      body: { text, value: Array.from(text) },
    });
  }

  async press(udid: string, button: AppSimulatorButton): Promise<void> {
    if (button === "back" || button === "app-switcher") {
      throw automationError(
        "BUTTON_UNSUPPORTED",
        `${button === "back" ? "Back" : "App switcher"} is not a universal iOS hardware button.`,
      );
    }
    const name = {
      home: "home",
      power: "lock",
      "volume-up": "volumeUp",
      "volume-down": "volumeDown",
    }[button];
    const session = this.#require(udid);
    await this.#request({
      method: "POST",
      url: this.#sessionUrl(session, "/execute/sync"),
      body: { script: "mobile: pressButton", args: [{ name }] },
    });
  }

  async rotate(udid: string, orientation: "portrait" | "landscape"): Promise<void> {
    const session = this.#require(udid);
    await this.#request({
      method: "POST",
      url: this.#sessionUrl(session, "/orientation"),
      body: { orientation: orientation.toUpperCase() },
    });
    session.width = 0;
    session.height = 0;
  }

  mjpegUrl(udid: string): string {
    return `http://127.0.0.1:${this.#require(udid).mjpegPort}`;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#sessions.keys()].map((udid) => this.close(udid)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Apple automation cleanup failed.");
  }

  #createSession(
    input: { udid: string; signal: AbortSignal; usePreinstalledWda?: boolean },
    wdaPort: number,
    mjpegPort: number,
  ): Promise<unknown> {
    return this.#request({
      method: "POST",
      url: `${this.#server.baseUrl}/session`,
      signal: input.signal,
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: "iOS",
            "appium:automationName": "XCUITest",
            "appium:udid": input.udid,
            "appium:autoLaunch": false,
            // Simulator sessions are interactive tab surfaces, not short-lived test runs.
            // Penkra owns their lifetime and deletes them on Stop, tab close, or shutdown.
            "appium:newCommandTimeout": 0,
            // Penkra owns the only visible device surface. Appium must not open Apple's
            // standalone Simulator window beside the tab-hosted frame viewer.
            "appium:isHeadless": true,
            "appium:noReset": true,
            "appium:wdaLocalPort": wdaPort,
            "appium:wdaBindingIP": "127.0.0.1",
            "appium:mjpegServerPort": mjpegPort,
            "appium:derivedDataPath": Path.join(this.#derivedDataRoot, safeDevicePath(input.udid)),
            // Parallel cold Xcode builds can take longer than Appium's default ping window.
            // Penkra still enforces the outer session-start and caller-cancellation boundary.
            "appium:wdaLaunchTimeout": 180_000,
            "appium:wdaConnectionTimeout": 30_000,
            ...(input.usePreinstalledWda ? { "appium:usePreinstalledWDA": true } : {}),
          },
          firstMatch: [{}],
        },
      },
    });
  }

  async #sessionWithSize(udid: string): Promise<AppleAutomationSession> {
    const session = this.#require(udid);
    if (session.width > 0 && session.height > 0) return session;
    const response = await this.#request({
      method: "GET",
      url: this.#sessionUrl(session, "/window/rect"),
    });
    const rect = readValue(response);
    if (!isRecord(rect) || !positiveNumber(rect.width) || !positiveNumber(rect.height)) {
      throw automationError("INVALID_VIEWPORT", "Appium returned invalid simulator bounds.");
    }
    session.width = rect.width;
    session.height = rect.height;
    return session;
  }

  async #actions(session: AppleAutomationSession, actions: ReadonlyArray<unknown>): Promise<void> {
    await this.#request({
      method: "POST",
      url: this.#sessionUrl(session, "/actions"),
      body: {
        actions: [
          {
            type: "pointer",
            id: "penkra-touch",
            parameters: { pointerType: "touch" },
            actions,
          },
        ],
      },
    });
  }

  #require(udid: string): AppleAutomationSession {
    const session = this.#sessions.get(udid);
    if (!session)
      throw automationError("SESSION_NOT_READY", "Apple automation session is not ready.");
    return session;
  }

  #sessionUrl(session: AppleAutomationSession, suffix: string): string {
    return `${this.#server.baseUrl}/session/${encodeURIComponent(session.sessionId)}${suffix}`;
  }

  #deleteSession(sessionId: string): Promise<unknown> {
    return this.#request({
      method: "DELETE",
      url: `${this.#server.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      // Closing an App tab must not wait on Appium's generic request timeout.
      // The owning Appium process group is the authoritative cleanup fallback.
      signal: AbortSignal.timeout(this.#sessionDeleteTimeoutMs),
    });
  }
}

async function appiumRequest(input: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(input.url, {
    method: input.method,
    ...(input.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.body),
        }),
    signal: input.signal ?? AbortSignal.timeout(4 * 60_000),
  });
  const text = await response.text();
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw automationError("APPIUM_INVALID_RESPONSE", "Appium returned invalid JSON.");
    }
  }
  if (!response.ok) {
    throw automationError(
      "APPIUM_REQUEST_FAILED",
      appiumErrorMessage(value) || `Appium request failed with HTTP ${response.status}.`,
    );
  }
  return value;
}

function readSessionId(response: unknown): string {
  if (!isRecord(response)) return "";
  if (typeof response.sessionId === "string") return response.sessionId;
  const value = response.value;
  return isRecord(value) && typeof value.sessionId === "string" ? value.sessionId : "";
}

function readValue(response: unknown): unknown {
  return isRecord(response) && "value" in response ? response.value : response;
}

function appiumErrorMessage(response: unknown): string {
  const value = readValue(response);
  return isRecord(value) && typeof value.message === "string" ? value.message : "";
}

function pixelPoint(
  session: AppleAutomationSession,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.round(point.x * Math.max(0, session.width - 1)),
    y: Math.round(point.y * Math.max(0, session.height - 1)),
  };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeDevicePath(udid: string): string {
  return udid.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function automationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
