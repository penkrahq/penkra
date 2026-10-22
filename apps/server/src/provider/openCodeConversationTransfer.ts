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
  const { projectID: _project, directory: _directory, path: _path, ...metadata } = info;
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
  readonly deleteTarget: () => Promise<void>;
  readonly command: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}): Promise<void> {
  const source = decodeOpenCodeConversationExport(input.conversation, input.conversation.info.id);
  if (input.sourceDataRoot === input.targetDataRoot)
    throw new Error("OpenCode conversation source and destination are identical.");
  await mkdir(input.temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(input.temporaryRoot, ".opencode-transfer-"));
  try {
    const target = {
      ...source,
      messages: await Promise.all(
        source.messages.map(async (message) => ({
          ...message,
          parts: await relocateOpenCodeToolOutputFiles(
            message.parts,
            input.sourceDataRoot,
            path.join(input.targetDataRoot, "thread-artifacts", source.info.id),
          ),
        })),
      ),
    };
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
    const file = path.join(temporary, "conversation.json");
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    input.signal.throwIfAborted();
    await input.deleteTarget();
    if (plan) {
      await mkdir(path.dirname(plan.destination), { recursive: true, mode: 0o700 });
      await rename(plan.staged, plan.destination);
    }
    const imported = await input.command(["--pure", "import", file]);
    if (imported.code !== 0)
      throw new Error(`OpenCode import failed (${imported.code}): ${imported.stderr}`);
    const result = await input.command(["--pure", "export", source.info.id]);
    if (result.code !== 0)
      throw new Error(`OpenCode import verification failed (${result.code}): ${result.stderr}`);
    const verified = decodeOpenCodeConversationExport(JSON.parse(result.stdout), source.info.id);
    if (
      !isDeepStrictEqual(verified.messages, target.messages) ||
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
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
