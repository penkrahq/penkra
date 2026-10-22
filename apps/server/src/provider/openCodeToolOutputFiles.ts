// Preserves the pinned OpenCode tool-state outputPath field during native import.
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, mkdir, realpath, rm, stat } from "node:fs/promises";
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

async function preserve(file: string, sourceRoot: string, targetDataRoot: string): Promise<string> {
  const [source, root] = await Promise.all([realpath(file), realpath(sourceRoot)]);
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
    return destination;
  } finally {
    await rm(staging, { force: true });
  }
}

export async function relocateOpenCodeToolOutputFiles(
  parts: readonly Part[],
  sourceDataRoot: string,
  targetDataRoot: string,
): Promise<Part[]> {
  const moved = new Map<string, string>();
  const move = async (source: string) => {
    let destination = moved.get(source);
    if (destination === undefined) {
      destination = await preserve(source, sourceDataRoot, targetDataRoot);
      moved.set(source, destination);
    }
    return destination;
  };
  const moveAttachment = async (part: FilePart): Promise<FilePart> => {
    if (!part.url.startsWith("file:")) return part;
    const url = new URL(part.url);
    const source = fileURLToPath(url);
    if (!contains(sourceDataRoot, source)) return part;
    const destination = await move(source);
    const relocated = pathToFileURL(destination);
    relocated.search = url.search;
    relocated.hash = url.hash;
    return {
      ...part,
      url: relocated.href,
      ...(part.source &&
      (part.source.type === "file" || part.source.type === "symbol") &&
      part.source.path === source
        ? { source: { ...part.source, path: destination } }
        : {}),
    };
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
            : { attachments: await Promise.all(part.state.attachments.map(moveAttachment)) }),
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
          : { attachments: await Promise.all(part.state.attachments.map(moveAttachment)) }),
        metadata: { ...part.state.metadata, outputPath: destination },
        output: part.state.output.replaceAll(source, destination),
      },
    });
  }
  return result;
}
