#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const checks = [
  ["Brand identity", "bun", ["run", "brand:check"]],
  ["Formatting", "bun", ["run", "fmt:check"]],
  ["Lint", "bun", ["run", "lint"]],
  ["Typecheck", "bun", ["run", "typecheck"]],
  ["Tests", "bun", ["run", "test"]],
  ["Browser tests", "bun", ["run", "--cwd", "apps/web", "test:browser"]],
  ["Desktop pipeline", "bun", ["run", "build:desktop"]],
  ["Release smoke", "bun", ["run", "release:smoke"]],
];

const startedAt = Date.now();
for (const [label, command, args] of checks) {
  const stepStartedAt = Date.now();
  process.stdout.write(`[release:verify] ${label}...\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  const durationSeconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);
  if (result.status !== 0) {
    throw new Error(`${label} failed after ${durationSeconds}s`);
  }
  process.stdout.write(`[release:verify] ${label} passed in ${durationSeconds}s.\n`);
}
process.stdout.write(
  `[release:verify] All checks passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
);
