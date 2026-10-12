// @vitest-environment happy-dom
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryObserver } from "@tanstack/react-query";
import type { NativeApi } from "@penkra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerManager } from "../../server/src/codexAppServerManager";
import {
  discoverSkillsCatalog,
  resetSkillsCatalogForTests,
} from "../../server/src/provider/skillsCatalog";
import { createAppQueryClient } from "../src/lib/appQueryClient";
import {
  providerSkillsQueryOptions,
  skillsCatalogQueryOptions,
} from "../src/lib/providerDiscoveryReactQuery";
import * as nativeApi from "../src/nativeApi";

afterEach(() => {
  vi.restoreAllMocks();
  resetSkillsCatalogForTests();
});

it("refreshes Infinity-fresh Codex skills and the catalog on two real focus events after disk edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "penkra-focus-skills-"));
  const base = join(root, "penkra");
  const home = join(root, "home");
  const skillDir = join(base, "skills", "focus-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(home);
  const file = join(skillDir, "SKILL.md");
  const edit = (name: string) =>
    writeFile(file, `---\nname: ${name}\ndescription: Focus regression\n---\n`);
  const manager = new CodexAppServerManager();
  // Only the native protocol transport is substituted; catalog parsing and both server reads are real.
  vi.spyOn(
    manager as unknown as { resolveProcessForDiscovery: () => Promise<unknown> },
    "resolveProcessForDiscovery",
  ).mockResolvedValue({});
  const request = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockImplementation(async (_transport, _owner, method, params) => {
      expect(method).toBe("skills/list");
      expect(params).toEqual({ cwds: [root], forceReload: true });
      const text = await readFile(file, "utf8");
      return { skills: [{ name: text.match(/name: (.+)/)![1], path: file }] };
    });
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: {
      listSkills: (input) => manager.listSkills(input),
      listSkillsCatalog: async () => ({
        skills: await discoverSkillsCatalog({ homeDir: home, penkraBaseDir: base }),
      }),
    },
  } as unknown as NativeApi);
  await edit("first");
  const client = createAppQueryClient();
  client.mount();
  const options = [
    providerSkillsQueryOptions({ provider: "codex", cwd: root }),
    skillsCatalogQueryOptions({ cwd: root }),
  ];
  const observers = options.map((option) => new QueryObserver(client, option));
  const subscriptions = observers.map((observer) => observer.subscribe(() => {}));
  try {
    await Promise.all(options.map((option) => client.fetchQuery(option)));
    for (const name of ["second", "third"]) {
      await edit(name);
      const refreshed = observers.map(
        (observer) =>
          new Promise<void>((resolve, reject) => {
            const unsubscribe = observer.subscribe((result) => {
              if (result.error) {
                unsubscribe();
                reject(result.error);
              } else if (!result.isFetching && result.data?.skills[0]?.name === name) {
                unsubscribe();
                resolve();
              }
            });
          }),
      );
      window.dispatchEvent(new Event("focus"));
      await Promise.all(refreshed);
    }
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    client.unmount();
    client.clear();
    await rm(root, { recursive: true, force: true });
  }
});

it("removes the window focus and document visibility listeners when the client unmounts", () => {
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const client = createAppQueryClient();
  client.mount();
  client.unmount();
  expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  client.clear();
});
