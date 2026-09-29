import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";
import { RotatingFileSink } from "@penkra/shared/logging";

import { ServerConfig } from "./config";
import { DIAGNOSTIC_LIMITS } from "./diagnostics/limits";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./privatePathPermissions";

export function makeRotatingServerFileLogger(
  serverLogPath: string,
  maxBytes: number = DIAGNOSTIC_LIMITS.serverLogBytes,
  maxFiles: number = DIAGNOSTIC_LIMITS.serverLogFiles,
): Logger.Logger<unknown, void> {
  const sink = new RotatingFileSink({
    filePath: serverLogPath,
    maxBytes,
    maxFiles: Math.max(0, maxFiles - 1),
    mode: 0o600,
    throwOnError: true,
  });
  return Logger.map(Logger.formatSimple, (line) => sink.write(`${line}\n`));
}

export function shouldWriteServerFileLog(environment: NodeJS.ProcessEnv): boolean {
  // Desktop captures the server's stdout into the rotating server-child.log.
  // Writing the same formatted lines to server.log doubles the disk cost.
  return !environment.PENKRA_SERVER_ENTRY;
}

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;

  if (!shouldWriteServerFileLog(process.env)) {
    return Logger.layer([Logger.defaultLogger], { mergeWithExisting: false });
  }

  yield* Effect.sync(() => {
    ensurePrivateDirectorySync(logsDir);
    ensurePrivateFileSync(serverLogPath);
  });

  const fileLogger = yield* Effect.sync(() => makeRotatingServerFileLogger(serverLogPath));

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
