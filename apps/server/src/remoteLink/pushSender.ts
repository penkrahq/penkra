import { sealPush } from "./sealedPush";

export type PushEvent = {
  threadId: string;
  kind: "question" | "finished";
  title: string;
  body: string;
};
type Phone = { deviceId: string; identityKey: Uint8Array; pendingBackend: number };

/** Encrypt separately for each authorized recipient; never send plaintext to the registry. */
export async function sendThreadPush(input: {
  event: PushEvent;
  macDeviceId: string;
  phones: ReadonlyArray<Phone>;
  viewing: (phoneId: string, threadId: string) => boolean;
  post: (body: {
    threadId: string;
    kind: "question" | "finished";
    sealed: Record<string, string>;
  }) => Promise<void>;
}): Promise<void> {
  const sealed: Record<string, string> = {};
  const payload = Buffer.from(
    JSON.stringify({
      title: input.event.title,
      body: input.event.body,
      threadId: input.event.threadId,
      macDeviceId: input.macDeviceId,
    }),
  );
  for (const phone of input.phones) {
    if (phone.pendingBackend !== 0 || input.viewing(phone.deviceId, input.event.threadId)) continue;
    sealed[phone.deviceId] = Buffer.from(sealPush(phone.identityKey, payload)).toString("base64");
  }
  if (Object.keys(sealed).length)
    await input.post({ threadId: input.event.threadId, kind: input.event.kind, sealed });
}
