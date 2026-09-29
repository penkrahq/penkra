import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installDiagnosticsStore } from "../diagnostics/recorder.ts";
import { DiagnosticsStore, openDiagnosticsReader } from "../diagnostics/store.ts";
import { gatewayMcpToolErrorResult } from "./gatewayFailureDiagnostics.ts";
import { ToolInputError } from "./toolInput.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("gateway consumed failures", () => {
  it("records operational failures and input rejections without their error text", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-gateway-incidents-"));
    roots.push(stateDir);
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const uninstall = installDiagnosticsStore(store);
    try {
      expect(gatewayMcpToolErrorResult(new Error("private path /secret/file"))).toMatchObject({
        isError: true,
      });
      gatewayMcpToolErrorResult(new ToolInputError("invalid argument"));
      const reader = openDiagnosticsReader(stateDir)!;
      expect(
        reader.prepare("SELECT code, where_name, expected_json, actual_json FROM incidents").all(),
      ).toEqual([
        {
          code: "APP_OPERATION_FAILED",
          where_name: "agent.mcp_write",
          expected_json: '{"accepted":true}',
          actual_json: '{"accepted":false}',
        },
        {
          code: "COMMAND_REJECTED",
          where_name: "agent.mcp_write",
          expected_json: '{"accepted":true}',
          actual_json: '{"accepted":false}',
        },
      ]);
      expect(JSON.stringify(reader.prepare("SELECT * FROM incidents").all())).not.toContain(
        "/secret/file",
      );
      reader.close();
    } finally {
      uninstall();
      store.close();
    }
  });
});
