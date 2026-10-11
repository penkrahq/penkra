import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";
import { ProcessLogFile } from "@penkra/shared/logging";

import { ServerConfig } from "./config";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./privatePathPermissions";

export function makeServerFileLogger(serverLogPath: string): Logger.Logger<unknown, void> {
  const sink = new ProcessLogFile(serverLogPath);
  return Logger.map(Logger.formatSimple, (line) => sink.write(`${line}\n`));
}

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;
  yield* Effect.sync(() => {
    try {
      ensurePrivateDirectorySync(logsDir);
      ensurePrivateFileSync(serverLogPath);
    } catch {
      // Logging must not prevent startup.
    }
  });
  const fileLogger = yield* Effect.sync(() => makeServerFileLogger(serverLogPath));
  return Logger.layer([Logger.defaultLogger, fileLogger], { mergeWithExisting: false });
}).pipe(Layer.unwrap);
