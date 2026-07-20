#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { isMacUpdateArtifact } from "./penkra-publish-local.mjs";

const source = resolve(process.argv[2] ?? "release");
const release = JSON.parse(
  await readFile(new URL("./penkra-release.json", import.meta.url), "utf8"),
);
const bucket = process.env.PENKRA_RELEASE_BUCKET?.trim();
const token = process.env.PENKRA_UPDATE_TOKEN?.trim();
const endpoint =
  process.env.PENKRA_UPDATE_ENDPOINT?.trim() || "https://api.penkra.com/updates/mac/latest-mac.yml";
if (!bucket) throw new Error("PENKRA_RELEASE_BUCKET is required");
if (!token) throw new Error("PENKRA_UPDATE_TOKEN is required");
const files = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && isMacUpdateArtifact(entry.name))
  .map((entry) => entry.name)
  .sort();
if (!files.includes("latest-mac.yml") || !files.some((name) => name.endsWith(".zip"))) {
  throw new Error("Release directory must contain latest-mac.yml and a macOS update ZIP");
}
const manifest = await readFile(resolve(source, "latest-mac.yml"), "utf8");
const manifestVersion = manifest.match(/^version:\s*["']?([^\s"']+)/m)?.[1];
if (manifestVersion !== release.version) {
  throw new Error(
    `Manifest version ${manifestVersion ?? "missing"} does not match Penkra release ${release.version}`,
  );
}
const liveResponse = await fetch(endpoint, {
  redirect: "follow",
  headers: { authorization: `Bearer ${token}`, accept: "text/yaml" },
});
if (!liveResponse.ok) throw new Error(`Live update manifest returned HTTP ${liveResponse.status}`);
const liveManifest = await liveResponse.text();
const liveVersion = liveManifest.match(/^version:\s*["']?([^\s"']+)/m)?.[1];
if (!liveVersion || !isStrictlyNewer(release.version, liveVersion)) {
  throw new Error(
    `Penkra ${release.version} is not newer than live version ${liveVersion ?? "unknown"}`,
  );
}
for (const file of files.filter((name) => name !== "latest-mac.yml")) {
  const result = spawnSync(
    "aws",
    ["s3", "cp", resolve(source, file), `s3://${bucket}/mac/${file}`, "--only-show-errors"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`Upload failed for ${file}`);
}
const manifestUpload = spawnSync(
  "aws",
  [
    "s3",
    "cp",
    resolve(source, "latest-mac.yml"),
    `s3://${bucket}/mac/latest-mac.yml`,
    "--only-show-errors",
  ],
  { stdio: "inherit" },
);
if (manifestUpload.status !== 0) throw new Error("Upload failed for latest-mac.yml");
process.stdout.write(`Published ${files.length} files to s3://${bucket}/mac/\n`);

function isStrictlyNewer(candidate, current) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`Expected a stable semantic version, received ${value}`);
    return match.slice(1).map(Number);
  };
  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}
