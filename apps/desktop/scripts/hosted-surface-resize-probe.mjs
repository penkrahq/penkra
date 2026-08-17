// Measures a Penkra-shaped stack of cross-process surfaces during true live layout:
// a sandboxed App iframe plus Browser's renderer-owned <webview> overlay. No visual
// transforms or snapshots are used; every pointer sample changes the real CSS width.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
const requestedFrames = process.env.PENKRA_HOSTED_SURFACE_PROBE_CAPTURE_FRAMES;
const scenarios = requestedFrames
  ? [
      {
        name: `custom-${requestedFrames}`,
        captureFrames: Number.parseInt(requestedFrames, 10),
        stallMs: Number.parseInt(process.env.PENKRA_HOSTED_SURFACE_PROBE_STALL_MS ?? "45", 10),
      },
    ]
  : [
      { name: "rapid-no-stall", captureFrames: 0, stallMs: 0 },
      { name: "rapid-one-frame-stall", captureFrames: 0, stallMs: 16 },
      { name: "rapid-heavy-stall", captureFrames: 0, stallMs: 45 },
      { name: "rejected-staged-heavy-stall", captureFrames: 0, stallMs: 45 },
      { name: "paced-heavy-stall", captureFrames: 6, stallMs: 45 },
    ];
const results = [];

for (const scenario of scenarios) {
  results.push(await runProbe(scenario));
}

if (!requestedFrames) {
  const rapid = results.find((result) => result.scenario === "rapid-heavy-stall");
  const paced = results.find((result) => result.scenario === "paced-heavy-stall");
  const rejectedStaged = results.find(
    (result) => result.scenario === "rejected-staged-heavy-stall",
  );
  if (!rapid?.observedOuterExposure || !rapid?.observedWebviewExposure) {
    throw new Error("Rapid live layout did not reproduce both hosted-surface exposures.");
  }
  if (paced?.observedOuterExposure || paced?.observedWebviewExposure) {
    throw new Error("The paced control still exposed a hosted-surface edge.");
  }
  if (
    !rejectedStaged?.observedOuterExposure ||
    !rejectedStaged?.observedWebviewExposure ||
    !rejectedStaged?.observedDividerLag ||
    rejectedStaged?.settled.geometry.presentedWidth !==
      rejectedStaged?.settled.geometry.pendingWidth
  ) {
    throw new Error(
      `The rejected staging control did not reproduce its surface exposure: ${JSON.stringify({
        observedOuterExposure: rejectedStaged?.observedOuterExposure,
        observedWebviewExposure: rejectedStaged?.observedWebviewExposure,
        observedDividerLag: rejectedStaged?.observedDividerLag,
        samples: rejectedStaged?.samples.map((sample) => ({
          geometry: sample.geometry,
          outer: sample.outer,
          webview: sample.webview,
        })),
        settled: rejectedStaged?.settled,
      })}`,
    );
  }
  if (results.some((result) => !result.overlayStayedAbove)) {
    throw new Error("The shell overlay fell behind a hosted DOM surface.");
  }
}

console.log(JSON.stringify({ passed: true, electron: results[0]?.electron, results }, null, 2));

async function runProbe(scenario) {
  const probeRoot = mkdtempSync(resolve(tmpdir(), `penkra-hosted-surface-${scenario.name}-`));
  const resultPath = resolve(probeRoot, "result.json");
  const logPath = resolve(probeRoot, "probe.log");
  try {
    const child = spawn(
      electron,
      [resolve(scriptsDirectory, "hosted-surface-resize-probe-child.cjs")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: "1",
          PENKRA_HOSTED_SURFACE_PROBE_CAPTURE_FRAMES: String(scenario.captureFrames),
          PENKRA_HOSTED_SURFACE_PROBE_LOG: logPath,
          PENKRA_HOSTED_SURFACE_PROBE_PROFILE: resolve(probeRoot, "profile"),
          PENKRA_HOSTED_SURFACE_PROBE_RESULT: resultPath,
          PENKRA_HOSTED_SURFACE_PROBE_SCENARIO: scenario.name,
          PENKRA_HOSTED_SURFACE_PROBE_STALL_MS: String(scenario.stallMs),
        },
      },
    );
    let childOutput = "";
    child.stdout.on("data", (chunk) => (childOutput += chunk.toString()));
    child.stderr.on("data", (chunk) => (childOutput += chunk.toString()));
    const outcome = await new Promise((resolveOutcome) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveOutcome({ code, signal });
      });
    });
    if (outcome.signal || outcome.code !== 0) {
      throw new Error(
        `Hosted-surface resize probe failed (${outcome.signal ?? `exit ${outcome.code}`}).\n${tryRead(logPath) ?? "No probe log."}\n${childOutput}`,
      );
    }
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function tryRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
