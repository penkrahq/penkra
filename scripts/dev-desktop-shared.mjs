// FILE: dev-desktop-shared.mjs
// Purpose: Own the renderer, desktop, and server watch pipeline shared by all Dev instances.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bunExecutable = process.env.BUN_EXECUTABLE?.trim() || process.execPath;
const children = new Set();
let stopping = false;

function start(args, cwd) {
  const child = spawn(bunExecutable, args, { cwd, env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  await Promise.allSettled(
    [...children].map(
      (child) =>
        new Promise((resolveExit) => {
          child.once("exit", resolveExit);
        }),
    ),
  );
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 0)));
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void stop(signal).finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

// The desktop and server bundles import the workspace SDK through its package
// exports, which point at dist. Build that dependency before either consumer
// starts, then keep it current for the lifetime of the shared Dev pipeline.
const sdkDirectory = resolve(repoRoot, "packages/sdk");
console.log("[penkra-dev-shared] Building the App SDK prerequisite.");
const sdkBuild = start(["run", "build"], sdkDirectory);
const sdkBuildExitCode = await waitForExit(sdkBuild);
if (sdkBuildExitCode !== 0) {
  console.error(`[penkra-dev-shared] App SDK build failed with exit code ${sdkBuildExitCode}.`);
  await stop();
  process.exitCode = sdkBuildExitCode;
} else {
  console.log("[penkra-dev-shared] App SDK ready; starting shared watch services.");
  const sdkBundle = start(["run", "dev:bundle"], sdkDirectory);

  const renderer = start(
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5733", "--strictPort"],
    resolve(repoRoot, "apps/web"),
  );
  const desktopBundle = start(["run", "dev:bundle"], resolve(repoRoot, "apps/desktop"));
  const serverBundle = start(["run", "dev:bundle"], resolve(repoRoot, "apps/server"));

  const exitCode = await Promise.race(
    [sdkBundle, renderer, desktopBundle, serverBundle].map(waitForExit),
  );
  await stop();
  process.exitCode = exitCode;
}
