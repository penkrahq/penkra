import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAppPackageProtocolHandler } from "./appPackageProtocol";

const roots: string[] = [];

async function packageFixture() {
  const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-package-"));
  roots.push(root);
  await FS.promises.mkdir(Path.join(root, "assets"));
  await FS.promises.writeFile(Path.join(root, "app.html"), "<main>Apps</main>");
  await FS.promises.writeFile(Path.join(root, "assets", "app.js"), "export const ready = true;");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.promises.rm(root, { recursive: true })));
});

describe("App package protocol", () => {
  it("serves package files with restrictive security headers and correct content types", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      appId: "com.penkra.apps",
      packageRoot: root,
      entrypoint: "app.html",
    });

    const response = await handle(new Request("penkra-app://com.penkra.apps/assets/app.js"));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("export const ready = true;");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(contentSecurityPolicy).toContain("connect-src 'self'");
    expect(contentSecurityPolicy).not.toContain("connect-src http:");
    expect(contentSecurityPolicy).not.toContain("connect-src https:");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves verified package-local WebAssembly with its required MIME type", async () => {
    const root = await packageFixture();
    await FS.promises.writeFile(
      Path.join(root, "assets", "engine.wasm"),
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    const handle = await createAppPackageProtocolHandler({
      appId: "com.penkra.canvas",
      packageRoot: root,
      entrypoint: "app.html",
    });

    const response = await handle(new Request("penkra-app://com.penkra.canvas/assets/engine.wasm"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect((await response.arrayBuffer()).byteLength).toBe(8);
  });

  it("falls back to the App entrypoint only for extensionless client routes", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      appId: "com.penkra.apps",
      packageRoot: root,
      entrypoint: "app.html",
    });

    const route = await handle(new Request("penkra-app://com.penkra.apps/installed"));
    expect(route.status).toBe(200);
    await expect(route.text()).resolves.toBe("<main>Apps</main>");
    const missingAsset = await handle(
      new Request("penkra-app://com.penkra.apps/assets/missing.js"),
    );
    expect(missingAsset.status).toBe(404);
  });

  it("returns a generic 404 for another App origin and traversal attempts", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      appId: "com.penkra.apps",
      packageRoot: root,
      entrypoint: "app.html",
    });

    await expect(
      handle(new Request("penkra-app://com.acme.linear/app.html")),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      handle(new Request("penkra-app://com.penkra.apps/%2e%2e/secrets.txt")),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("does not follow a package symlink outside the verified root", async () => {
    const root = await packageFixture();
    const outside = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-secret-"));
    roots.push(outside);
    await FS.promises.writeFile(Path.join(outside, "secret.txt"), "secret");
    await FS.promises.symlink(Path.join(outside, "secret.txt"), Path.join(root, "secret.txt"));
    const handle = await createAppPackageProtocolHandler({
      appId: "com.penkra.apps",
      packageRoot: root,
      entrypoint: "app.html",
    });

    const response = await handle(new Request("penkra-app://com.penkra.apps/secret.txt"));
    expect(response.status).toBe(404);
  });

  it("refuses to activate a package without a valid entrypoint", async () => {
    const root = await packageFixture();
    await expect(
      createAppPackageProtocolHandler({
        appId: "com.penkra.apps",
        packageRoot: root,
        entrypoint: "missing.html",
      }),
    ).rejects.toThrow();
  });
});
