# Penkra Dev launcher diagnostics

`Penkra Dev.app` is a short-lived macOS entry point. It starts a detached supervisor
and exits, so LaunchServices never mistakes a long-running Node process for an
unresponsive application. The supervisor owns the Vite and Electron development
processes.

Run the self-check from the repository:

```sh
npm run dev:status
```

The command exits successfully only when all four checks pass:

- the recorded development process is alive;
- the recorded Electron main process is alive;
- Vite returns a successful HTTP response on `127.0.0.1:5173`; and
- Electron reports that the renderer finished loading.

The status phases identify the failing layer:

- `preflight`: repository files, the development script, or npm could not be found;
- `starting-development-process`: npm could not be spawned;
- `waiting-for-vite`: Vite failed, exited, or never opened its HTTP endpoint;
- `waiting-for-electron`: Vite started, but Electron did not reach `app.ready`;
- `waiting-for-renderer`: Electron started, but its window did not finish loading;
- `ready`: all live checks passed;
- `failed`: inspect `failedPhase` and `failure`;
- `stopped`: the development process exited, with its exit code or signal recorded.

Diagnostic files:

- `~/Library/Application Support/Penkra Dev/status.json`: latest lifecycle phase;
- `~/Library/Application Support/Penkra Dev/runtime-failure.json`: latest renderer
  load, crash, or unresponsive event;
- `~/Library/Logs/Penkra Dev/launcher.log`: timestamped launcher phase history;
- `~/Library/Logs/Penkra Dev/development.log`: Vite, Electron, and renderer output.

Electron diagnostics in `development.log` begin with `[penkra-electron]` and include
application readiness, window loading, renderer termination, unresponsive windows,
child-process termination, and uncaught main-process errors.
