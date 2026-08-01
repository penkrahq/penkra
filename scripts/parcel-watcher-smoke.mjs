#!/usr/bin/env node
// FILE: parcel-watcher-smoke.mjs
// Purpose: Verifies the staged native watcher loads and reports a real file change.
// Layer: Release smoke check

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requireRoot = process.env.PENKRA_PARCEL_WATCHER_SMOKE_REQUIRE_ROOT?.trim() || process.cwd();
const requireFromTarget = createRequire(resolve(requireRoot, "package.json"));
const watcher = requireFromTarget("@parcel/watcher");
const directory = await mkdtemp(join(tmpdir(), "penkra-parcel-watcher-"));
let subscription;

try {
  let resolveObserved;
  let rejectObserved;
  const observed = new Promise((resolveEvent, rejectEvent) => {
    resolveObserved = resolveEvent;
    rejectObserved = rejectEvent;
  });
  subscription = await watcher.subscribe(directory, (error, events) => {
    if (error) {
      rejectObserved(error);
      return;
    }
    if (events.some((event) => event.path.endsWith("watcher-smoke.txt"))) resolveObserved();
  });
  await writeFile(join(directory, "watcher-smoke.txt"), "ok\n", "utf8");
  let timeout;
  await Promise.race([
    observed,
    new Promise(
      (_, reject) =>
        (timeout = setTimeout(
          () => reject(new Error("Timed out waiting for watcher event.")),
          5_000,
        )),
    ),
  ]);
  clearTimeout(timeout);
  console.log("[parcel-watcher-smoke] native watcher loaded and observed a file change.");
} finally {
  await subscription?.unsubscribe();
  await rm(directory, { recursive: true, force: true });
}
