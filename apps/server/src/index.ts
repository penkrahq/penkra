import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, penkraCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@penkra/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { maybeRunAppRuntimeCli } from "./appRuntimeCli";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const args = process.argv.slice(2);
void maybeRunAppRuntimeCli(args)
  .then((handled) => {
    if (handled) return;
    Command.run(penkraCli, { version })
      .pipe(Effect.provide(RuntimeLayer))
      .pipe((program) => NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>));
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
