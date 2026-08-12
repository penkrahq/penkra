import { assert, describe, it } from "@effect/vitest";
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { expect } from "vitest";

import type { ProviderManagedLaunchContext } from "./Services/ProviderAdapter.ts";
import { adoptManagedCodexRollout, prepareManagedCodexResume } from "./codexManagedNativeState.ts";

const THREAD_ID = "019f6e8c-0c04-7c53-97d9-3b798e2537a4";
const RELATIVE_ROLLOUT = Path.join(
  "sessions",
  "2026",
  "08",
  "08",
  `rollout-2026-08-08T12-00-00-${THREAD_ID}.jsonl`,
);

async function fixture() {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-codex-native-state-"));
  const profileRoot = Path.join(root, "profile");
  const nativeStateRoot = Path.join(root, "generation");
  const launch: ProviderManagedLaunchContext = {
    binaryPath: "/managed/codex",
    isolationKey: "managed-codex-test",
    profileRoot,
    nativeStateRoot,
    childEnvironment: (environment) => environment,
  };
  return { root, profileRoot, nativeStateRoot, launch };
}

describe("managed Codex native state", () => {
  it("adopts a new profile rollout as the generation-owned inode", async () => {
    const state = await fixture();
    try {
      const profileRollout = Path.join(state.profileRoot, "codex-home", RELATIVE_ROLLOUT);
      await mkdir(Path.dirname(profileRollout), { recursive: true });
      await writeFile(profileRollout, "first\n");

      await adoptManagedCodexRollout(state.launch, THREAD_ID);
      const generationRollout = Path.join(
        state.nativeStateRoot,
        "codex-rollouts",
        RELATIVE_ROLLOUT,
      );
      const [profileStat, generationStat] = await Promise.all([
        lstat(profileRollout),
        lstat(generationRollout),
      ]);
      assert.strictEqual(profileStat.ino, generationStat.ino);

      await appendFile(profileRollout, "second\n");
      assert.strictEqual(await readFile(generationRollout, "utf8"), "first\nsecond\n");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("replaces only the exact stale Connection-profile rollout on resume", async () => {
    const state = await fixture();
    try {
      const generationRollout = Path.join(
        state.nativeStateRoot,
        "codex-rollouts",
        RELATIVE_ROLLOUT,
      );
      const profileRollout = Path.join(state.profileRoot, "codex-home", RELATIVE_ROLLOUT);
      const unrelated = Path.join(
        state.profileRoot,
        "codex-home",
        "sessions",
        "2026",
        "08",
        "08",
        "rollout-2026-08-08T12-00-01-unrelated.jsonl",
      );
      await mkdir(Path.dirname(generationRollout), { recursive: true });
      await mkdir(Path.dirname(profileRollout), { recursive: true });
      await writeFile(generationRollout, "latest\n");
      await writeFile(profileRollout, "stale\n");
      await writeFile(unrelated, "other\n");

      await prepareManagedCodexResume(state.launch, THREAD_ID);
      const [profileStat, generationStat] = await Promise.all([
        lstat(profileRollout),
        lstat(generationRollout),
      ]);
      assert.strictEqual(profileStat.ino, generationStat.ino);
      assert.strictEqual(await readFile(profileRollout, "utf8"), "latest\n");
      assert.strictEqual(await readFile(unrelated, "utf8"), "other\n");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails closed when a generation has no exact rollout", async () => {
    const state = await fixture();
    try {
      await expect(prepareManagedCodexResume(state.launch, THREAD_ID)).rejects.toThrow(
        "The exact Codex rollout is unavailable.",
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
