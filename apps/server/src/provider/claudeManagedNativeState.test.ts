import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import {
  resolveClaudeSessionCandidate,
  synchronizeClaudeSessions,
} from "./claudeManagedNativeState.ts";

const roots: string[] = [];

async function profile(): Promise<string> {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-profile-"));
  roots.push(root);
  return root;
}

async function transcript(input: {
  readonly root: string;
  readonly sessionId: string;
  readonly lines: readonly unknown[];
}): Promise<string> {
  const directory = Path.join(input.root, "claude-config", "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  const path = Path.join(directory, `${input.sessionId}.jsonl`);
  await writeFile(path, `${input.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude managed native state", () => {
  it("selects a real conversation over a newer metadata-only resume stub", async () => {
    const real = await profile();
    const stub = await profile();
    const sessionId = "session-real";
    const realPath = await transcript({
      root: real,
      sessionId,
      lines: [
        { type: "assistant", uuid: "assistant-1", sessionId },
        { type: "last-prompt", leafUuid: "assistant-1", sessionId },
      ],
    });
    await transcript({
      root: stub,
      sessionId,
      lines: [{ type: "last-prompt", leafUuid: "missing", sessionId }],
    });

    await expect(
      resolveClaudeSessionCandidate({
        profileRoots: [stub, real],
        providerSessionId: sessionId,
      }),
    ).resolves.toMatchObject({
      profileRoot: real,
      transcriptPath: realPath,
      hasConversation: true,
    });
  });

  it("selects the longer append-only conversation", async () => {
    const shorter = await profile();
    const longer = await profile();
    const sessionId = "session-appended";
    const first = { type: "assistant", uuid: "assistant-1", sessionId };
    await transcript({ root: shorter, sessionId, lines: [first] });
    const longerPath = await transcript({
      root: longer,
      sessionId,
      lines: [first, { type: "user", uuid: "user-2", sessionId }],
    });

    await expect(
      resolveClaudeSessionCandidate({
        profileRoots: [shorter, longer],
        providerSessionId: sessionId,
      }),
    ).resolves.toMatchObject({ transcriptPath: longerPath });
  });

  it("refuses to choose between divergent conversations", async () => {
    const left = await profile();
    const right = await profile();
    const sessionId = "session-divergent";
    await transcript({
      root: left,
      sessionId,
      lines: [{ type: "assistant", uuid: "left" }],
    });
    await transcript({
      root: right,
      sessionId,
      lines: [{ type: "assistant", uuid: "right" }],
    });

    await expect(
      resolveClaudeSessionCandidate({
        profileRoots: [left, right],
        providerSessionId: sessionId,
      }),
    ).rejects.toThrow("Multiple divergent Claude conversations");
  });

  it("replaces a target metadata stub while preserving the exact source bytes", async () => {
    const source = await profile();
    const target = await profile();
    const sessionId = "session-migrate";
    const sourcePath = await transcript({
      root: source,
      sessionId,
      lines: [{ type: "assistant", uuid: "assistant-1", sessionId }],
    });
    const targetPath = await transcript({
      root: target,
      sessionId,
      lines: [{ type: "last-prompt", leafUuid: "missing", sessionId }],
    });

    await expect(
      synchronizeClaudeSessions({
        sourceProfileRoot: source,
        targetProfileRoot: target,
      }),
    ).resolves.toEqual({ copied: 0, kept: 0, replaced: 1 });
    expect(await readFile(targetPath)).toEqual(await readFile(sourcePath));
  });
});
