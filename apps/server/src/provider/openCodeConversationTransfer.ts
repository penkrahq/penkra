// One verified native conversation import; the caller retains source ownership.
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2";
import { relocateOpenCodeToolOutputFiles } from "./openCodeToolOutputFiles.ts";
import { preserveOpenCodeNativeSnapshots } from "./openCodeNativeSnapshots.ts";

export interface OpenCodeConversationExport {
  readonly info: Session;
  readonly messages: ReadonlyArray<{ readonly info: Message; readonly parts: Part[] }>;
}

function safeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function decodeOpenCodeConversationExport(
  value: unknown,
  sessionID: string,
): OpenCodeConversationExport {
  if (!value || typeof value !== "object" || !("info" in value) || !("messages" in value))
    throw new Error("OpenCode exported no conversation.");
  const exported = value as OpenCodeConversationExport;
  if (
    exported.info?.id !== sessionID ||
    !safeComponent(sessionID) ||
    typeof exported.info.projectID !== "string" ||
    typeof exported.info.directory !== "string" ||
    !Array.isArray(exported.messages)
  )
    throw new Error("OpenCode exported a different or malformed conversation.");
  for (const message of exported.messages) {
    if (
      !message.info ||
      typeof message.info.id !== "string" ||
      message.info.sessionID !== sessionID ||
      !Array.isArray(message.parts)
    )
      throw new Error("OpenCode exported a malformed message.");
    for (const part of message.parts)
      if (
        part.sessionID !== sessionID ||
        part.messageID !== message.info.id ||
        typeof part.id !== "string" ||
        typeof part.type !== "string"
      )
        throw new Error("OpenCode exported a part with a different native owner.");
  }
  return exported;
}

function conversationMetadata(info: Session) {
  const {
    projectID: _project,
    directory: _directory,
    path: _path,
    permission: _permission,
    ...metadata
  } = info;
  return metadata;
}

export async function importOpenCodeConversation(input: {
  readonly conversation: OpenCodeConversationExport;
  readonly sourceDataRoot: string;
  readonly targetDataRoot: string;
  readonly worktree: string;
  readonly temporaryRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly onStep?: (step: string) => void;
  readonly assertNoPeers: () => Promise<void>;
  readonly onCleanupError?: (path: string, cause: unknown) => void;
  readonly verifyPermissions?: () => Promise<void>;
  readonly deleteTarget: () => Promise<void>;
  readonly command: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  readonly exportConversation: (sessionID: string) => Promise<OpenCodeConversationExport>;
}): Promise<{ missingToolOutputs: string[]; normalizedEmptyErrorRaw: number }> {
  const source = decodeOpenCodeConversationExport(input.conversation, input.conversation.info.id);
  const missingToolOutputs: string[] = [];
  if (input.sourceDataRoot === input.targetDataRoot)
    throw new Error("OpenCode conversation source and destination are identical.");
  await mkdir(input.temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(input.temporaryRoot, ".opencode-transfer-"));
  const artifacts = path.join(input.targetDataRoot, "thread-artifacts", source.info.id);
  let targetCleared = false;
  try {
    input.onStep?.("delete-target");
    await input.assertNoPeers();
    targetCleared = true;
    await input.deleteTarget();
    await input.assertNoPeers();
    await rm(artifacts, { recursive: true, force: true });
    input.onStep?.("relocate-tool-outputs");
    const { permission: _permission, ...targetInfo } = source.info;
    // Wait for every started copy to settle before rollback removes its output.
    const relocated = await Promise.allSettled(
      source.messages.map(async (message) => ({
        ...message,
        parts: await relocateOpenCodeToolOutputFiles(
          message.parts,
          input.sourceDataRoot,
          path.join(input.targetDataRoot, "thread-artifacts", source.info.id),
          (missing) => missingToolOutputs.push(missing),
        ),
      })),
    );
    const failed = relocated.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const target = {
      ...source,
      info: targetInfo,
      messages: relocated.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      }),
    };
    input.onStep?.("preserve-snapshots");
    await preserveOpenCodeNativeSnapshots({
      parts: source.messages.flatMap((message) => message.parts),
      ...(source.info.revert?.snapshot === undefined
        ? {}
        : { revertSnapshot: source.info.revert.snapshot }),
      projectID: source.info.projectID,
      worktree: input.worktree,
      sourceDataRoot: input.sourceDataRoot,
      targetDataRoot: input.targetDataRoot,
      env: input.env,
      signal: input.signal,
    });
    let plan: { staged: string; destination: string } | undefined;
    if (source.info.projectID === "global") {
      if (!safeComponent(source.info.slug) || !Number.isFinite(source.info.time.created))
        throw new Error("OpenCode exported an invalid plan identity.");
      const name = `${source.info.time.created}-${source.info.slug}.md`;
      const staged = path.join(temporary, "plan.md");
      try {
        await copyFile(path.join(input.sourceDataRoot, "plans", name), staged);
        plan = { staged, destination: path.join(input.targetDataRoot, "plans", name) };
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
    }
    input.onStep?.("write-export");
    const file = path.join(temporary, "conversation.json");
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    input.signal.throwIfAborted();
    if (plan) {
      await mkdir(path.dirname(plan.destination), { recursive: true, mode: 0o700 });
      await rename(plan.staged, plan.destination);
    }
    input.onStep?.("import");
    const imported = await input.command(["--pure", "import", file]);
    if (imported.code !== 0)
      throw new Error(`OpenCode import failed (${imported.code}): ${imported.stderr}`);
    input.onStep?.("verify");
    const verified = decodeOpenCodeConversationExport(
      await input.exportConversation(source.info.id),
      source.info.id,
    );
    let normalizedEmptyErrorRaw = 0;
    // OpenCode v1.19.3 import decodes parts through SessionV1.Part; its error
    // state schema omits raw (packages/opencode/src/cli/cmd/import.ts:16,97;
    // packages/schema/src/v1/session.ts:292). Only absent and empty raw on an
    // error state are equivalent; all other fields remain strictly compared.
    const normalized = target.messages.map((message, messageIndex) => ({
      ...message,
      parts: message.parts.map((part, partIndex) => {
        const actual = verified.messages[messageIndex]?.parts[partIndex];
        if (
          part.type !== "tool" ||
          part.state.status !== "error" ||
          actual?.type !== "tool" ||
          actual.state.status !== "error"
        )
          return part;
        const expectedState = part.state as typeof part.state & { raw?: unknown };
        const actualState = actual.state as typeof actual.state & { raw?: unknown };
        if (expectedState.raw === "" && !("raw" in actualState)) {
          normalizedEmptyErrorRaw++;
          const { raw: _raw, ...state } = expectedState;
          return { ...part, state };
        }
        return part;
      }),
    }));
    if (
      !isDeepStrictEqual(verified.messages, normalized) ||
      !isDeepStrictEqual(conversationMetadata(verified.info), conversationMetadata(target.info))
    )
      throw new Error("OpenCode imported conversation does not match its source.");
    if (
      plan &&
      !isDeepStrictEqual(
        await readFile(plan.destination),
        await readFile(path.join(input.sourceDataRoot, "plans", path.basename(plan.destination))),
      )
    )
      throw new Error("OpenCode imported plan does not match its source.");
    if (input.verifyPermissions) {
      input.onStep?.("permissions");
      await input.verifyPermissions();
    }
    return { missingToolOutputs: [...new Set(missingToolOutputs)], normalizedEmptyErrorRaw };
  } catch (cause) {
    if (targetCleared) {
      try {
        await input.assertNoPeers();
        await input.deleteTarget();
      } catch (cleanupCause) {
        input.onCleanupError?.(`session:${source.info.id}`, cleanupCause);
      }
      try {
        await input.assertNoPeers();
        await rm(artifacts, { recursive: true, force: true });
      } catch (cleanupCause) {
        input.onCleanupError?.(artifacts, cleanupCause);
      }
    }
    throw cause;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
