import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeOpenCodeConversationExport,
  importOpenCodeConversation,
  type OpenCodeConversationExport,
} from "./openCodeConversationTransfer.ts";

async function fixture(
  run: (root: string, conversation: OpenCodeConversationExport) => Promise<void>,
) {
  const scratch = path.resolve(import.meta.dirname, "../../../../.penkra/scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "opencode-transfer-"));
  try {
    await mkdir(path.join(root, "source"));
    const conversation = {
      info: {
        id: "ses_test",
        projectID: "global",
        directory: root,
        slug: "plan",
        time: { created: 1, updated: 1 },
      },
      messages: [
        {
          info: { id: "msg_test", sessionID: "ses_test", role: "user" },
          parts: [
            {
              type: "text",
              id: "prt_test",
              sessionID: "ses_test",
              messageID: "msg_test",
              text: "original",
            },
          ],
        },
      ],
    } as unknown as OpenCodeConversationExport;
    await run(root, conversation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("OpenCode verified import", () => {
  it("does not delete a target when an owned file cannot be preserved", async () =>
    fixture(async (root, conversation) => {
      let deletes = 0;
      const broken = {
        ...conversation,
        messages: [
          {
            ...conversation.messages[0]!,
            parts: [
              {
                type: "tool",
                id: "prt_test",
                messageID: "msg_test",
                sessionID: "ses_test",
                state: {
                  status: "completed",
                  output: "missing",
                  metadata: { outputPath: path.join(root, "source", "missing") },
                },
              },
            ],
          },
        ],
      } as unknown as OpenCodeConversationExport;
      await expect(
        importOpenCodeConversation({
          conversation: broken,
          sourceDataRoot: path.join(root, "source"),
          targetDataRoot: path.join(root, "target"),
          worktree: root,
          temporaryRoot: path.join(root, "temporary"),
          env: {},
          signal: new AbortController().signal,
          deleteTarget: async () => {
            deletes++;
          },
          exportConversation: async () => {
            throw new Error("Must not export");
          },
          command: async () => {
            throw new Error("Must not import");
          },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(deletes).toBe(0);
      expect(await readdir(path.join(root, "temporary"))).toEqual([]);
    }));

  it("preserves a native global plan and verifies the full exported records", async () =>
    fixture(async (root, conversation) => {
      await mkdir(path.join(root, "source", "plans"));
      await writeFile(path.join(root, "source", "plans", "1-plan.md"), "Plan contents");
      let imported: OpenCodeConversationExport | undefined;
      const calls: string[] = [];
      await importOpenCodeConversation({
        conversation,
        sourceDataRoot: path.join(root, "source"),
        targetDataRoot: path.join(root, "target"),
        worktree: root,
        temporaryRoot: path.join(root, "temporary"),
        env: {},
        signal: new AbortController().signal,
        deleteTarget: async () => {
          calls.push("delete");
        },
        command: async (args) => {
          calls.push(args[1]!);
          if (args[1] === "import") imported = JSON.parse(await readFile(args[2]!, "utf8"));
          return {
            code: 0,
            stderr: "",
            stdout: args[1] === "export" ? JSON.stringify(imported) : "",
          };
        },
        exportConversation: async () => {
          calls.push("export");
          return imported!;
        },
      });
      expect(calls).toEqual(["delete", "import", "export"]);
      expect(await readFile(path.join(root, "target", "plans", "1-plan.md"), "utf8")).toBe(
        "Plan contents",
      );
      expect(await readFile(path.join(root, "source", "plans", "1-plan.md"), "utf8")).toBe(
        "Plan contents",
      );
      expect(await readdir(path.join(root, "temporary"))).toEqual([]);
    }));

  it("rejects a verification mismatch instead of claiming the move succeeded", async () =>
    fixture(async (root, conversation) => {
      const corrupted = { ...conversation, messages: [] };
      await expect(
        importOpenCodeConversation({
          conversation,
          sourceDataRoot: path.join(root, "source"),
          targetDataRoot: path.join(root, "target"),
          worktree: root,
          temporaryRoot: path.join(root, "temporary"),
          env: {},
          signal: new AbortController().signal,
          deleteTarget: async () => {},
          exportConversation: async () => corrupted,
          command: async (args) => ({
            code: 0,
            stderr: "",
            stdout: args[1] === "export" ? JSON.stringify(corrupted) : "",
          }),
        }),
      ).rejects.toThrow("does not match");
      expect(await readdir(path.join(root, "temporary"))).toEqual([]);
    }));

  it("rejects a native part owned by another conversation", async () =>
    fixture(async (_root, conversation) => {
      const wrong = {
        ...conversation,
        messages: [
          {
            ...conversation.messages[0]!,
            parts: [{ ...conversation.messages[0]!.parts[0]!, sessionID: "ses_other" }],
          },
        ],
      };
      expect(() => decodeOpenCodeConversationExport(wrong, "ses_test")).toThrow(
        "different native owner",
      );
    }));
});
