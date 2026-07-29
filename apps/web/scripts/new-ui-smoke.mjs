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

async function box(page, name) {
  const bounds = await pencilFrame(page)
    .locator(`[data-pencil-name="${name}"]`)
    .first()
    .boundingBox();
  if (!bounds) throw new Error(`Expected "${name}" to have visible bounds.`);
  return bounds;
}

async function expectResponsiveWorkspace(page) {
  await page.setViewportSize({ width: 1512, height: 900 });
  const fontSize = await pencilFrame(page)
    .locator('[data-pencil-name="Brand"]')
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);

  await page.setViewportSize({ width: 1000, height: 700 });
  const root = await box(page, "Main — 3 rails");
  const sidebar = await box(page, "Sidebar");
  const resizedFontSize = await pencilFrame(page)
    .locator('[data-pencil-name="Brand"]')
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);

  if (root.width !== 1000 || root.height !== 700) {
    throw new Error(`Workspace did not fill 1000x700 viewport: ${root.width}x${root.height}.`);
  }
  if (sidebar.width !== 240 || sidebar.height !== 700) {
    throw new Error(`Sidebar geometry changed unexpectedly: ${sidebar.width}x${sidebar.height}.`);
  }
  if (resizedFontSize !== fontSize) {
    throw new Error(`Typography scaled during resize: ${fontSize} became ${resizedFontSize}.`);
  }
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
  await expectResponsiveWorkspace(page);

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

  stage = "compact settings";
  await page.setViewportSize({ width: 840, height: 620 });
  const settingsModal = await box(page, "Settings Modal");
  if (settingsModal.width > 808 || settingsModal.height > 588) {
    throw new Error(
      `Settings modal exceeds compact viewport: ${settingsModal.width}x${settingsModal.height}.`,
    );
  }

  stage = "compact onboarding";
  await page.goto(`${origin}/?phase=welcome`);
  await expectFrame(page, "Welcome");
  const onboardingPanel = await box(page, "Onboarding Panel");
  const brandPanelDisplay = await pencilFrame(page)
    .locator('[data-pencil-name="Brand Panel"]')
    .first()
    .evaluate((element) => getComputedStyle(element).display);
  if (onboardingPanel.width > 808 || onboardingPanel.height > 588 || brandPanelDisplay !== "none") {
    throw new Error(
      `Onboarding did not adapt at 840x620: ${onboardingPanel.width}x${onboardingPanel.height}, brand=${brandPanelDisplay}.`,
    );
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

  stage = "macOS window chrome";
  const chromePage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await chromePage.addInitScript(() => {
    window.desktopBridge = {
      getZoomFactor: () => 1,
      onZoomFactorChange: () => () => undefined,
      windowControls: {
        getState: async () => ({ isMaximized: false, isFullscreen: false }),
        onState: (listener) => {
          window.__emitDesktopWindowState = listener;
          return () => {
            delete window.__emitDesktopWindowState;
          };
        },
      },
    };
  });
  await chromePage.goto(`${origin}/?phase=workspace`);
  const windowedChrome = await chromePage
    .locator(".pencil-stage")
    .getAttribute("data-window-chrome");
  const windowedFrame = await chromePage.locator("iframe").boundingBox();
  const windowedBrand = await pencilFrame(chromePage)
    .locator(
      '[data-pencil-name="Sidebar"] > [data-pencil-name="Header"] > [data-pencil-name="Brand"]',
    )
    .boundingBox();
  const windowedSearch = await pencilFrame(chromePage)
    .locator(
      '[data-pencil-name="Sidebar"] > [data-pencil-name="Header"] > [data-pencil-name="Search"]',
    )
    .boundingBox();
  const windowedBrandCenter = windowedBrand
    ? windowedBrand.y + windowedBrand.height / 2
    : undefined;
  const windowedSearchCenter = windowedSearch
    ? windowedSearch.y + windowedSearch.height / 2
    : undefined;
  if (
    windowedChrome !== "macos-windowed" ||
    windowedFrame?.y !== 0 ||
    windowedBrand?.x !== 90 ||
    windowedBrandCenter !== 23 ||
    windowedSearchCenter !== 23
  ) {
    throw new Error(
      `Windowed macOS traffic-light alignment is wrong: mode=${windowedChrome}, frameY=${windowedFrame?.y}, brandX=${windowedBrand?.x}, brandCenter=${windowedBrandCenter}, searchCenter=${windowedSearchCenter}.`,
    );
  }

  await chromePage.evaluate(() => {
    window.__emitDesktopWindowState?.({ isMaximized: false, isFullscreen: true });
  });
  await chromePage.locator('.pencil-stage[data-window-chrome="flush"]').waitFor();
  const fullscreenFrame = await chromePage.locator("iframe").boundingBox();
  const fullscreenBrand = await pencilFrame(chromePage)
    .locator(
      '[data-pencil-name="Sidebar"] > [data-pencil-name="Header"] > [data-pencil-name="Brand"]',
    )
    .boundingBox();
  const fullscreenBrandCenter = fullscreenBrand
    ? fullscreenBrand.y + fullscreenBrand.height / 2
    : undefined;
  if (fullscreenFrame?.y !== 0 || fullscreenBrand?.x !== 10 || fullscreenBrandCenter !== 23) {
    throw new Error(
      `Fullscreen macOS chrome did not restore Pencil geometry: frameY=${fullscreenFrame?.y}, brandX=${fullscreenBrand?.x}, brandCenter=${fullscreenBrandCenter}.`,
    );
  }
  await chromePage.close();

  process.stdout.write(
    "Penkra new UI smoke passed: onboarding → workspace → settings → permission → window chrome\n",
  );
} catch (error) {
  process.stderr.write(`Penkra new UI smoke failed during ${stage}.\n`);
  throw error;
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
}
