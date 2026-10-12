import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { outboundHttp, OutboundHttpError } from "@penkra/shared/outboundHttp";
import { afterEach, expect, it, vi } from "vitest";

import { codexUsageFetcher } from "./codex";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of tempDirs.splice(0)) rmSync(home, { recursive: true, force: true });
});
function usageContext() {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-usage-deadline-"));
  tempDirs.push(homeDir);
  const codexHome = path.join(homeDir, ".codex");
  mkdirSync(codexHome);
  writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token" } }),
  );
  return { homeDir, env: {}, platform: "linux" as const, nowMs: 1_780_000_000_000 };
}
it("shows the usage deadline as an error rather than a reconnect request", async () => {
  const timeout = new OutboundHttpError("timeout", "Usage request exceeded its deadline.");
  const request = vi.spyOn(outboundHttp, "request").mockRejectedValue(timeout);
  const snapshot = await codexUsageFetcher.fetch(usageContext());
  expect(snapshot.status).toBe("error");
  expect(snapshot.detail).toBe(timeout.message);
  expect(snapshot.detail).not.toContain("Reconnect");
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0].policy.deadlineMs).toBe(10_000);
});
it("still reports needs-auth for a rejected credential", async () => {
  vi.spyOn(outboundHttp, "request").mockResolvedValue({
    status: 401,
    headers: new Headers(),
    body: new Uint8Array(),
    url: "https://chatgpt.com/backend-api/wham/usage",
  });
  expect((await codexUsageFetcher.fetch(usageContext())).status).toBe("needs-auth");
});
