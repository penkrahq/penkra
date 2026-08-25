#!/usr/bin/env node
// FILE: verify-desktop-app-controller-bundle.ts
// Purpose: Proves the built App controller is a standalone Node entrypoint.
// Layer: Desktop build verification

import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../apps/desktop/dist-electron/appNodeControllerRunner.js",
);

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
  writeFileSync(
    operationPath,
    'globalThis.penkra.operations.handle("verification.ready", async () => null);\n',
  );
  let child: ChildProcess | null = null;
  try {
    let stderr = "";
    child = fork(runnerPath, [operationPath, "com.penkra.apps"], {
      cwd: dirname(operationPath),
      execPath: process.execPath,
      execArgv: ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--no-addons"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    await waitForControllerReady(child, () => stderr);
  } finally {
    if (child) await stopController(child);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyDesktopAppControllerBundle();
  console.log("Desktop App controller bundle verification passed.");
}
