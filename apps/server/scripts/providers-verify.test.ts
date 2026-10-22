import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { pinnedProviderArtifact } from "../src/provider/pinnedProviderRuntimes.ts";
import { verifyPinnedArtifact } from "./providers-verify.ts";

it("verifies the actual streamed download against the committed hash", async () => {
  const bytes = new TextEncoder().encode("official-artifact-fixture");
  const artifact = {
    ...pinnedProviderArtifact("codex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fetchArtifact = async (url: string) => {
    expect(url).toBe(artifact.url);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4));
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      }),
    );
  };
  expect(await verifyPinnedArtifact(artifact, fetchArtifact)).toEqual({
    provider: "codex",
    version: artifact.version,
    sha256: artifact.sha256,
    bytes: bytes.length,
  });
  await expect(
    verifyPinnedArtifact({ ...artifact, sha256: "0".repeat(64) }, fetchArtifact),
  ).rejects.toThrow("checksum mismatch");
});

it("rejects failed downloads rather than accepting metadata alone", async () => {
  await expect(
    verifyPinnedArtifact(
      pinnedProviderArtifact("codex"),
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toThrow("HTTP 404");
});
