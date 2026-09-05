#!/usr/bin/env node
// FILE: verify-desktop-app-controller-bundle.ts
// Purpose: Proves the built App controller is a standalone Node entrypoint.
// Layer: Desktop build verification

import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../apps/desktop/dist-electron/appNodeControllerRunner.js",
);
// Resolve the executable from the workspace that owns Electron. Bun may hoist
// it at the repository root locally, but a clean workspace install is allowed
// to keep it beneath apps/desktop/node_modules.
const requireDesktop = createRequire(resolve(SCRIPT_DIRECTORY, "../apps/desktop/package.json"));

export function inspectDesktopAppControllerBundle(source: string): string[] {
  const failures: string[] = [];
  if (/\brequire\(\s*["']electron["']\s*\)/.test(source)) {
    failures.push("imports the Electron runtime");
  }
  if (/\brequire\(\s*["']\.\//.test(source)) {
    failures.push("depends on a sibling CommonJS chunk");
  }
  if (/\b(?:import|export)\s+(?:[^"']+\s+from\s+)?["']\.\//.test(source)) {
    failures.push("depends on a sibling ES module chunk");
  }
  return failures;
}

function waitForControllerReady(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const timeout = setTimeout(
      () => settle(new Error(`App controller handshake timed out.\n${stderr()}`)),
      5_000,
    );
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const type = (message as { type?: unknown }).type;
      if (type === "ready") settle();
      if (type === "startup-error") {
        const detail = (message as { message?: unknown }).message;
        settle(new Error(typeof detail === "string" ? detail : "App controller startup failed."));
      }
    });
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      settle(
        new Error(
          `App controller exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).\n${stderr()}`,
        ),
      );
    });
  });
}

function waitForControllerResult(
  child: ChildProcess,
  requestId: string,
  stderr: () => string,
): Promise<unknown> {
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    const settle = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) rejectResult(error);
      else resolveResult(result);
    };
    const timeout = setTimeout(
      () => settle(new Error(`App controller operation timed out.\n${stderr()}`)),
      10_000,
    );
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const response = message as {
        type?: unknown;
        id?: unknown;
        result?: unknown;
        code?: unknown;
        message?: unknown;
      };
      if (response.id !== requestId) return;
      if (response.type === "result") settle(undefined, response.result);
      if (response.type === "error") {
        settle(
          new Error(
            `App controller operation failed (${String(response.code)}): ${String(response.message)}.\n${stderr()}`,
          ),
        );
      }
    };
    const onError = (error: Error) => settle(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(
        new Error(
          `App controller exited during operation (code=${code ?? "null"}, signal=${signal ?? "null"}).\n${stderr()}`,
        ),
      );
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertControllerSmokeResult(value: unknown): void {
  const result = requireRecord(value, "Controller smoke result");
  if (result.file !== "controller-file-ok") {
    throw new Error(`Controller filesystem smoke failed: ${JSON.stringify(result.file)}.`);
  }
  if (result.network !== "controller-network-ok") {
    throw new Error(`Controller network smoke failed: ${JSON.stringify(result.network)}.`);
  }
  if (
    result.childProcess !== "controller-child-ok" ||
    result.worker !== "controller-worker-ok" ||
    result.wasi !== true
  ) {
    throw new Error(`Controller Node capability smoke failed: ${JSON.stringify(result)}.`);
  }
  // A missing binary must reach the loader, not fail at a permission gate.
  // This is a loader-access check, not proof of compatibility with every add-on.
  if (result.nativeAddon !== "ERR_DLOPEN_FAILED")
    throw new Error(`Controller native loader is unavailable: ${String(result.nativeAddon)}.`);
}

function resolveElectronExecutable(): string {
  const executable = requireDesktop("electron");
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw new Error("The Electron package did not resolve to an executable path.");
  }
  return executable;
}

async function stopController(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  child.kill();
  await exited;
}

export async function verifyDesktopAppControllerBundle(
  runnerPath = DEFAULT_RUNNER_PATH,
): Promise<void> {
  const source = readFileSync(runnerPath, "utf8");
  const failures = inspectDesktopAppControllerBundle(source);
  if (failures.length > 0) {
    throw new Error(`Desktop App controller bundle ${failures.join(" and ")}.`);
  }

  const root = mkdtempSync(join(tmpdir(), "penkra-app-controller-bundle-"));
  const operationPath = join(root, "operations.js");
  const filePath = join(root, "controller-file.txt");
  const nativeAddonPath = join(root, "missing-native-addon.node");
  writeFileSync(
    operationPath,
    `import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { Worker } from "node:worker_threads";

globalThis.penkra.operations.handle("verification.smoke", async (input) => {
  await writeFile(input.filePath, "controller-file-ok", "utf8");
  const file = await readFile(input.filePath, "utf8");
  const network = await fetch(input.networkUrl).then((response) => response.text());
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write('controller-child-ok')"], { encoding: "utf8" });
  if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr);
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage('controller-worker-ok')", { eval: true });
  let workerResult;
  try {
    workerResult = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error("Worker exited: " + code)); });
    });
  } finally { await worker.terminate(); }
  let nativeAddon;
  try { process.dlopen({ exports: {} }, input.nativeAddonPath); }
  catch (error) { nativeAddon = error.code; }
  return {
    file,
    network,
    childProcess: child.stdout,
    worker: workerResult,
    wasi: typeof new WASI({ version: "preview1" }).initialize === "function",
    nativeAddon,
  };
});
`,
  );
  let child: ChildProcess | null = null;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("controller-network-ok");
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Controller smoke HTTP server did not expose a TCP address.");
    }
    let stderr = "";
    child = fork(runnerPath, [operationPath, "com.penkra.apps"], {
      cwd: dirname(operationPath),
      execPath: resolveElectronExecutable(),
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    await waitForControllerReady(child, () => stderr);
    const requestId = "verification-smoke";
    child.send({
      type: "request",
      id: requestId,
      method: "controller.invoke",
      input: {
        handler: "verification.smoke",
        input: {
          filePath,
          nativeAddonPath,
          networkUrl: `http://127.0.0.1:${address.port}/`,
        },
        invocation: {
          id: requestId,
          app: "verification",
          operation: "verification.smoke",
          threadId: "verification-thread",
          spaceId: "verification-space",
        },
        caller: { kind: "user" },
      },
    });
    assertControllerSmokeResult(await waitForControllerResult(child, requestId, () => stderr));
  } finally {
    if (child) await stopController(child);
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyDesktopAppControllerBundle();
  console.log("Desktop App controller bundle verification passed.");
}
