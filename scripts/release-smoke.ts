import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const release = JSON.parse(await readFile("scripts/penkra-release.json", "utf8")) as {
  version: string;
  backendRepository: string;
  backendRef: string;
  platform: string;
  arch: string;
  channel: string;
};
const workflow = await readFile(".github/workflows/release.yml", "utf8");
const publisher = await readFile("scripts/penkra-publish.mjs", "utf8");
const notes = await readFile(`docs/releases/${release.version}.md`, "utf8");

assert.match(release.version, /^\d+\.\d+\.\d+$/);
assert.equal(release.backendRepository, "penkrahq/backend");
assert.match(release.backendRef, /^[0-9a-f]{7,40}$/);
assert.equal(release.platform, "mac");
assert.equal(release.arch, "arm64");
assert.equal(release.channel, "production-s3");
assert.match(workflow, /environment: production-desktop/);
assert.match(workflow, /--platform mac --target dmg --arch arm64/);
assert.doesNotMatch(workflow, /releases\/latest|macos-15-intel|AppImage|nsis/);
assert.match(workflow, /PENKRA_CLI_BINARY/);
assert.match(workflow, /PENKRA_UPDATE_TOKEN/);
assert.match(publisher, /isStrictlyNewer/);
assert.ok(
  publisher.indexOf('files.filter((name) => name !== "latest-mac.yml")') <
    publisher.indexOf("const manifestUpload"),
  "versioned artifacts must be uploaded before latest-mac.yml",
);
assert.match(notes, new RegExp(`Penkra ${release.version.replaceAll(".", "\\.")}`));

console.log(`Penkra ${release.version} release workflow smoke passed`);
