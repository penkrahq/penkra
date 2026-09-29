import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { assertIsolatedQaStateDir } from "./seed-scripted-provider.mjs";

const require = createRequire(
  fileURLToPath(new URL("../../apps/web/package.json", import.meta.url)),
);
const { chromium } = require("playwright");
const CHECKS = {
  send: ["send.dispatched", "send.accepted"],
  stop: ["stop.requested", "turn.terminal"],
  play: ["play.requested", "turn.started"],
  queue: ["queue.enqueued", "queue.started"],
  archive: ["archive.requested", "thread.archived"],
  "multi-window": ["window.opened", "window.synced"],
  "thread-create": ["thread.create_requested", "thread.created"],
  reconnect: ["socket.disconnected", "socket.reconnected"],
  "provider-switch": ["provider.switch_requested", "provider.switched"],
};

function threadId(page) {
  const id = new URL(page.url()).hash.match(/^#\/([0-9a-f-]{36})$/u)?.[1];
  if (!id) throw new Error(`Expected a real thread route, got ${page.url()}`);
  return id;
}

async function waitForDetail(stateDir, flow, step, thread, timeoutMs = 12_000) {
  const database = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id FROM detail WHERE flow = ? AND step = ? AND thread_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(flow, step, thread);
      if (row) return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${flow}:${step} on ${thread}`);
}

async function newThread(page, stateDir) {
  const before = page.url();
  const previousId = new URL(before).hash.match(/^#\/([0-9a-f-]{36})$/u)?.[1];
  let previousPersisted = false;
  if (previousId) {
    const db = new DatabaseSync(path.join(stateDir, "diagnostics", "diagnostics.sqlite"), {
      readOnly: true,
    });
    try {
      previousPersisted = !!db
        .prepare("SELECT id FROM detail WHERE flow = ? AND step = ? AND thread_id = ? LIMIT 1")
        .get("thread_create", "thread.created", previousId);
    } finally {
      db.close();
    }
  }
  const newTab = page.getByRole("button", { name: "New thread", exact: true });
  if (await newTab.count()) await newTab.click();
  else await page.getByRole("button", { name: "Create thread in Default" }).first().click();
  if (previousPersisted || !previousId)
    await page.waitForFunction((previous) => location.href !== previous, before);
  else await page.waitForTimeout(150);
  const id = threadId(page);
  if (page.url() === before && previousPersisted)
    throw new Error("New-thread action remained on an existing persisted thread");
  await page.getByRole("textbox").waitFor();
  return id;
}

async function send(page, stateDir, id, message) {
  await page.getByRole("textbox").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await waitForDetail(stateDir, "thread_create", "thread.created", id);
  await waitForDetail(stateDir, "send", "send.accepted", id);
  await page.getByText(message, { exact: true }).first().waitFor();
  if ((await page.getByRole("textbox").innerText()).includes(message))
    throw new Error("The composer did not clear after send admission");
}

async function stop(page, stateDir, id) {
  await page.waitForFunction(
    async (targetId) => {
      const { readNativeApi } = await import("/src/nativeApi.ts");
      const snapshot = await readNativeApi()?.orchestration.getThreadDetailSnapshot({
        threadId: targetId,
      });
      return !!snapshot?.thread.session?.activeTurnId;
    },
    id,
    { polling: 200, timeout: 20_000 },
  );
  await page.waitForFunction(async (targetId) => {
    const [{ useStore }, { getThreadFromState }] = await Promise.all([
      import("/src/store.ts"),
      import("/src/threadDerivation.ts"),
    ]);
    return !!getThreadFromState(useStore.getState(), targetId)?.session?.activeTurnId;
  }, id);
  await page.waitForFunction(async (targetId) => {
    const { getActiveComposerSendPreparation, getComposerDispatchedSendOwner } =
      await import("/src/composerSendPreflight.ts");
    return (
      getActiveComposerSendPreparation(targetId) === null &&
      getComposerDispatchedSendOwner(targetId) === null
    );
  }, id);
  await page.waitForTimeout(1_500);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.getByRole("button", { name: "Stop generation" }).click();
  await waitForDetail(stateDir, "stop", "turn.terminal", id);
  await page.getByRole("button", { name: "Continue" }).waitFor();
}

async function run(flow, page, stateDir) {
  switch (flow) {
    case "thread-create": {
      const id = await newThread(page, stateDir);
      await send(page, stateDir, id, `qa:create-${Date.now()}`);
      return;
    }
    case "send": {
      const id = await newThread(page, stateDir);
      await send(page, stateDir, id, `qa:send-${Date.now()}`);
      return;
    }
    case "stop": {
      const id = await newThread(page, stateDir);
      await send(page, stateDir, id, "qa:hold");
      await stop(page, stateDir, id);
      return;
    }
    case "play": {
      const id = await newThread(page, stateDir);
      await send(page, stateDir, id, "qa:hold");
      await stop(page, stateDir, id);
      await page.getByRole("button", { name: "Continue" }).click();
      await waitForDetail(stateDir, "play", "turn.started", id);
      await page.getByRole("button", { name: "Continue" }).waitFor({ state: "hidden" });
      return;
    }
    case "archive": {
      const id = await newThread(page, stateDir);
      const message = `qa:archive-${Date.now()}`;
      await send(page, stateDir, id, message);
      await page.waitForFunction(async (targetId) => {
        const { useComposerDraftStore } = await import("/src/composerDraftStore.ts");
        return !useComposerDraftStore.getState().draftThreadsByThreadId[targetId];
      }, id);
      await page.waitForFunction(async (targetId) => {
        const { readNativeApi } = await import("/src/nativeApi.ts");
        const snapshot = await readNativeApi()?.orchestration.getThreadDetailSnapshot({
          threadId: targetId,
        });
        return (
          snapshot?.thread?.latestTurn?.state === "completed" &&
          !snapshot.thread.session?.activeTurnId
        );
      }, id);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      // CDP cannot press a macOS NSAlert button. Simulate that one user
      // confirmation; the real archive command and its durable proof still run.
      await page.evaluate(async () => {
        const { readNativeApi } = await import("/src/nativeApi.ts");
        const api = readNativeApi();
        if (!api) throw new Error("Native API is unavailable for archive QA");
        window.__qaArchiveConfirmCount = 0;
        api.dialogs.confirm = async (prompt) => {
          window.__qaArchiveConfirmCount += 1;
          if (!prompt.startsWith('Archive thread "'))
            throw new Error("Unexpected confirmation during archive QA");
          return true;
        };
      });
      await page.getByRole("button", { name: `Archive ${message}` }).click();
      if ((await page.evaluate(() => window.__qaArchiveConfirmCount)) !== 1)
        throw new Error("Archive did not request confirmation for the persisted thread");
      await waitForDetail(stateDir, "archive", "thread.archived", id);
      if (new URL(page.url()).hash === `#/${id}`)
        throw new Error("Archived thread remained selected");
      return;
    }
    default:
      throw new Error(`Playwright QA flow is not implemented: ${flow}`);
  }
}

export async function runPlaywrightQaFlow(flow) {
  const stateDir = process.env.PENKRA_DIAGNOSTICS_QA_STATE_DIR;
  const reportPath = process.env.PENKRA_DIAGNOSTICS_QA_REPORT_PATH;
  if (!stateDir || !reportPath || !(flow in CHECKS)) throw new Error("Invalid QA flow input");
  assertIsolatedQaStateDir(stateDir);
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.PENKRA_DIAGNOSTICS_QA_CDP_PORT ?? "9335"}`,
  );
  try {
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((candidate) => {
        try {
          return new URL(candidate.url()).hostname === "127.0.0.1";
        } catch {
          return false;
        }
      });
    if (!page) throw new Error("No Penkra shell page was found in the isolated Dev instance");
    await run(flow, page, stateDir);
    fs.writeFileSync(reportPath, JSON.stringify({ flow, passed: true, checks: CHECKS[flow] }));
  } finally {
    await browser.close();
  }
}
