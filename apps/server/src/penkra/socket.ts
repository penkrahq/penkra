import type { PenkraSnapshot } from "@synara/contracts";
import { io, type Socket } from "socket.io-client";

import type { PenkraRuntimeConfig } from "./config";
import { PenkraApiError, PenkraBackendClient } from "./backendClient";

export class PenkraSocketClient {
  private socket: Socket | null = null;
  private backend: PenkraBackendClient | null = null;
  private connectionKey: string | null = null;
  private latest: PenkraSnapshot | null = null;
  private refreshPromise: Promise<PenkraSnapshot> | null = null;

  constructor(
    private readonly config: PenkraRuntimeConfig | null,
    private readonly publish: (snapshot: PenkraSnapshot) => void,
    private readonly reconcileRegistry: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async getSnapshot(): Promise<PenkraSnapshot> {
    if (!this.config) return emptySnapshot("disabled", "Penkra root is not configured");
    const backend = await PenkraBackendClient.fromHqConfig(this.config.hqConfigPath);
    if (!backend) return emptySnapshot("needs-hq-auth", "Connect Penkra HQ to continue");
    this.ensureSocket(backend);
    return this.refresh();
  }

  close(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.backend = null;
    this.connectionKey = null;
  }

  private ensureSocket(backend: PenkraBackendClient): void {
    const connection = backend.socketConnection();
    const key = `${connection.endpoint}\0${connection.token}`;
    if (this.socket && this.connectionKey === key) {
      this.backend = backend;
      return;
    }
    this.close();
    this.backend = backend;
    this.connectionKey = key;
    const socket = io(connection.endpoint, {
      path: "/api/socket.io",
      transports: ["websocket"],
      auth: { token: connection.token },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.25,
    });
    socket.on("connect", () => void this.refresh().catch(() => undefined));
    socket.on("penkra:changed", (change: { entity?: unknown }) => {
      if (change.entity === "client" || change.entity === "instruction") {
        void this.reconcileRegistry().catch(() => undefined);
      }
      void this.refresh().catch(() => undefined);
    });
    socket.on("disconnect", (reason) => this.publishOffline(`Penkra disconnected: ${reason}`));
    socket.on("connect_error", (error) => {
      const needsAuth = error.message.toLowerCase().includes("unauthorized");
      this.publishStatus(needsAuth ? "needs-hq-auth" : "offline", error.message);
    });
    this.socket = socket;
  }

  private refresh(): Promise<PenkraSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    const backend = this.backend;
    if (!backend)
      return Promise.resolve(emptySnapshot("needs-hq-auth", "Connect Penkra HQ to continue"));
    this.refreshPromise = backend
      .getSnapshot()
      .then((snapshot) => {
        const ready: PenkraSnapshot = { status: "ready", message: null, ...snapshot };
        this.latest = ready;
        this.publish(ready);
        return ready;
      })
      .catch((error: unknown) => {
        const status =
          error instanceof PenkraApiError && error.status === 401 ? "needs-hq-auth" : "offline";
        const snapshot = this.publishStatus(
          status,
          error instanceof Error ? error.message : "Penkra snapshot refresh failed",
        );
        return snapshot;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private publishOffline(message: string): PenkraSnapshot {
    return this.publishStatus("offline", message);
  }

  private publishStatus(status: "needs-hq-auth" | "offline", message: string): PenkraSnapshot {
    const snapshot = this.latest
      ? { ...this.latest, status, message }
      : emptySnapshot(status, message);
    this.latest = snapshot;
    this.publish(snapshot);
    return snapshot;
  }
}

function emptySnapshot(
  status: "disabled" | "needs-hq-auth" | "offline",
  message: string,
): PenkraSnapshot {
  return {
    status,
    generatedAt: null,
    message,
    clients: [],
    todos: [],
    programWarnings: [],
  };
}
