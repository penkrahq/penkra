// One owned export command. Its stdout is a regular file, never a subprocess pipe.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import { createLogger } from "../logger.ts";
import { observeProviderProcess } from "./providerProcessDiagnostics.ts";
import { teardownChildProcessTree } from "./supervisedProcessTeardown.ts";
import {
  decodeOpenCodeConversationExport,
  type OpenCodeConversationExport,
} from "./openCodeConversationTransfer.ts";

const log = createLogger("opencode-export");
export interface OpenCodeExportOwner {
  readonly stop: () => Promise<void>;
}
export interface OpenCodeFileExportInput {
  readonly binaryPath: string;
  readonly sessionID: string;
  readonly cwd: string;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly temporaryRoot: string;
  readonly signal: AbortSignal;
}

export async function exportOpenCodeConversation(
  input: OpenCodeFileExportInput,
  dependencies: {
    readonly spawn?: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => ChildProcess;
    readonly teardown?: typeof teardownChildProcessTree;
    /** Retain ownership if exit proof fails; runtime shutdown can stop it explicitly. */
    readonly registerOwner?: (owner: OpenCodeExportOwner) => () => void;
  } = {},
): Promise<OpenCodeConversationExport> {
  input.signal.throwIfAborted();
  const started = performance.now();
  await mkdir(input.temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(input.temporaryRoot, ".opencode-export-"));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let owner: OpenCodeExportOwner | undefined;
  let phase = "spawn";
  let bytes: number | null = null;
  try {
    const output = path.join(temporary, "conversation.json");
    file = await open(output, "wx", 0o600);
    const prepared = prepareWindowsSafeProcess(
      input.binaryPath,
      ["--pure", "export", input.sessionID],
      { cwd: input.cwd, env: input.processEnv },
    );
    const child = (dependencies.spawn ?? spawn)(prepared.command, prepared.args, {
      cwd: input.cwd,
      env: input.processEnv,
      shell: prepared.shell,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      signal: input.signal,
      stdio: ["ignore", file.fd, "pipe"],
    });
    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    observeProviderProcess(child, {
      provider: "opencode",
      context: () => ({ operation: "storage.export", providerSessionId: input.sessionID }),
    });
    let cleanup: Promise<void> | undefined;
    let unregister = () => {};
    owner = {
      stop: async () => {
        cleanup ??= (async () => {
          if (child.pid !== undefined)
            await (dependencies.teardown ?? teardownChildProcessTree)(child);
          await closed;
          await file!.close();
          await rm(temporary, { recursive: true, force: true });
          unregister();
        })();
        try {
          await cleanup;
        } catch (cause) {
          cleanup = undefined;
          throw cause;
        }
      },
    };
    unregister = dependencies.registerOwner?.(owner) ?? unregister;
    phase = "exit";
    const exit = await closed;
    if (processError) throw processError;
    input.signal.throwIfAborted();
    if (exit.code !== 0)
      throw new Error(`OpenCode export exited with code ${exit.code}, signal ${exit.signal}.`);
    bytes = (await stat(output)).size;
    phase = "json";
    const value: unknown = JSON.parse(await readFile(output, "utf8"));
    phase = "ownership";
    const conversation = decodeOpenCodeConversationExport(value, input.sessionID);
    log.info("provider.storage.export.completed", {
      providerSessionId: input.sessionID,
      bytes,
      messageCount: conversation.messages.length,
      durationMs: performance.now() - started,
    });
    return conversation;
  } catch (cause) {
    // Never log a JSON parse excerpt: it can contain private transcript text.
    log.error("provider.storage.export.failed", {
      providerSessionId: input.sessionID,
      phase,
      bytes,
      durationMs: performance.now() - started,
      ...(phase === "spawn" && cause instanceof Error && "code" in cause
        ? { code: cause.code }
        : {}),
    });
    throw new Error(
      `OpenCode export failed during ${phase}${bytes === null ? "" : ` (${bytes} bytes)`}.`,
      { cause },
    );
  } finally {
    if (owner) await owner.stop();
    else {
      await file?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
