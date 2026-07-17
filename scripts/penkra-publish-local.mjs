#!/usr/bin/env node
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export function isMacUpdateArtifact(name) {
  return name === "latest-mac.yml" || /\.(dmg|zip|blockmap)$/.test(name);
}

export async function publishLocal(source, destination) {
  const entries = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isMacUpdateArtifact(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!entries.includes("latest-mac.yml") || !entries.some((name) => name.endsWith(".zip"))) {
    throw new Error("Release directory must contain latest-mac.yml and a macOS update ZIP");
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all(
    entries.map((name) => copyFile(resolve(source, name), resolve(destination, name))),
  );
  return entries;
}

if (process.argv[1] && basename(process.argv[1]) === "penkra-publish-local.mjs") {
  const source = resolve(process.argv[2] ?? "release");
  const root = resolve(process.env.PENKRA_ROOT?.trim() || resolve(homedir(), "Penkra"));
  const destination = resolve(process.argv[3] ?? resolve(root, ".updates"));
  publishLocal(source, destination)
    .then((files) => process.stdout.write(`Published ${files.length} files to ${destination}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Publish failed"}\n`);
      process.exitCode = 1;
    });
}
