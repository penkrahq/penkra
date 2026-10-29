import { Effect, Fiber, Stream } from "effect";
import { expect, it } from "vitest";
import {
  RemotePairingControl,
  RemotePairingControlLive,
  answerPairing,
  pairingChanges,
} from "./pairingControl";
import { CurrentWsSessionRole } from "../wsConnectionSessions";

it("refuses both prompt reads and answers from a phone session", async () => {
  await Effect.gen(function* () {
    const control = yield* RemotePairingControl;
    const decision = control.approvals.request(
      { phoneDeviceId: "phone", phoneName: "Phone", phoneModel: "Model", code: "123456" },
      new AbortController().signal,
    );
    const id = control.approvals.current!.requestId;
    const read = Effect.runPromise(
      Stream.runHead(pairingChanges(control)).pipe(
        Effect.provideService(CurrentWsSessionRole, "client"),
      ),
    );
    const answer = Effect.runPromise(
      answerPairing(control, id, true).pipe(Effect.provideService(CurrentWsSessionRole, "client")),
    );
    yield* Effect.promise(async () => {
      await Promise.all([
        expect(read).rejects.toThrow("Only the Mac owner"),
        expect(answer).rejects.toThrow("Only the Mac owner"),
      ]);
    });
    expect(control.approvals.current?.requestId).toBe(id);
    expect(
      yield* answerPairing(control, id, false).pipe(
        Effect.provideService(CurrentWsSessionRole, "owner"),
      ),
    ).toEqual({ accepted: true });
    expect(yield* Effect.promise(() => decision)).toBe("deny");
  }).pipe(Effect.provide(RemotePairingControlLive), Effect.scoped, Effect.runPromise);
});
