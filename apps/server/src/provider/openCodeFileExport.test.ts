import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportOpenCodeConversation, type OpenCodeExportOwner } from "./openCodeFileExport.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const parent = path.resolve(import.meta.dirname, "../../../../.penkra/scratch");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "file-export-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function conversation(text: string) {
  return {
    info: { id: "ses_test", projectID: "global", directory: process.cwd() },
    messages: [
      {
        info: { id: "msg_test", sessionID: "ses_test" },
        parts: [
          { id: "prt_test", sessionID: "ses_test", messageID: "msg_test", type: "text", text },
        ],
      },
    ],
  };
}
const proved = { escalated: false, signalErrors: [] };

describe("OpenCode file-backed export", () => {
  it("captures large UTF-8 output completely, privately, with exact native identity and cleanup", async () =>
    fixture(async (root) => {
      const text = "世界🦉".repeat(500_000);
      const serialized = JSON.stringify(conversation(text));
      const owners = new Set<OpenCodeExportOwner>();
      let descriptor: number | undefined;
      const result = await exportOpenCodeConversation(
        {
          binaryPath: process.execPath,
          sessionID: "ses_test",
          cwd: root,
          processEnv: process.env,
          temporaryRoot: root,
          signal: new AbortController().signal,
        },
        {
          spawn: (_binary, args, options) => {
            expect(args).toEqual(["--pure", "export", "ses_test"]);
            descriptor = (options.stdio as [string, number, string])[1];
            expect(typeof descriptor).toBe("number");
            return spawn(
              process.execPath,
              [
                "-e",
                `const value=${JSON.stringify(conversation(""))};value.messages[0].parts[0].text="世界🦉".repeat(500000);process.stdout.write(JSON.stringify(value));process.exit(0)`,
              ],
              options,
            );
          },
          registerOwner: (owner) => {
            owners.add(owner);
            return () => {
              owners.delete(owner);
            };
          },
          teardown: async () => proved,
        },
      );
      expect(JSON.stringify(result)).toBe(serialized);
      expect(owners.size).toBe(0);
      expect(await readdir(root)).toEqual([]);
      expect(descriptor).toBeDefined();
    }));

  it.each(["invalid-json", "wrong-owner", "nonzero", "spawn-error"])(
    "fails %s and cleans only its temporary output",
    async (mode) =>
      fixture(async (root) => {
        const output =
          mode === "invalid-json"
            ? "{"
            : JSON.stringify({
                ...conversation("hello"),
                info: { ...conversation("").info, id: "ses_other" },
              });
        const script =
          mode === "nonzero"
            ? "process.exit(7)"
            : `process.stdout.write(${JSON.stringify(output)});process.exit(0)`;
        await expect(
          exportOpenCodeConversation(
            {
              binaryPath: process.execPath,
              sessionID: "ses_test",
              cwd: root,
              processEnv: process.env,
              temporaryRoot: root,
              signal: new AbortController().signal,
            },
            {
              spawn: (_command, _args, options) =>
                mode === "spawn-error"
                  ? spawn(path.join(root, "does-not-exist"), [], options)
                  : spawn(process.execPath, ["-e", script], options),
              teardown: async () => proved,
            },
          ),
        ).rejects.toThrow("OpenCode export failed");
        expect(await readdir(root)).toEqual([]);
      }),
  );

  it("retains the registered owner and private artifact until exit is proven", async () =>
    fixture(async (root) => {
      let retained: OpenCodeExportOwner | undefined;
      let proven = false;
      await expect(
        exportOpenCodeConversation(
          {
            binaryPath: process.execPath,
            sessionID: "ses_test",
            cwd: root,
            processEnv: process.env,
            temporaryRoot: root,
            signal: new AbortController().signal,
          },
          {
            spawn: (_command, _args, options) =>
              spawn(
                process.execPath,
                [
                  "-e",
                  `process.stdout.write(${JSON.stringify(JSON.stringify(conversation("hello")))});process.exit(0)`,
                ],
                options,
              ),
            registerOwner: (owner) => {
              retained = owner;
              return () => {
                retained = undefined;
              };
            },
            teardown: async () => {
              if (!proven) throw new Error("exit unproven");
              return proved;
            },
          },
        ),
      ).rejects.toThrow("exit unproven");
      expect(retained).toBeDefined();
      const entries = await readdir(root);
      expect(entries).toHaveLength(1);
      expect((await stat(path.join(root, entries[0]!, "conversation.json"))).mode & 0o777).toBe(
        0o600,
      );
      proven = true;
      await retained!.stop();
      expect(retained).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    }));

  it("cancels a live export and proves exit before deleting its output", async () =>
    fixture(async (root) => {
      const controller = new AbortController();
      let exitCode: number | null | undefined;
      await expect(
        exportOpenCodeConversation(
          {
            binaryPath: process.execPath,
            sessionID: "ses_test",
            cwd: root,
            processEnv: process.env,
            temporaryRoot: root,
            signal: controller.signal,
          },
          {
            spawn: (_command, _args, options) => {
              const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
                ...options,
                stdio: ["pipe", (options.stdio as [string, number, string])[1], "pipe"],
              });
              child.once("spawn", () => controller.abort());
              return child;
            },
            teardown: async (child) => {
              exitCode = child.exitCode;
              expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
              return proved;
            },
          },
        ),
      ).rejects.toThrow();
      expect(exitCode).not.toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    }));
});
