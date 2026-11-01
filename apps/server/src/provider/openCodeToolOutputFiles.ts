// Preserves the pinned OpenCode tool-state outputPath field during native import.
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FilePart, Part } from "@opencode-ai/sdk/v2";

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function preserve(
  file: string,
  sourceRoot: string,
  targetDataRoot: string,
): Promise<{ path: string; missing: boolean }> {
  const root = await realpath(sourceRoot);
  let source: string;
  try {
    source = await realpath(file);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    try {
      await lstat(file);
      throw new Error("OpenCode tool output is a dangling link or otherwise inaccessible.");
    } catch (entryCause) {
      if (!(entryCause instanceof Error && "code" in entryCause && entryCause.code === "ENOENT"))
        throw entryCause;
    }
    const hash = createHash("sha256").update(file).digest("hex");
    return {
      path: path.join(targetDataRoot, "tool-output", `penkra-missing-${hash}`),
      missing: true,
    };
  }
  if (!contains(root, source) || !(await stat(source)).isFile()) {
    throw new Error("OpenCode tool output is not a regular file inside its source data root.");
  }
  const hash = await digest(source);
  const directory = path.join(targetDataRoot, "tool-output");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `penkra-${hash}`);
  const staging = path.join(directory, `.copy-${randomUUID()}`);
  try {
    await copyFile(source, staging, constants.COPYFILE_EXCL);
    await chmod(staging, 0o600);
    if ((await digest(staging)) !== hash)
      throw new Error("OpenCode tool output changed while copying.");
    try {
      await link(staging, destination);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    }
    if ((await digest(destination)) !== hash)
      throw new Error("OpenCode destination tool output does not match its source.");
    return { path: destination, missing: false };
  } finally {
    await rm(staging, { force: true });
  }
}

export async function relocateOpenCodeToolOutputFiles(
  parts: readonly Part[],
  sourceDataRoot: string,
  targetDataRoot: string,
  onMissing?: (source: string) => void,
): Promise<Part[]> {
  const moved = new Map<string, { path: string; missing: boolean }>();
  const move = async (source: string) => {
    let destination = moved.get(source);
    if (destination === undefined) {
      destination = await preserve(source, sourceDataRoot, targetDataRoot);
      moved.set(source, destination);
      if (destination.missing) onMissing?.(source);
    }
    return destination;
  };
  const moveAttachment = async (part: FilePart): Promise<FilePart> => {
    if (!part.url.startsWith("file:")) return part;
    const url = new URL(part.url);
    const source = fileURLToPath(url);
    if (!contains(sourceDataRoot, source)) return part;
    const destination = await move(source);
    const relocated = pathToFileURL(destination.path);
    relocated.search = url.search;
    relocated.hash = url.hash;
    return {
      ...part,
      url: relocated.href,
      ...(part.source &&
      (part.source.type === "file" || part.source.type === "symbol") &&
      part.source.path === source
        ? { source: { ...part.source, path: destination.path } }
        : {}),
    };
  };
  const moveAttachments = async (parts: FilePart[]): Promise<FilePart[]> => {
    // A failed attachment must not leave other copies running during rollback.
    const results = await Promise.allSettled(parts.map(moveAttachment));
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  };
  const result: Part[] = [];
  for (const part of parts) {
    if (part.type === "file") {
      result.push(await moveAttachment(part));
      continue;
    }
    if (part.type !== "tool" || part.state.status !== "completed") {
      result.push(part);
      continue;
    }
    const source = part.state.metadata.outputPath;
    if (
      typeof source !== "string" ||
      !path.isAbsolute(source) ||
      !contains(sourceDataRoot, source)
    ) {
      result.push({
        ...part,
        state: {
          ...part.state,
          ...(part.state.attachments === undefined
            ? {}
            : { attachments: await moveAttachments(part.state.attachments) }),
        },
      });
      continue;
    }
    const destination = await move(source);
    result.push({
      ...part,
      state: {
        ...part.state,
        ...(part.state.attachments === undefined
          ? {}
          : { attachments: await moveAttachments(part.state.attachments) }),
        metadata: { ...part.state.metadata, outputPath: destination.path },
        output: destination.missing
          ? part.state.output
          : part.state.output.replaceAll(source, destination.path),
      },
    });
  }
  return result;
}
