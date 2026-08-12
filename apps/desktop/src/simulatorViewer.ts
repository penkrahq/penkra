// FILE: simulatorViewer.ts
// Purpose: Creates sandboxed trusted viewers for tab-owned simulator frames and input.
// Layer: Desktop hosted Simulator surface

import { session, WebContentsView } from "electron";

import type { HostedSurfaceFactory, HostedSurfaceView } from "./hostedSurfaceRegistry";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import type { DesktopSimulatorManager, SimulatorOwner } from "./simulatorManager";

const VIEWER_PARTITION = "penkra-simulator-viewer";

export class ElectronSimulatorViewerFactory implements HostedSurfaceFactory {
  readonly #manager: DesktopSimulatorManager;
  readonly #preloadPath: string;
  readonly #ownerByRendererId = new Map<number, SimulatorOwner>();

  constructor(input: { manager: DesktopSimulatorManager; preloadPath: string }) {
    this.#manager = input.manager;
    this.#preloadPath = input.preloadPath;
    const viewerSession = session.fromPartition(VIEWER_PARTITION);
    viewerSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    viewerSession.setPermissionCheckHandler(() => false);
  }

  create(owner: SimulatorOwner): HostedSurfaceView {
    const nativeView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: VIEWER_PARTITION,
        preload: this.#preloadPath,
      },
    });
    const contents = nativeView.webContents;
    this.#ownerByRendererId.set(contents.id, { ...owner });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.once("destroyed", () => this.#ownerByRendererId.delete(contents.id));
    void contents.loadURL(simulatorViewerDataUrl()).then(() => {
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("will-redirect", (event) => event.preventDefault());
    });

    let visible = false;
    let destroyed = false;
    let frameSubscription: { stop(): void } | null = null;
    let frameStart: Promise<void> | null = null;
    const stopFrames = () => {
      frameSubscription?.stop();
      frameSubscription = null;
    };
    const startFrames = () => {
      if (!visible || destroyed || frameSubscription || frameStart) return;
      if (this.#manager.getState(owner).phase !== "ready") return;
      frameStart = this.#manager
        .subscribeFrames(
          owner,
          (frame) => {
            if (!visible || destroyed || contents.isDestroyed()) return;
            contents.send(DESKTOP_IPC_CHANNELS.simulatorViewer.frame, {
              dataUrl: `data:${frame.mimeType};base64,${Buffer.from(frame.data).toString("base64")}`,
            });
          },
          () => {
            // Session state remains the source of actionable failures. A later visibility
            // or state transition can establish a new native frame subscription.
            stopFrames();
          },
        )
        .then((subscription) => {
          if (!visible || destroyed) subscription.stop();
          else frameSubscription = subscription;
        })
        .catch(() => undefined)
        .finally(() => {
          frameStart = null;
        });
    };
    const unsubscribeState = this.#manager.subscribe((changedOwner, state) => {
      if (!sameOwner(changedOwner, owner)) return;
      if (state.phase === "ready") startFrames();
      else stopFrames();
    });

    return {
      nativeView,
      setBounds: (bounds) => nativeView.setBounds(bounds),
      setVisible: (nextVisible) => {
        visible = nextVisible;
        nativeView.setVisible?.(nextVisible);
        if (nextVisible) startFrames();
        else stopFrames();
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        visible = false;
        unsubscribeState();
        stopFrames();
        this.#ownerByRendererId.delete(contents.id);
        if (!contents.isDestroyed()) contents.close();
      },
      observationTarget: () => contents,
    };
  }

  async invokeInput(rendererId: number, input: unknown): Promise<void> {
    const owner = this.#ownerByRendererId.get(rendererId);
    if (!owner) throw viewerError("VIEWER_NOT_FOUND", "Simulator viewer is unavailable.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw viewerError("INVALID_INPUT", "Simulator viewer input must be an object.");
    }
    return invokeSimulatorViewerInput(this.#manager, owner, input);
  }
}

export async function invokeSimulatorViewerInput(
  manager: Pick<DesktopSimulatorManager, "tap" | "swipe" | "type">,
  owner: SimulatorOwner,
  input: unknown,
): Promise<void> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw viewerError("INVALID_INPUT", "Simulator viewer input must be an object.");
  }
  const { method, value } = input as Record<string, unknown>;
  switch (method) {
    case "tap":
      return manager.tap(owner, normalizedPoint(value));
    case "swipe": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw viewerError("INVALID_INPUT", "Simulator swipe input must be an object.");
      }
      const swipe = value as Record<string, unknown>;
      const durationMs =
        typeof swipe.durationMs === "number" &&
        Number.isFinite(swipe.durationMs) &&
        swipe.durationMs >= 0 &&
        swipe.durationMs <= 10_000
          ? swipe.durationMs
          : undefined;
      if (swipe.durationMs !== undefined && durationMs === undefined) {
        throw viewerError("INVALID_INPUT", "Simulator swipe duration must be between 0 and 10000.");
      }
      return manager.swipe(owner, {
        from: normalizedPoint(swipe.from),
        to: normalizedPoint(swipe.to),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
    case "type":
      if (typeof value !== "string" || value.length > 10_000) {
        throw viewerError("INVALID_INPUT", "Simulator typed input must be text.");
      }
      return manager.type(owner, value);
    default:
      throw viewerError("INVALID_INPUT", "Simulator viewer input method is unsupported.");
  }
}

export function simulatorViewerDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(SIMULATOR_VIEWER_HTML)}`;
}

function normalizedPoint(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw viewerError("INVALID_INPUT", "Simulator coordinates must be an object.");
  }
  const { x, y } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw viewerError("INVALID_INPUT", "Simulator coordinates must be between 0 and 1.");
  }
  return { x, y };
}

function viewerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sameOwner(left: SimulatorOwner, right: SimulatorOwner): boolean {
  return left.appId === right.appId && left.spaceId === right.spaceId && left.tabId === right.tabId;
}

const SIMULATOR_VIEWER_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <meta name="color-scheme" content="dark">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #090909; }
    body { display: grid; place-items: center; outline: none; user-select: none; touch-action: none; }
    img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
    #status { position: absolute; color: #8c8c8c; font: 13px system-ui, sans-serif; }
  </style>
</head>
<body tabindex="0">
  <div id="status">Starting device…</div>
  <img id="frame" alt="Simulated device">
  <script>
    const api = window.penkraSimulatorViewer;
    const frame = document.getElementById('frame');
    const status = document.getElementById('status');
    let start = null;
    api.onFrame(({ dataUrl }) => {
      frame.onload = () => { status.hidden = true; };
      frame.src = dataUrl;
    });
    function point(event) {
      const box = frame.getBoundingClientRect();
      const naturalRatio = frame.naturalWidth && frame.naturalHeight
        ? frame.naturalWidth / frame.naturalHeight
        : box.width / Math.max(1, box.height);
      const boxRatio = box.width / Math.max(1, box.height);
      const width = boxRatio > naturalRatio ? box.height * naturalRatio : box.width;
      const height = boxRatio > naturalRatio ? box.height : box.width / naturalRatio;
      const left = box.left + (box.width - width) / 2;
      const top = box.top + (box.height - height) / 2;
      return {
        x: Math.max(0, Math.min(1, (event.clientX - left) / Math.max(1, width))),
        y: Math.max(0, Math.min(1, (event.clientY - top) / Math.max(1, height))),
      };
    }
    document.body.addEventListener('pointerdown', (event) => {
      document.body.focus();
      document.body.setPointerCapture(event.pointerId);
      start = { point: point(event), at: performance.now() };
    });
    document.body.addEventListener('pointerup', (event) => {
      if (!start) return;
      const end = point(event);
      const distance = Math.hypot(end.x - start.point.x, end.y - start.point.y);
      const durationMs = Math.max(0, Math.min(10000, performance.now() - start.at));
      const value = start;
      start = null;
      if (distance < 0.01) void api.input('tap', end);
      else void api.input('swipe', { from: value.point, to: end, durationMs });
    });
    document.body.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1) {
        event.preventDefault();
        void api.input('type', event.key);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void api.input('type', '\n');
      }
    });
  </script>
</body>
</html>`;
