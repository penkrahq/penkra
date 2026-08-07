// FILE: dev-desktop-shared.mjs
// Purpose: Own the one renderer and desktop-bundle watch pipeline shared by all Dev instances.

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

const renderer = start(
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5733", "--strictPort"],
  resolve(repoRoot, "apps/web"),
);
const desktopBundle = start(["run", "dev:bundle"], resolve(repoRoot, "apps/desktop"));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void stop(signal).finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

const exitCode = await Promise.race(
  [renderer, desktopBundle].map(
    (child) =>
      new Promise((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 0)));
      }),
  ),
);
await stop();
process.exitCode = exitCode;
