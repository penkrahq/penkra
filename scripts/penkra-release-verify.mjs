#!/usr/bin/env node
import { spawn } from "node:child_process";

const groups = [
  {
    label: "Repository contracts",
    checks: [
      ["Brand identity", "bun", ["run", "brand:check"]],
      ["Formatting", "bun", ["run", "fmt:check"]],
      ["Lint", "bun", ["run", "lint"]],
      ["Typecheck", "bun", ["run", "typecheck"]],
      ["Migration lineage", "bun", ["run", "migrations:check"]],
      ["Release smoke", "bun", ["run", "release:smoke"]],
    ],
  },
  {
    label: "Runtime behavior",
    checks: [["Tests", "bun", ["run", "test"]]],
  },
  {
    label: "Production build",
    checks: [["Desktop pipeline and compiler contract", "bun", ["run", "build:desktop"]]],
  },
  {
    label: "Browser behavior",
    checks: [
      [
        "Browser ChatView",
        "bun",
        ["run", "--cwd", "apps/web", "test:browser:chat-view"],
        { VITEST_BROWSER_API_PORT: "51100" },
      ],
      [
        "Browser components",
        "bun",
        ["run", "--cwd", "apps/web", "test:browser:components"],
        { VITEST_BROWSER_API_PORT: "51101" },
      ],
    ],
  },
];

function runCheck([label, command, args, extraEnvironment = {}], signal) {
  const startedAt = Date.now();
  process.stdout.write(`[release:verify] ${label}...\n`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment },
      signal,
    });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (status, signal) => {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (status !== 0) {
        settle(
          reject,
          new Error(
            `${label} failed after ${durationSeconds}s${signal ? ` (signal ${signal})` : ""}`,
          ),
        );
        return;
      }
      process.stdout.write(`[release:verify] ${label} passed in ${durationSeconds}s.\n`);
      settle(resolve, undefined);
    });
  });
}

async function runGroup(group) {
  const controller = new AbortController();
  let primaryFailure;
  const checks = group.checks.map((check) =>
    runCheck(check, controller.signal).catch((error) => {
      if (primaryFailure === undefined) {
        primaryFailure = error;
        controller.abort();
      }
      throw error;
    }),
  );
  await Promise.allSettled(checks);
  if (primaryFailure !== undefined) throw primaryFailure;
}

const startedAt = Date.now();
for (const group of groups) {
  const groupStartedAt = Date.now();
  process.stdout.write(
    `[release:verify] ${group.label}: ${group.checks.length} parallel checks.\n`,
  );
  await runGroup(group);
  process.stdout.write(
    `[release:verify] ${group.label} passed in ${((Date.now() - groupStartedAt) / 1000).toFixed(1)}s.\n`,
  );
}
process.stdout.write(
  `[release:verify] All checks passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
);
