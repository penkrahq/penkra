import type { PenkraSnapshot } from "@penkra/contracts";
import { io, type Socket } from "socket.io-client";

import type { PenkraRuntimeConfig } from "./config";
import { PenkraApiError, PenkraBackendClient } from "./backendClient";

type PenkraChange = {
  entity?: unknown;
  id?: unknown;
};

export type PenkraReconciliationFailure = {
  phase: "connect" | "change";
  entity: string | null;
  id: string | null;
  error: Error;
};

export class PenkraSocketClient {
  private socket: Socket | null = null;
  private backend: PenkraBackendClient | null = null;
  private connectionKey: string | null = null;
  private latest: PenkraSnapshot | null = null;
  private refreshPromise: Promise<PenkraSnapshot> | null = null;
  private refreshAgain = false;

  constructor(
    private readonly config: PenkraRuntimeConfig | null,
    private readonly publish: (snapshot: PenkraSnapshot) => void,
    private readonly reconcileRegistry: () => Promise<void> = () => Promise.resolve(),
    private readonly reportReconciliationFailure: (
      failure: PenkraReconciliationFailure,
    ) => void = defaultReconciliationFailureReporter,
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
    socket.on("connect", () => void this.synchronize("connect"));
    socket.on("penkra:changed", (change: PenkraChange) => void this.handleChange(change));
    socket.on("disconnect", (reason) => this.publishOffline(`Penkra disconnected: ${reason}`));
    socket.on("connect_error", (error) => {
      const needsAuth = error.message.toLowerCase().includes("unauthorized");
      this.publishStatus(needsAuth ? "needs-hq-auth" : "offline", error.message);
    });
    this.socket = socket;
  }

  private async handleChange(change: PenkraChange): Promise<void> {
    const entity = typeof change.entity === "string" ? change.entity : null;
    if (entity === "client" || entity === "instruction") {
      await this.reconcile("change", change);
    }
    await this.refresh();
  }

  private async synchronize(phase: "connect"): Promise<void> {
    await this.reconcile(phase, null);
    await this.refresh();
  }

  private async reconcile(
    phase: PenkraReconciliationFailure["phase"],
    change: PenkraChange | null,
  ): Promise<void> {
    try {
      await this.reconcileRegistry();
    } catch (cause) {
      this.reportReconciliationFailure({
        phase,
        entity: typeof change?.entity === "string" ? change.entity : null,
        id: typeof change?.id === "string" ? change.id : null,
        error:
          cause instanceof Error ? cause : new Error("Penkra reconciliation failed", { cause }),
      });
    }
  }

  private refresh(): Promise<PenkraSnapshot> {
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      let snapshot: PenkraSnapshot;
      do {
        this.refreshAgain = false;
        snapshot = await this.fetchSnapshot();
      } while (this.refreshAgain);
      return snapshot;
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async fetchSnapshot(): Promise<PenkraSnapshot> {
    const backend = this.backend;
    if (!backend) return emptySnapshot("needs-hq-auth", "Connect Penkra HQ to continue");
    try {
      const snapshot = await backend.getSnapshot();
      const ready: PenkraSnapshot = { status: "ready", message: null, ...snapshot };
      this.latest = ready;
      this.publish(ready);
      return ready;
    } catch (error) {
      const status =
        error instanceof PenkraApiError && error.status === 401 ? "needs-hq-auth" : "offline";
      return this.publishStatus(
        status,
        error instanceof Error ? error.message : "Penkra snapshot refresh failed",
      );
    }
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

function defaultReconciliationFailureReporter(failure: PenkraReconciliationFailure): void {
  console.warn("Penkra registry reconciliation failed", failure);
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
