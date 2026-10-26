import { Schema } from "effect";

export const RemoteLifecycleSnapshot = Schema.Struct({
  accountServiceUrl: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  accessOn: Schema.Boolean,
  suspended: Schema.Boolean,
});
export type RemoteLifecycleSnapshot = typeof RemoteLifecycleSnapshot.Type;

export const RemoteLifecycleEvent = Schema.Struct({
  type: Schema.Literal("remote.lifecycle"),
  revision: Schema.Int,
  event: Schema.Literals([
    "snapshot",
    "sign-in",
    "sign-out",
    "access",
    "suspend",
    "wake",
    "network-path",
  ]),
  snapshot: RemoteLifecycleSnapshot,
});
export type RemoteLifecycleEvent = typeof RemoteLifecycleEvent.Type;

export const RemoteLifecycleControl = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ack"), revision: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("released") }),
]);
