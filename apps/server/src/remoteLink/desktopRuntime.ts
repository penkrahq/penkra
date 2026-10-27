import { Effect } from "effect";
import { RemoteAccountLifetime } from "./accountLifetime";
import { makeRemoteAccountWork } from "./accountWork";
import { watchDesktopRemoteLifecycle } from "./desktopLifecycle";

/** The desktop channel and all account work share the backend's scope. */
export function startDesktopRemoteRuntime(
  input: Parameters<typeof makeRemoteAccountWork>[0] & {
    env?: NodeJS.ProcessEnv;
  },
) {
  return Effect.gen(function* () {
    const mount = yield* makeRemoteAccountWork(input);
    const owner = new RemoteAccountLifetime(mount);
    const abort = new AbortController();
    const finished = watchDesktopRemoteLifecycle({
      ...(input.env ? { env: input.env } : {}),
      signal: abort.signal,
      apply: (event, signal) => owner.apply(event, signal),
      closeOwner: () => owner.close(),
    }).catch((error) => {
      if (!abort.signal.aborted) {
        try {
          input.observeFailure(error);
        } catch {
          /* Diagnostics do not own the runtime. */
        }
      }
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        abort.abort();
        await finished;
      }),
    );
  });
}
