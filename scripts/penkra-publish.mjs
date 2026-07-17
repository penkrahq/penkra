#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { isMacUpdateArtifact } from "./penkra-publish-local.mjs";

const source = resolve(process.argv[2] ?? "release");
const bucket = process.env.PENKRA_RELEASE_BUCKET?.trim() || "penkra-releases";
const files = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && isMacUpdateArtifact(entry.name))
  .map((entry) => entry.name)
  .sort();
if (!files.includes("latest-mac.yml") || !files.some((name) => name.endsWith(".zip"))) {
  throw new Error("Release directory must contain latest-mac.yml and a macOS update ZIP");
}
for (const file of files) {
  const result = spawnSync(
    "aws",
    ["s3", "cp", resolve(source, file), `s3://${bucket}/mac/${file}`, "--only-show-errors"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`Upload failed for ${file}`);
}
process.stdout.write(`Published ${files.length} files to s3://${bucket}/mac/\n`);
