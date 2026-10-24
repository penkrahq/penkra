import type { ServerAuthDescriptor } from "@penkra/contracts";
import { Effect, Context } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends Context.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "penkra/auth/Services/ServerAuthPolicy",
) {}
