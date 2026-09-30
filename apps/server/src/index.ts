import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";

import { CliConfig, penkraCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { runDiagnosticsCli } from "./diagnostics/cli";
import { serverExitCodeForRuntimeCode } from "./diagnostics/preStoreStartup";
import { NetService } from "@penkra/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

if (process.argv[2] === "diagnostics") {
  try {
    runDiagnosticsCli(process.argv.slice(3));
  } catch (cause) {
    process.stderr.write(`penkra diagnostics: ${(cause as Error).message}\n`);
    process.exitCode = 1;
  }
} else {
  Command.run(penkraCli, { version })
    .pipe(Effect.provide(RuntimeLayer))
    .pipe((program) =>
      NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>, {
        teardown: (exit, onExit) =>
          Runtime.defaultTeardown(exit, (code) => onExit(serverExitCodeForRuntimeCode(code))),
      }),
    );
}
