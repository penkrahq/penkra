// Bundle with Bun --target=node --format=cjs, then run with Node.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { AppCommandPipeServer } = require("../../apps/desktop/src/appCommandPipeServer.ts");
const { RemoteLifecycleHost } = require("../../apps/desktop/src/remoteLifecycleHost.ts");
const {
  watchDesktopRemoteLifecycle,
} = require("../../apps/server/src/remoteLink/desktopLifecycle.ts");
const { RemoteAccountLifetime } = require("../../apps/server/src/remoteLink/accountLifetime.ts");
const { RemoteRelayConnection } = require("../../apps/server/src/remoteLink/relayConnection.ts");
const { WebSocketServer } = require("ws");
const http = require("node:http");
const { fork } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const parent = path.resolve(".penkra/scratch/remote-lifecycle");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "pipe-"));
  const pipe = path.relative(process.cwd(), path.join(root, "command.sock"));
  const snapshot = {
    accountServiceUrl: "https://account.example.test",
    accountId: "a",
    accessOn: true,
    suspended: false,
  };
  const host = new RemoteLifecycleHost(snapshot);
  const server = new AppCommandPipeServer({
    path: pipe,
    token: "fixture",
    adminToken: "backend-fixture",
    remoteLifecycle: host,
    catalog: {},
    broker: {},
    observer: {},
    providerCredentialVault: {},
    readFolderTabs: async () => [],
    tabs: { list: () => [], hostedPageState: () => ({}), current: () => null, close: () => {} },
    presentation: () => ({ state: "background" }),
  });
  const env = {
    PENKRA_APP_COMMAND_PIPE: pipe,
    PENKRA_APP_COMMAND_TOKEN: "fixture",
    PENKRA_APP_COMMAND_ADMIN_TOKEN: "backend-fixture",
  };
  const parentSignal = new AbortController();
  const controllers = [parentSignal];
  const watches = [];
  const opened = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  const release = Promise.withResolvers();
  const gates = [release];
  const closed = Promise.withResolvers();
  const events = [];
  const owner = new RemoteAccountLifetime((state) => {
    events.push(state.accountId);
    if (state.accountId === "a") opened.resolve();
    return {
      reconnect: () => {},
      close: async () => {
        if (state.accountId === "a") {
          stopping.resolve();
          await release.promise;
          events.push("old-closed");
        }
      },
    };
  });
  let watching;
  try {
    await server.start();
    watching = watchDesktopRemoteLifecycle({
      env,
      signal: parentSignal.signal,
      apply: (event, signal) => owner.apply(event, signal),
      closeOwner: async () => {
        await owner.close();
        events.push("disconnected-closed");
        closed.resolve();
      },
    });
    watches.push(watching);
    await opened.promise;
    let acknowledged = false;
    const switched = host.transition("sign-in", { ...snapshot, accountId: "b" }).then(() => {
      acknowledged = true;
    });
    await stopping.promise;
    assert.equal(acknowledged, false);
    assert.deepEqual(events, ["a"]);
    release.resolve();
    await switched;
    assert.deepEqual(events, ["a", "old-closed", "b"]);
    parentSignal.abort();
    await watching;
    await closed.promise;
    assert.equal(events.at(-1), "disconnected-closed");

    // A replacement backend starts from authoritative current state, not an
    // assumed revision zero or replay of events emitted while disconnected.
    const restarted = new AbortController();
    controllers.push(restarted);
    const restored = Promise.withResolvers();
    const resumeSnapshot = Promise.withResolvers();
    const heldTransition = Promise.withResolvers();
    const releaseTransition = Promise.withResolvers();
    const sleepStarted = Promise.withResolvers();
    const finishSleep = Promise.withResolvers();
    gates.push(resumeSnapshot, releaseTransition, finishSleep);
    const seen = [];
    const watchingAgain = watchDesktopRemoteLifecycle({
      env,
      signal: restarted.signal,
      apply: async (event) => {
        seen.push([event.event, event.snapshot.accountId]);
        if (event.event === "snapshot") {
          assert.equal(event.snapshot.accountId, "b");
          restored.resolve();
          await resumeSnapshot.promise;
        }
        if (event.event === "access" && event.snapshot.accountId === "c") {
          heldTransition.resolve();
          await releaseTransition.promise;
        }
        if (event.event === "suspend") {
          sleepStarted.resolve();
          await finishSleep.promise;
        }
      },
      closeOwner: async () => {},
    });
    watches.push(watchingAgain);
    await restored.promise;
    const signedOut = host.transition("sign-out", {
      ...snapshot,
      accountId: null,
      accessOn: false,
    });
    const signedIn = host.transition("sign-in", { ...snapshot, accountId: "c" });
    assert.equal(signedOut, signedIn);
    resumeSnapshot.resolve();
    await signedIn;
    assert.deepEqual(seen, [
      ["snapshot", "b"],
      ["sign-in", "c"],
    ]);
    const held = host.transition("access", { ...snapshot, accountId: "c" });
    await heldTransition.promise;
    const sleeping = host.transition("suspend", {
      ...snapshot,
      accountId: "c",
      suspended: true,
    });
    const waking = host.transition("wake", { ...snapshot, accountId: "c" });
    releaseTransition.resolve();
    await sleepStarted.promise;
    assert.equal(seen.at(-1)[0], "suspend");
    finishSleep.resolve();
    await Promise.all([held, sleeping, waking]);
    assert.deepEqual(seen.slice(-3), [
      ["access", "c"],
      ["suspend", "c"],
      ["wake", "c"],
    ]);
    restarted.abort();
    await watchingAgain;
    const connectedBeforeFailure = Promise.withResolvers();
    const joinedAfterFailure = Promise.withResolvers();
    const failure = watchDesktopRemoteLifecycle({
      env,
      signal: new AbortController().signal,
      apply: async () => connectedBeforeFailure.resolve(),
      closeOwner: async () => joinedAfterFailure.resolve(),
    }).then(
      () => null,
      (error) => error,
    );
    watches.push(failure);
    await connectedBeforeFailure.promise;
    await server.dispose();
    await joinedAfterFailure.promise;
    assert((await failure) instanceof Error);
    await assert.rejects(
      host.transition("sign-out", { ...snapshot, accountId: null, accessOn: false }),
      /cleanup has not been acknowledged/,
    );
    // A closed pipe is not exit proof. Here the owned fixture backend actually
    // exits; only then may the supervisor acknowledge that all its work ended.
    await server.start();
    const child = fork(path.resolve(process.argv[1]), ["--backend-fixture-child"], {
      env: { ...env, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error("Fixture backend exited before its lifecycle snapshot.");
        }),
      ]);
      child.kill("SIGTERM");
      await exited;
      host.backendExited();
      await host.transition("sign-out", { ...snapshot, accountId: null, accessOn: false });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    }
    console.log(
      "PASS real private pipe: delayed cleanup acknowledgement, ordered account switch, disconnect join, backend restart snapshot, bounded latest-state coalescing, abrupt-disconnect failure",
    );
  } finally {
    for (const gate of gates) gate.resolve();
    for (const controller of controllers) controller.abort();
    await server.dispose();
    await Promise.allSettled(watches);
    await fs.rm(root, { recursive: true });
  }
}

async function realRelayOwnership() {
  const server = http.createServer();
  const relay = new WebSocketServer({ noServer: true });
  const upgrades = [];
  server.on("upgrade", (request, socket, head) => {
    upgrades.push(request.headers.authorization);
    relay.handleUpgrade(request, socket, head, () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ready = Promise.withResolvers();
  const cleanupStarted = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  const replacementReady = Promise.withResolvers();
  const owner = new RemoteAccountLifetime((snapshot, signal) => {
    const connection = new RemoteRelayConnection({
      url: `ws://127.0.0.1:${server.address().port}/v1`,
      deviceToken: snapshot.accountId,
      signal,
      onFrame: () => undefined,
      observe: () => {},
      observeReconnect: () => {},
      onOpen: () => {
        if (snapshot.accountId === "a") ready.resolve();
        else replacementReady.resolve();
        return async () => {
          if (snapshot.accountId === "a") {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
        };
      },
    });
    return { reconnect: (event) => connection.reconnect(event), close: () => connection.close() };
  });
  const snapshot = {
    accountServiceUrl: "https://account.example.test",
    accountId: "a",
    accessOn: true,
    suspended: false,
  };
  const signal = new AbortController().signal;
  try {
    await owner.apply(
      { type: "remote.lifecycle", revision: 0, event: "snapshot", snapshot },
      signal,
    );
    await ready.promise;
    const switching = owner.apply(
      {
        type: "remote.lifecycle",
        revision: 1,
        event: "sign-in",
        snapshot: { ...snapshot, accountId: "b" },
      },
      signal,
    );
    await cleanupStarted.promise;
    assert.deepEqual(upgrades, ["Bearer a"]);
    releaseCleanup.resolve();
    await switching;
    await replacementReady.promise;
    assert.deepEqual(upgrades, ["Bearer a", "Bearer b"]);
    console.log(
      "PASS real relay: account B cannot connect until account A's relay/session cleanup finishes",
    );
  } finally {
    releaseCleanup.resolve();
    await owner.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.argv.includes("--backend-fixture-child")) {
  watchDesktopRemoteLifecycle({
    signal: new AbortController().signal,
    apply: async () => {
      process.send("ready");
    },
    closeOwner: async () => {},
  }).catch(() => {
    process.exitCode = 1;
    process.disconnect();
  });
} else {
  main()
    .then(realRelayOwnership)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
