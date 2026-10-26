import { Data, Deferred, Effect, Schema } from "effect";
import { NoiseHandshake, noisePairingCode } from "./noise";
import { remoteNoisePrologue } from "./pairedSession";
import { RemotePairingApprovals } from "./pairingApprovals";
import { encodePairingResult, type PairingResult } from "./pairingProtocol";
import type { makeRemotePhoneRegistry } from "./phoneRegistry";

const Pair = Schema.Struct({
  type: Schema.Literal("pair"),
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
});
const decodePair = Schema.decodeUnknownSync(Pair, { onExcessProperty: "error" });
export class RemotePairingError extends Data.TaggedError("RemotePairingError")<{
  readonly code: "protocol" | "approval" | "relay";
}> {}

/** Scoped XX pairing. The receiver is installed before a reply can enable the
 * phone's final handshake message. Only completed XX proof can ask for consent.
 */
export function runPairingConnection(input: {
  readonly macDeviceId: string;
  readonly macPrivateKey: Uint8Array;
  readonly phoneDeviceId: string;
  readonly openingMessage: Uint8Array;
  readonly approvals: RemotePairingApprovals;
  readonly registry: Effect.Success<ReturnType<typeof makeRemotePhoneRegistry>>;
  readonly setReceiver: (receiver: ((bytes: Uint8Array) => void) | null) => void;
  readonly sendWire: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (input.registry.scope.macDeviceId !== input.macDeviceId)
        return yield* new RemotePairingError({ code: "protocol" });
      const handshake = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new NoiseHandshake({
              pattern: "XX",
              initiator: false,
              staticPrivateKey: input.macPrivateKey,
              prologue: remoteNoisePrologue(input.macDeviceId, input.phoneDeviceId),
            }),
          catch: () => new RemotePairingError({ code: "protocol" }),
        }),
        (value) => Effect.sync(() => value.destroy()),
      );
      const opening = yield* Effect.try({
        try: () => {
          const payload = handshake.readMessage(input.openingMessage);
          const phone = decodePair(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
          );
          return { phone, reply: handshake.writeMessage(new Uint8Array()) };
        },
        catch: () => new RemotePairingError({ code: "protocol" }),
      });
      const final = yield* Deferred.make<Uint8Array>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          input.setReceiver((bytes) => Deferred.doneUnsafe(final, Effect.succeed(bytes)));
        }),
        () => Effect.sync(() => input.setReceiver(null)),
      );
      const send = (bytes: Uint8Array) =>
        Effect.tryPromise({
          try: (signal) => input.sendWire(bytes, signal),
          catch: () => new RemotePairingError({ code: "relay" }),
        });
      yield* send(opening.reply);
      const finalMessage = yield* Deferred.await(final);
      const transport = yield* Effect.try({
        try: () => {
          if (handshake.readMessage(finalMessage).length !== 0) throw new Error();
          return handshake.finish();
        },
        catch: () => new RemotePairingError({ code: "protocol" }),
      });
      yield* Effect.sync(() => input.setReceiver(null));
      const decision = yield* Effect.tryPromise({
        try: (signal) =>
          input.approvals.request(
            {
              phoneDeviceId: input.phoneDeviceId,
              phoneName: opening.phone.name,
              phoneModel: opening.phone.model,
              code: noisePairingCode(transport.handshakeHash),
            },
            signal,
          ),
        catch: () => new RemotePairingError({ code: "approval" }),
      });
      let result: PairingResult;
      if (decision === "allow") {
        const allowed = yield* input.registry.allow({
          deviceId: input.phoneDeviceId,
          name: opening.phone.name,
          identityKey: transport.remoteStaticKey,
        });
        result = { type: allowed.backendPaired ? "paired" : "failed" };
      } else result = { type: decision === "deny" ? "denied" : "expired" };
      yield* send(transport.send.encrypt(encodePairingResult(result)));
      return result;
    }),
  );
}
