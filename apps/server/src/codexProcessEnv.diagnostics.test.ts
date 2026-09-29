import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./diagnostics/recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./diagnostics/recorder";
import { prepareManagedCodexProfileConfig } from "./codexProcessEnv";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.mocked(recordDiagnosticIncident).mockClear();
});

describe("Codex profile filesystem diagnostics", () => {
  it("records a non-ENOENT stat failure and continues the optional profile setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-codex-config-diagnostic-"));
    roots.push(root);
    const sourceHomePath = path.join(root, "source");
    const codexHome = path.join(root, "overlay");
    await fs.mkdir(sourceHomePath);
    await fs.symlink("computer-use", path.join(sourceHomePath, "computer-use"));

    await expect(
      prepareManagedCodexProfileConfig({
        env: { CODEX_HOME: codexHome },
        sourceHomePath,
      }),
    ).resolves.toBeUndefined();
    expect(recordDiagnosticIncident).toHaveBeenCalledTimes(1);
    expect(recordDiagnosticIncident).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EXTERNAL_CALL_FAILED", where: "server.codex_config" }),
    );
  });
});
