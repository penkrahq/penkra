import { spawn } from "node:child_process";
import * as Path from "node:path";

import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { packageAppDirectory } from "./appDeveloperTools";

const packageCommand = Command.make(
  "package",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    output: Flag.string("output").pipe(Flag.withDescription("Output .penkra archive path.")),
  },
  ({ directory, output }) =>
    Effect.tryPromise({
      try: () => packageAppDirectory({ directory, output }),
      catch: toError,
    }).pipe(Effect.flatMap((evidence) => Console.log(JSON.stringify(evidence, null, 2)))),
).pipe(Command.withDescription("Validate and create a deterministic Penkra App package."));

const signCommand = Command.make(
  "sign",
  {
    package: Argument.path("package", { pathType: "file", mustExist: true }),
    bundle: Flag.string("bundle").pipe(Flag.withDescription("Output Sigstore bundle JSON path.")),
  },
  ({ package: packagePath, bundle }) =>
    Effect.tryPromise({
      try: () => runCosign(packagePath, bundle),
      catch: toError,
    }).pipe(
      Effect.flatMap(() => Console.log(JSON.stringify({
        package: Path.resolve(packagePath),
        bundle: Path.resolve(bundle),
      }, null, 2))),
    ),
).pipe(Command.withDescription("Create a standard keyless Sigstore bundle for a Penkra App package."));

export const appDeveloperCommand = Command.make("app").pipe(
  Command.withDescription("Build, sign, test, and publish Penkra Apps."),
  Command.withSubcommands([packageCommand, signCommand]),
);

function runCosign(packagePath: string, bundle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cosign", [
      "sign-blob",
      Path.resolve(packagePath),
      "--bundle",
      Path.resolve(bundle),
    ], { stdio: "inherit", shell: false });
    child.once("error", (error) => {
      reject(error.code === "ENOENT"
        ? new Error("cosign is required for App signing. Install Cosign and retry.")
        : error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`cosign sign-blob failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`));
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
