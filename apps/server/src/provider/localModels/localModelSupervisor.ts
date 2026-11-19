// FILE: localModelSupervisor.ts
// Purpose: Runs at most one mlx_lm.server on loopback for the Local provider.
// Restarts it when it dies (including MLX's "generation thread died", after
// which the process stays up but answers every request with 404), and unloads
// it after an idle period.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface LocalModelServerSpec {
  readonly modelId: string;
  /** Python executable of the managed MLX environment. */
  readonly pythonPath: string;
  /** Local directory holding the model weights. */
  readonly modelPath: string;
}

export interface LocalModelSupervisorOptions {
  readonly idleUnloadMs?: number;
  readonly startTimeoutMs?: number;
  readonly spawnProcess?: (command: string, args: string[]) => ChildProcess;
  readonly fetchImpl?: typeof fetch;
  readonly freePort?: () => Promise<number>;
  readonly log?: (message: string) => void;
}

interface Running {
  readonly spec: LocalModelServerSpec;
  readonly child: ChildProcess;
  readonly baseUrl: string;
  dead: boolean;
}

// Long prompts are fed in small steps so no single GPU command buffer runs
// long enough to trip the macOS watchdog (see benchmarks FINDINGS.md).
const PREFILL_STEP_SIZE = 512;

export class LocalModelSupervisor {
  #running: Running | null = null;
  #starting: Promise<Running> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #idleUnloadMs: number;
  readonly #startTimeoutMs: number;
  readonly #spawn: NonNullable<LocalModelSupervisorOptions["spawnProcess"]>;
  readonly #fetch: typeof fetch;
  readonly #freePort: () => Promise<number>;
  readonly #log: (message: string) => void;

  constructor(options: LocalModelSupervisorOptions = {}) {
    this.#idleUnloadMs = options.idleUnloadMs ?? 10 * 60_000;
    this.#startTimeoutMs = options.startTimeoutMs ?? 120_000;
    this.#spawn =
      options.spawnProcess ??
      ((command, args) => spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }));
    this.#fetch = options.fetchImpl ?? fetch;
    this.#freePort = options.freePort ?? findFreeLoopbackPort;
    this.#log = options.log ?? (() => {});
  }

  /** Returns the OpenAI-compatible base URL (".../v1") for the model, starting or switching servers as needed. */
  async ensure(spec: LocalModelServerSpec): Promise<string> {
    this.#touch();
    const current = this.#running;
    if (current && !current.dead && current.spec.modelId === spec.modelId) return current.baseUrl;
    if (this.#starting) {
      const started = await this.#starting.catch(() => null);
      if (started && !started.dead && started.spec.modelId === spec.modelId) return started.baseUrl;
    }
    await this.stop();
    this.#starting = this.#start(spec);
    try {
      this.#running = await this.#starting;
      return this.#running.baseUrl;
    } finally {
      this.#starting = null;
    }
  }

  /** Marks the current server dead after a request failed so the next ensure() restarts it. */
  reportFailure(modelId: string): void {
    if (this.#running?.spec.modelId === modelId) this.#markDead(this.#running);
  }

  async stop(): Promise<void> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.dead = true;
    await terminate(running.child);
  }

  async #start(spec: LocalModelServerSpec): Promise<Running> {
    const port = await this.#freePort();
    const child = this.#spawn(spec.pythonPath, [
      "-m",
      "mlx_lm.server",
      "--model",
      spec.modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--prefill-step-size",
      String(PREFILL_STEP_SIZE),
    ]);
    const running: Running = { spec, child, baseUrl: `http://127.0.0.1:${port}/v1`, dead: false };
    child.once("exit", (code) => {
      this.#log(`local model server for ${spec.modelId} exited (${code})`);
      running.dead = true;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      if (text.includes("generation thread died")) {
        this.#log(`local model server for ${spec.modelId}: generation thread died`);
        this.#markDead(running);
      }
    });

    const deadline = Date.now() + this.#startTimeoutMs;
    while (Date.now() < deadline) {
      if (running.dead) throw new Error(`The ${spec.modelId} model server stopped while starting.`);
      try {
        const response = await this.#fetch(`${running.baseUrl}/models`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return running;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await terminate(child);
    throw new Error(`The ${spec.modelId} model server did not start in time.`);
  }

  #markDead(running: Running): void {
    if (running.dead) return;
    running.dead = true;
    void terminate(running.child);
  }

  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.stop(), this.#idleUnloadMs);
    this.#idleTimer.unref?.();
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}
