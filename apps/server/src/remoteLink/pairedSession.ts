import type { AuthSessionId } from "@penkra/contracts";
import { Data, Effect } from "effect";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { NoiseHandshake } from "./noise";

export class RemoteLinkSessionError extends Data.TaggedError("RemoteLinkSessionError")<{
  readonly message: string;
}> {}

function uuidBytes(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Invalid remote device identity.");
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

export function remoteNoisePrologue(macDeviceId: string, phoneDeviceId: string): Uint8Array {
  return Buffer.concat([
    Buffer.from("penkra-remote/1"),
    uuidBytes(macDeviceId),
    uuidBytes(phoneDeviceId),
  ]);
}

/** The phone record must come from persisted trust, never from a relay frame or handshake payload. */
export function openPairedSession(input: {
  readonly macDeviceId: string;
  readonly macPrivateKey: Uint8Array;
  readonly phone: {
    readonly deviceId: string;
    readonly identityKey: Uint8Array;
    readonly sessionId: AuthSessionId;
    readonly pendingBackend: number;
  };
  readonly openingMessage: Uint8Array;
}) {
  return Effect.gen(function* () {
    if (input.phone.pendingBackend !== 0)
      return yield* new RemoteLinkSessionError({
        message: "Phone pairing is not recorded by the registry yet.",
      });
    const sessions = yield* SessionCredentialService;
    const handshake = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new NoiseHandshake({
            pattern: "KK",
            initiator: false,
            staticPrivateKey: input.macPrivateKey,
            remoteStaticKey: input.phone.identityKey,
            prologue: remoteNoisePrologue(input.macDeviceId, input.phone.deviceId),
          }),
        catch: () => new RemoteLinkSessionError({ message: "Invalid paired session identity." }),
      }),
      (value) => Effect.sync(() => value.destroy()),
    );
    const channel = yield* Effect.try({
      try: () => {
        handshake.readMessage(input.openingMessage);
        const reply = handshake.writeMessage(new Uint8Array());
        return { reply, transport: handshake.finish() };
      },
      catch: () =>
        new RemoteLinkSessionError({ message: "The phone could not prove its paired key." }),
    });
    // Only a completed, authenticated KK handshake can reach credential restoration/renewal.
    const credential = yield* sessions.resumeClient({
      sessionId: input.phone.sessionId,
      subject: input.phone.deviceId,
    });
    // credential is loopback-only. The relay receives reply, then encrypted transport frames.
    return { ...channel, credential };
  });
}
