// FILE: new-ui-smoke.mjs
// Purpose: Verifies the Pencil-authoritative renderer flow in a production web build.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteExecutable = join(webRoot, "node_modules", ".bin", "vite");
const port = 4178;
const origin = `http://127.0.0.1:${port}`;
let stage = "preview startup";

if (!existsSync(join(webRoot, "dist", "index.html"))) {
  throw new Error("The web build is missing. Run the package build before the new UI smoke test.");
}

const preview = spawn(viteExecutable, ["preview", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: webRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let previewOutput = "";
preview.stdout.on("data", (chunk) => {
  previewOutput += String(chunk);
});
preview.stderr.on("data", (chunk) => {
  previewOutput += String(chunk);
});

async function waitForPreview() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`Vite preview exited with ${preview.exitCode}.\n${previewOutput}`);
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite preview did not become ready.\n${previewOutput}`);
}

function pencilFrame(page) {
  return page.frameLocator("iframe");
}

async function expectFrame(page, expectedName) {
  const actual = await pencilFrame(page)
    .locator("body > [data-pencil-name]")
    .first()
    .getAttribute("data-pencil-name");
  if (actual !== expectedName) {
    throw new Error(`Expected Pencil frame "${expectedName}", received "${actual}".`);
  }
}

async function click(page, name) {
  await pencilFrame(page).locator(`[data-pencil-name="${name}"]`).first().click();
}

let browser;
try {
  await waitForPreview();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 900 } });
  await page.goto(`${origin}/?phase=welcome`);

  stage = "welcome";
  await expectFrame(page, "Welcome");
  await click(page, "Sign In Button");
  await expectFrame(page, "Connect an Agent");

  stage = "agent onboarding";
  await click(page, "Codex");
  await click(page, "Continue Button");
  await expectFrame(page, "Manage Claude Connections");
  await click(page, "Enter API Key Button");
  await expectFrame(page, "Enter API Key");

  stage = "API key onboarding";
  const secretField = pencilFrame(page)
    .locator('[data-pencil-name="Placeholder"]')
    .filter({ hasText: "••" })
    .first();
  await secretField.fill("sk-mock-local-only");
  await click(page, "Save Button");
  await expectFrame(page, "Install Apps");
  await click(page, "Continue Button");
  await expectFrame(page, "Main — 3 rails");

  stage = "settings";
  await click(page, "Account");
  await click(page, "Settings");
  await expectFrame(page, "Settings modal");

  const settingsScreens = [
    ["Permissions Row", "Settings — Permissions"],
    ["Agents Row", "Settings — Agents"],
    ["Apps Row", "Settings — Apps"],
    ["Connectors Row", "Settings — Connectors"],
    ["Appearance Row", "Settings — Appearance"],
    ["Account Row", "Settings — Account"],
    ["General Row", "Settings modal"],
  ];
  for (const [row, expectedFrame] of settingsScreens) {
    await click(page, row);
    await expectFrame(page, expectedFrame);
  }

  stage = "permission sheet";
  await page.goto(`${origin}/?phase=permission`);
  await expectFrame(page, "Permission request");
  const sheetCount = await pencilFrame(page)
    .locator('[data-pencil-name="Permission Sheet — Ledger install"]')
    .count();
  if (sheetCount !== 1) {
    throw new Error(`Expected one permission sheet, received ${sheetCount}.`);
  }

  process.stdout.write(
    "Penkra new UI smoke passed: onboarding → workspace → settings suite → permission\n",
  );
} catch (error) {
  process.stderr.write(`Penkra new UI smoke failed during ${stage}.\n`);
  throw error;
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
}
