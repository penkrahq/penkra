import { ProviderConnectionId } from "@penkra/contracts";
// FILE: opencodeRuntime.test.ts
// Purpose: Covers OpenCode runtime parsing and local server startup diagnostics.
// Layer: Provider runtime tests
// Exports: Vitest suites for opencodeRuntime.ts

import { Deferred, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { ChatAttachment } from "@penkra/contracts";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import {
  buildOpenCodePermissionRules,
  buildOpenCodeServerProcessEnv,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  makeOpenCodeRuntimeLive,
  parseOpenCodeCredentialProviderIDs,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";

const encoder = new TextEncoder();

describe("OpenCode permission policy", () => {
  it("keeps full access non-interactive", () => {
    expect(buildOpenCodePermissionRules("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });
});

function mockOpenCodeServerHandle(input: {
  stdout: string;
  stderr: string;
  pid?: number;
  exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, never>;
  kill?: () => Effect.Effect<void, never>;
  ready?: Effect.Effect<void>;
}) {
  return ChildProcessSpawner.makeHandle({
    unref: Effect.succeed(Effect.void),
    pid: ChildProcessSpawner.ProcessId(input.pid ?? 1),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: input.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.fromEffect(input.ready ?? Effect.void).pipe(
      Stream.flatMap(() => Stream.make(encoder.encode(input.stdout))),
    ),
    stderr: Stream.make(encoder.encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockOpenCodeServerSpawnerLayer(input: { stdout: string; stderr: string }) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(mockOpenCodeServerHandle(input))),
  );
}

function mockPooledOpenCodeServerSpawnerLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
  killUrls: Array<string>;
  processUrls?: Map<number, string>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        options?: { cwd?: string };
      };
      const url = `http://127.0.0.1:${59000 + state.spawnUrls.length}`;
      const pid = 59_000 + state.spawnUrls.length;
      state.spawnUrls.push(url);
      state.spawnCwds?.push(cmd.options?.cwd);
      state.processUrls?.set(pid, url);
      return Effect.succeed(
        mockOpenCodeServerHandle({
          stdout: `opencode server listening on ${url}\n`,
          stderr: "",
          pid,
          kill: () =>
            Effect.sync(() => {
              state.killUrls.push(url);
            }),
        }),
      );
    }),
  );
}

function openCodeRuntimePoolTestLayer(state: {
  spawnUrls: Array<string>;
  killUrls: Array<string>;
}) {
  const processUrls = new Map<number, string>();
  return makeOpenCodeRuntimeLive({
    teardownProcessTree: async ({ rootPid }) => {
      const url = processUrls.get(rootPid);
      if (url) state.killUrls.push(url);
      return { escalated: false, signalErrors: [] };
    },
  }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls })));
}

describe("toOpenCodeFileParts", () => {
  it("materializes image attachments as SDK file parts", () => {
    const attachment = {
      type: "image",
      id: "thread-attachment-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/penkra-attachments/screenshot.png",
      }),
    ).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "file:///tmp/penkra-attachments/screenshot.png",
      },
    ]);
  });

  it("leaves generic files for prompt-path projection", () => {
    const attachment = {
      type: "file",
      id: "thread-attachment-file",
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/penkra-attachments/notes.docx",
      }),
    ).toEqual([]);
  });
});

describe("buildOpenCodeServerProcessEnv", () => {
  it("does not override file-based config with synthetic empty config content", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        PATH: "/usr/bin",
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("does not inherit process-global OpenCode configuration", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("strips inherited credentials and Penkra authority from managed server processes", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENAI_API_KEY: "provider-key",
        PENKRA_AUTH_TOKEN: "server-secret",
        PENKRA_TEST_CONTROL_SOCKET: "/tmp/control.sock",
      },
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PENKRA_AUTH_TOKEN).toBeUndefined();
    expect(env.PENKRA_TEST_CONTROL_SOCKET).toBeUndefined();
  });
});

describe("OpenCodeRuntime startup diagnostics", () => {
  it("reads only provider models for session startup", async () => {
    const calls: string[] = [];
    const client = {
      provider: {
        list: async () => {
          calls.push("provider.list");
          return { data: { connected: [], all: [], default: {} } };
        },
      },
      app: {
        agents: async () => {
          calls.push("app.agents");
          return { data: [] };
        },
      },
      experimental: {
        console: {
          get: async () => {
            calls.push("experimental.console.get");
            return { data: null };
          },
        },
      },
    } as unknown as OpencodeClient;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          yield* runtime.loadOpenCodeProviderList(client);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive().pipe(
            Layer.provide(mockOpenCodeServerSpawnerLayer({ stdout: "", stderr: "" })),
          ),
        ),
      ),
    );
    expect(calls).toEqual(["provider.list"]);
  });

  it("lets the provider bind an ephemeral port instead of probing and releasing one", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(
            Layer.provide(mockOpenCodeServerSpawnerLayer({ stdout: "booting\n", stderr: "" })),
          ),
        ),
      ),
    );
    expect(error.detail).toContain(
      "command: /custom/bin/opencode serve --hostname 127.0.0.1 --port 0",
    );
  });

  it("includes command and partial process output when server startup times out", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "booting custom OpenCode wrapper\n",
                stderr: "loading provider credentials\n",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("Timed out waiting for OpenCode server start after 5ms.");
    expect(error.detail).toContain(
      "command: /custom/bin/opencode serve --hostname 127.0.0.1 --port 58123",
    );
    expect(error.detail).toContain('OpenCode ready prefix: "opencode server listening"');
    expect(error.detail).toContain("stdout:\nbooting custom OpenCode wrapper");
    expect(error.detail).toContain("stderr:\nloading provider credentials");
  });

  it("redacts likely secrets from startup timeout diagnostics and causes", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "OPENAI_API_KEY=sk-live-123\nauth_token: token-abc\nsafe line\n",
                stderr: 'Authorization: Bearer auth-secret\nserverPassword="pw-secret"\n',
              }),
            ),
          ),
        ),
      ),
    );
    const causeJson = JSON.stringify(error.cause);

    expect(error.detail).toContain("OPENAI_API_KEY=[redacted]");
    expect(error.detail).toContain("auth_token: [redacted]");
    expect(error.detail).toContain("Authorization: Bearer [redacted]");
    expect(error.detail).toContain('serverPassword="[redacted]"');
    expect(error.detail).toContain("safe line");
    for (const secret of ["sk-live-123", "token-abc", "auth-secret", "pw-secret"]) {
      expect(error.detail).not.toContain(secret);
      expect(causeJson).not.toContain(secret);
    }
  });
});

describe("OpenCodeRuntime local server pool", () => {
  it("disconnect waits for a pending native start and closes its process credential before returning", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const revoked: string[] = [];
          let credentialsCurrent = true;
          const spawner = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.as(
                  mockOpenCodeServerHandle({
                    stdout: "opencode server listening on http://127.0.0.1:59000\n",
                    stderr: "",
                    ready: Deferred.await(release),
                  }),
                ),
              ),
            ),
          );
          const layer = makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(Layer.provide(spawner));
          yield* Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const input = {
              binaryPath: "opencode",
              poolIsolationKey: "pending-profile",
              assertCurrentCredentials: Effect.suspend(() =>
                credentialsCurrent ? Effect.void : Effect.fail(new Error("Credential retired")),
              ),
              connectionId: ProviderConnectionId.make("pending-account"),
              gateway: {
                url: "http://gateway/mcp",
                issue: () => "pending-token",
                revoke: (token: string) => {
                  revoked.push(token);
                },
              },
            };
            const starting = yield* runtime
              .connectToOpenCodeServer(input)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(entered);
            credentialsCurrent = false;
            const stopping = yield* runtime
              .stopAccount(input.connectionId)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.sync(() => expect(stopping.pollUnsafe()).toBeUndefined()).pipe(
              Effect.ensuring(Deferred.succeed(release, undefined)),
            );
            yield* Fiber.join(starting);
            yield* Fiber.join(stopping);
            expect(revoked).toEqual(["pending-token"]);
            expect((yield* Effect.result(runtime.connectToOpenCodeServer(input)))._tag).toBe(
              "Failure",
            );
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });
  it("does not hold another Connection's startup behind a pending ready acknowledgement", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let peerSpawned = false;
          const spawner = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                const cwd = (command as unknown as { options: { cwd: string } }).options.cwd;
                const blocked = cwd === "/blocked";
                if (blocked) yield* Deferred.succeed(entered, undefined);
                else peerSpawned = true;
                return mockOpenCodeServerHandle({
                  stdout: `opencode server listening on http://127.0.0.1:${blocked ? 59000 : 59001}\n`,
                  stderr: "",
                  ready: blocked ? Deferred.await(release) : Effect.void,
                });
              }),
            ),
          );
          const layer = makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(Layer.provide(spawner));
          yield* Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const first = yield* runtime
              .connectToOpenCodeServer({
                binaryPath: "opencode",
                cwd: "/blocked",
                poolIsolationKey: "account-a",
              })
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(entered);
            const second = yield* runtime
              .connectToOpenCodeServer({
                binaryPath: "opencode",
                cwd: "/peer",
                poolIsolationKey: "account-b",
              })
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.yieldNow;
            yield* Effect.sync(() => expect(peerSpawned).toBe(true)).pipe(
              Effect.ensuring(Deferred.succeed(release, undefined)),
            );
            yield* Fiber.join(first);
            yield* Fiber.join(second);
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });
  it("owns one gateway credential across folders on a Connection and revokes it only at process close", async () => {
    const state = { spawnUrls: [] as string[], killUrls: [] as string[] };
    let issued = 0;
    const revoked: string[] = [];
    const gateway = {
      url: "http://gateway/mcp",
      issue: () => `process-${++issued}`,
      revoke: (token: string) => {
        revoked.push(token);
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const first = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            cwd: "/repo/a",
            poolIsolationKey: "installation:profile-a",
            assertCurrentCredentials: Effect.void,
            connectionId: ProviderConnectionId.make("a"),
            gateway,
          });
          const second = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            cwd: "/repo/b",
            poolIsolationKey: "installation:profile-a",
            assertCurrentCredentials: Effect.void,
            connectionId: ProviderConnectionId.make("a"),
            gateway,
          });
          expect(first.url).toBe(second.url);
          expect(first.gatewayProcessToken).toBe("process-1");
          expect(second.gatewayProcessToken).toBe(first.gatewayProcessToken);
          expect(issued).toBe(1);
          expect(state.spawnUrls).toHaveLength(1);
          expect(revoked).toEqual([]);
          yield* runtime.stopAccount(ProviderConnectionId.make("a"));
          expect(revoked).toEqual(["process-1"]);
          expect(state.killUrls).toEqual(state.spawnUrls);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
    expect(revoked).toEqual(["process-1"]);
  });
  it("keeps server scope closure pending until process-tree exit is proven", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let teardownCalls = 0;
    const layer = makeOpenCodeRuntimeLive({
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        expect(rootPid).toBe(1);
        await exitProof;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59000\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make("sequential");
          yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, serverScope));

          const closing = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(1);
          expect(closing.pollUnsafe()).toBeUndefined();

          proveExit?.();
          yield* Fiber.join(closing);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("reuses a local server after all thread scopes close until explicit shutdown", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.external).toBe(false);
          expect(first.url).toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* Scope.close(firstScope, Exit.void);
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual([]);
          yield* runtime.stopAll();
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

          const thirdScope = yield* Scope.make();
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));
          expect(third.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("isolates same-cwd accounts and stops only the removed account", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "penkra-thread-a",
              connectionId: ProviderConnectionId.make("account-a"),
              assertCurrentCredentials: Effect.void,
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "penkra-thread-b",
              connectionId: ProviderConnectionId.make("account-b"),
              assertCurrentCredentials: Effect.void,
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.url).not.toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          expect(state.killUrls).toEqual([]);
          yield* runtime.stopAccount(ProviderConnectionId.make("account-a"));
          const late = yield* Effect.result(
            runtime.connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "late-a",
              connectionId: ProviderConnectionId.make("account-a"),
              assertCurrentCredentials: Effect.fail(new Error("Credential retired")),
            }),
          );
          expect(late._tag).toBe("Failure");
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
          const sameAccount = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            cwd: "/repo",
            poolIsolationKey: "penkra-thread-b",
            connectionId: ProviderConnectionId.make("account-b"),
            assertCurrentCredentials: Effect.void,
          });
          expect(sameAccount.url).toBe(second.url);
          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
          yield* runtime.stopAll();
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
          const refreshed = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            cwd: "/repo",
            poolIsolationKey: "new-profile-a",
            connectionId: ProviderConnectionId.make("account-a"),
            assertCurrentCredentials: Effect.void,
          });
          expect(refreshed.url).toBe("http://127.0.0.1:59002");
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("does not spawn or pool when an external OpenCode server URL is configured", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connection = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            serverUrl: " http://127.0.0.1:9999 ",
          });

          expect(connection).toMatchObject({
            url: "http://127.0.0.1:9999",
            exitCode: null,
            external: true,
          });
          expect(state.spawnUrls).toEqual([]);
          expect(state.killUrls).toEqual([]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps the warm server alive across successive thread scopes", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));

          yield* Scope.close(firstScope, Exit.void);

          const secondScope = yield* Scope.make();
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual([]);
          yield* runtime.stopAll();
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps incompatible local server keys separate", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const defaultServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const customServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "/custom/bin/opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(defaultServer.url).toBe("http://127.0.0.1:59000");
          expect(customServer.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("starts local servers in the requested cwd and separates cwd-specific pools", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      spawnCwds: [] as Array<string | undefined>,
      killUrls: [] as Array<string>,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const thirdScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/beta" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));

          expect(first.url).toBe("http://127.0.0.1:59000");
          expect(second.url).toBe("http://127.0.0.1:59001");
          expect(third.url).toBe(first.url);
          expect(state.spawnCwds).toEqual(["/repo/alpha", "/repo/beta"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });
});

describe("parseOpenCodeCredentialProviderIDs", () => {
  it("returns top-level provider ids from the OpenCode credential store", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "openai": {
    "type": "oauth"
  },
  "opencode": {
    "type": "api"
  }
}`);

    expect(providerIDs).toEqual(["openai", "opencode"]);
  });

  it("ignores non-object entries and empty keys", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "": {
    "type": "oauth"
  },
  "openai": {
    "type": "oauth"
  },
  "broken": "nope"
}`);

    expect(providerIDs).toEqual(["openai"]);
  });
});
