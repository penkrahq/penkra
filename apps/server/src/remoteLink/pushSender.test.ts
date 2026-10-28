import { x25519 } from "@noble/curves/ed25519.js";
import { expect, it, vi } from "vitest";
import { sendThreadPush } from "./pushSender";

it("seals only for paired phones not viewing the thread", async () => {
  const post = vi.fn(
    async (_body: {
      threadId: string;
      kind: "question" | "finished";
      sealed: Record<string, string>;
    }) => {},
  );
  const key = x25519.getPublicKey(new Uint8Array(32).fill(7));
  await sendThreadPush({
    event: { threadId: "thread", kind: "question", title: "private title", body: "private body" },
    macDeviceId: "mac",
    phones: [
      { deviceId: "a", identityKey: key, pendingBackend: 0 },
      { deviceId: "b", identityKey: key, pendingBackend: 0 },
      { deviceId: "c", identityKey: key, pendingBackend: 1 },
    ],
    viewing: (phone) => phone === "b",
    post,
  });
  expect(post).toHaveBeenCalledOnce();
  const body = post.mock.calls[0]![0];
  expect(Object.keys(body.sealed)).toEqual(["a"]);
  expect(JSON.stringify(body)).not.toContain("private title");
  expect(JSON.stringify(body)).not.toContain("private body");
});
