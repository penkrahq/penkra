import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@penkra/contracts";
import { Effect, Context } from "effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "penkra/environment/Services/ServerEnvironment",
) {}
