import { Effect, Context } from "effect";

export interface ProjectFaviconResolverShape {
  readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
}

export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("penkra/project/Services/ProjectFaviconResolver") {}
