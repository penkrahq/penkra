import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppIdentityService } from "./appIdentityService";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("AppIdentityService", () => {
  it("is stable across restarts and pairwise across Apps and Spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-identity-"));
    roots.push(root);
    const getAccountId = async () => "account-private-id";
    const first = await AppIdentityService.open({ userDataPath: root, getAccountId });
    const restarted = await AppIdentityService.open({ userDataPath: root, getAccountId });

    const canvasPersonal = await first.resolve("com.example.canvas", "personal-private-id");
    expect(await restarted.resolve("com.example.canvas", "personal-private-id")).toEqual(
      canvasPersonal,
    );
    expect(await first.resolve("com.example.canvas", "work-private-id")).toMatchObject({
      subject: canvasPersonal.subject,
    });
    expect((await first.resolve("com.example.other", "personal-private-id")).subject).not.toBe(
      canvasPersonal.subject,
    );
    expect((await first.resolve("com.example.other", "personal-private-id")).space).not.toBe(
      canvasPersonal.space,
    );
    expect(JSON.stringify(canvasPersonal)).not.toContain("private-id");

    const origin = first.resolveOrigin("com.example.canvas", "personal-private-id");
    expect(restarted.resolveOrigin("com.example.canvas", "personal-private-id")).toBe(origin);
    expect(first.resolveOrigin("com.example.canvas", "work-private-id")).not.toBe(origin);
    expect(first.resolveOrigin("com.example.other", "personal-private-id")).not.toBe(origin);
    expect(origin).toMatch(/^penkra-app:\/\/a-[a-f0-9]{64}$/);
    expect(origin).not.toContain("canvas");
    expect(origin).not.toContain("private-id");
  });

  it("keeps Space identity available when the user is signed out", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-identity-"));
    roots.push(root);
    const service = await AppIdentityService.open({
      userDataPath: root,
      getAccountId: async () => null,
    });
    expect(await service.resolve("com.example.canvas", "personal")).toMatchObject({
      subject: null,
      space: expect.stringMatching(/^space_/),
    });
  });
});
