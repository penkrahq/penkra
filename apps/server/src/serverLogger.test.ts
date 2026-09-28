import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Logger } from "effect";
import { afterEach, expect, it } from "vitest";

import { makeRotatingServerFileLogger } from "./serverLogger";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("rotates server.log at the configured byte and file limits", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-server-log-"));
  directories.push(directory);
  const filePath = path.join(directory, "server.log");
  const logger = makeRotatingServerFileLogger(filePath, 240, 2);
  for (let i = 0; i < 20; i++) {
    await Effect.runPromise(
      Effect.logInfo(`rotation-entry-${i}`).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  }
  const names = fs.readdirSync(directory).sort();
  expect(names).toContain("server.log.1");
  expect(names).not.toContain("server.log.3");
  expect(names.every((name) => fs.statSync(path.join(directory, name)).size <= 240)).toBe(true);
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  const retained = names
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("");
  expect(retained).toContain("rotation-entry-19");
});
