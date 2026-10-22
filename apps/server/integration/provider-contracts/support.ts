import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildProviderChildEnvironment } from "../../src/providerChildEnvironment.ts";
import {
  PINNED_PROVIDER_RUNTIMES,
  type PinnedProviderKind,
} from "../../src/provider/pinnedProviderRuntimes.ts";
import { teardownChildProcessTree } from "../../src/provider/supervisedProcessTeardown.ts";

export const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const exec = promisify(execFile);

export async function contractFixture(provider: PinnedProviderKind) {
  const binary = process.env.PENKRA_CONTRACT_BINARY;
  assert(
    binary && path.isAbsolute(binary),
    "Set PENKRA_CONTRACT_BINARY to the exact pinned executable.",
  );
  const scratch = path.join(repositoryRoot, ".penkra/scratch/provider-contracts");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, `${provider}-`));
  // One deadline for the whole experiment, never a silence-completion rule.
  const signal = AbortSignal.timeout(90_000);
  const children = new Set<ChildProcessWithoutNullStreams>();
  const environment = (name: string, overrides: NodeJS.ProcessEnv = {}) => {
    const home = path.join(root, name);
    return buildProviderChildEnvironment({
      provider: provider === "claudeAgent" ? "claude" : provider,
      baseEnv: process.env,
      isolation: {
        homePath: home,
        xdgConfigHome: path.join(home, "config"),
        xdgDataHome: path.join(home, "data"),
        xdgCacheHome: path.join(home, "cache"),
        xdgStateHome: path.join(home, "state"),
      },
      overrides,
    });
  };
  const command = (args: string[], cwd = root, env = environment("source")) =>
    exec(binary, args, { cwd, env, signal, maxBuffer: 8 * 1024 * 1024 });
  try {
    const actual = (await command(["--version"])).stdout.trim();
    const expected = PINNED_PROVIDER_RUNTIMES.providers[provider].version;
    assert(
      actual.split(/\s+/).includes(expected),
      `Expected ${provider} ${expected}; executable returned ${actual}`,
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    binary,
    root,
    signal,
    environment,
    command,
    async startServer(args: string[], cwd: string, env: NodeJS.ProcessEnv, ready: RegExp) {
      const child = spawn(binary, args, { cwd, env, stdio: "pipe" });
      children.add(child);
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4000);
      });
      const origin = await new Promise<string>((resolve, reject) => {
        let output = "";
        const onAbort = () => {
          clean();
          reject(signal.reason);
        };
        const onError = (error: Error) => {
          clean();
          reject(error);
        };
        const onExit = (code: number | null) => {
          clean();
          reject(new Error(`Native server exited ${code}: ${diagnostic}`));
        };
        const clean = () => {
          signal.removeEventListener("abort", onAbort);
          child.off("error", onError);
          child.off("exit", onExit);
          child.stdout.off("data", onData);
        };
        const onData = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4000);
          const match = output.match(ready);
          if (match?.[1]) {
            clean();
            resolve(match[1]);
          }
        };
        child.once("error", onError);
        child.once("exit", onExit);
        child.stdout.on("data", onData);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return { child, origin };
    },
    async stop(child: ChildProcessWithoutNullStreams) {
      await teardownChildProcessTree(child);
      children.delete(child);
    },
    async close() {
      // Do not remove a runtime root unless every process is proven stopped.
      for (const child of children) await teardownChildProcessTree(child);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function listen(server: import("node:http").Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

export async function nativeJson<T>(
  origin: string,
  route: string,
  directory: string,
  signal: AbortSignal,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${origin}${route}?directory=${encodeURIComponent(directory)}`, {
    signal,
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  assert(response.ok, `${method} ${route}: ${response.status} ${raw}`);
  return (raw ? JSON.parse(raw) : undefined) as T;
}

export interface NativeEvent {
  directory: string;
  payload: { type: string; properties: Record<string, unknown> };
}

/** Capture actual ordered SSE facts. No polling or inferred idle windows. */
export async function nativeEventJournal(origin: string, signal: AbortSignal) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const response = await fetch(`${origin}/global/event`, { signal: combined });
  assert(response.ok && response.body, "Native global event stream did not open.");
  const reader = response.body.getReader();
  const events: NativeEvent[] = [];
  const waiters = new Set<{
    predicate: (event: NativeEvent) => boolean;
    resolve: (event: NativeEvent) => void;
    reject: (error: unknown) => void;
  }>();
  let failure: unknown;
  const consuming = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) throw new Error("Native event stream ended before journal close.");
        pending += decoder.decode(next.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const event = JSON.parse(data) as NativeEvent;
          assert.equal(typeof event.payload?.type, "string");
          events.push(event);
          for (const waiter of waiters)
            if (waiter.predicate(event)) {
              waiters.delete(waiter);
              waiter.resolve(event);
            }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = error;
        for (const waiter of waiters) waiter.reject(error);
        waiters.clear();
      }
    }
  })();
  return {
    events,
    waitFor(predicate: (event: NativeEvent) => boolean) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      if (failure) return Promise.reject(failure);
      return new Promise<NativeEvent>((resolve, reject) => {
        waiters.add({ predicate, resolve, reject });
      });
    },
    async close() {
      controller.abort();
      await consuming;
      if (failure) throw failure;
    },
  };
}
