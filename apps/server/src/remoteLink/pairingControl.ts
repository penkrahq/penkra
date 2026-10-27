import { Context, Effect, Layer, Queue, Stream } from "effect";
import { WsRpcError } from "@penkra/contracts";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import { RemotePairingApprovals, type RemotePairingRequest } from "./pairingApprovals";

export interface RemotePairingControlShape {
  readonly approvals: RemotePairingApprovals;
  readonly changes: Stream.Stream<{ readonly request: RemotePairingRequest | null }>;
}
export class RemotePairingControl extends Context.Service<
  RemotePairingControl,
  RemotePairingControlShape
>()("penkra/remoteLink/PairingControl") {}

export const answerPairing = (
  control: RemotePairingControlShape,
  requestId: string,
  allow: boolean,
) =>
  Effect.gen(function* () {
    if ((yield* CurrentWsSessionRole) !== "owner")
      return yield* new WsRpcError({ message: "Only the Mac owner can answer pairing requests." });
    return { accepted: control.approvals.answer(requestId, allow) };
  });

export const pairingChanges = (control: RemotePairingControlShape) =>
  Stream.unwrap(
    Effect.gen(function* () {
      if ((yield* CurrentWsSessionRole) !== "owner")
        return yield* new WsRpcError({ message: "Only the Mac owner can view pairing requests." });
      return control.changes;
    }),
  );

/** A slow observer only needs the latest prompt; consent stays with its session. */
export const RemotePairingControlLive = Layer.effect(
  RemotePairingControl,
  Effect.gen(function* () {
    const approvals = yield* Effect.acquireRelease(
      Effect.sync(() => new RemotePairingApprovals(() => undefined)),
      (value) => Effect.sync(() => value.close()),
    );
    const changes = Stream.callback<{ readonly request: RemotePairingRequest | null }>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            approvals.subscribe((request) => {
              Queue.offerUnsafe(queue, { request });
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: "sliding" },
    );
    return { approvals, changes };
  }),
);
