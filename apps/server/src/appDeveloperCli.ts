import { spawn } from "node:child_process";
import * as Path from "node:path";

import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { packageAppDirectory, testAppDirectory } from "./appDeveloperTools";
import { requestAppRuntimeBridge } from "./appRuntimeCli";

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
      Effect.flatMap(() =>
        Console.log(
          JSON.stringify(
            {
              package: Path.resolve(packagePath),
              bundle: Path.resolve(bundle),
            },
            null,
            2,
          ),
        ),
      ),
    ),
).pipe(
  Command.withDescription("Create a standard keyless Sigstore bundle for a Penkra App package."),
);

const testCommand = Command.make(
  "test",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    desktop: Flag.string("desktop").pipe(
      Flag.optional,
      Flag.withDescription("Built @penkra/desktop directory."),
    ),
  },
  ({ directory, desktop }) =>
    Effect.tryPromise({
      try: () =>
        testAppDirectory({
          directory,
          ...(desktop._tag === "Some" ? { desktopDirectory: desktop.value } : {}),
        }),
      catch: toError,
    }).pipe(Effect.flatMap((evidence) => Console.log(JSON.stringify(evidence, null, 2)))),
).pipe(Command.withDescription("Run an unpacked App in an isolated temporary Penkra host."));

const preflightCommand = Command.make(
  "preflight",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    output: Flag.string("output").pipe(Flag.withDescription("Output .penkra archive path.")),
    desktop: Flag.string("desktop").pipe(
      Flag.optional,
      Flag.withDescription("Built @penkra/desktop directory."),
    ),
  },
  ({ directory, output, desktop }) =>
    Effect.tryPromise({
      try: async () => ({
        package: await packageAppDirectory({ directory, output }),
        integration: await testAppDirectory({
          directory,
          ...(desktop._tag === "Some" ? { desktopDirectory: desktop.value } : {}),
        }),
      }),
      catch: toError,
    }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2)))),
).pipe(Command.withDescription("Validate, package, and run an App in the isolated host."));

const publisherListCommand = Command.make("list", {}, () => bridge("developer.publishers.list"));
const publisherCreateCommand = Command.make(
  "create",
  {
    slug: Flag.string("slug"),
    displayName: Flag.string("name"),
    domain: Flag.string("domain").pipe(Flag.optional),
  },
  ({ slug, displayName, domain }) =>
    bridge("developer.publishers.create", {
      slug,
      displayName,
      ...(domain._tag === "Some" ? { domain: domain.value } : {}),
    }),
);
const publisherCommand = Command.make("publisher").pipe(
  Command.withDescription("Manage the signed-in account's App publisher."),
  Command.withSubcommands([publisherListCommand, publisherCreateCommand]),
);

const registryAppListCommand = Command.make(
  "list",
  { publisherId: Flag.string("publisher-id") },
  ({ publisherId }) => bridge("developer.apps.list", { publisherId }),
);
const registryAppCreateCommand = Command.make(
  "create",
  {
    publisherId: Flag.string("publisher-id"),
    identifier: Flag.string("identifier"),
    slug: Flag.string("slug"),
    displayName: Flag.string("name"),
    summary: Flag.string("summary"),
    visibility: Flag.choice("visibility", ["public", "private"]),
  },
  (input) => bridge("developer.apps.create", input),
);
const registryAppCommand = Command.make("registry-app").pipe(
  Command.withDescription("Register and inspect Apps owned by a publisher."),
  Command.withSubcommands([registryAppListCommand, registryAppCreateCommand]),
);

const visibilitySetCommand = Command.make(
  "set",
  {
    appId: Flag.string("app-id"),
    visibility: Flag.choice("visibility", ["public", "private"]),
  },
  (input) => bridge("developer.apps.visibility.set", input),
);
const visibilityCommand = Command.make("visibility").pipe(
  Command.withDescription("Change whether an App is publicly discoverable or invitation-only."),
  Command.withSubcommands([visibilitySetCommand]),
);

const accessInviteCommand = Command.make(
  "invite",
  { appId: Flag.string("app-id"), email: Flag.string("email") },
  (input) => bridge("developer.app-access.invite", input),
);
const accessListCommand = Command.make("list", { appId: Flag.string("app-id") }, (input) =>
  bridge("developer.app-access.list", input),
);
const accessRevokeCommand = Command.make(
  "revoke",
  { appId: Flag.string("app-id"), invitationId: Flag.string("invitation-id") },
  (input) => bridge("developer.app-access.revoke", input),
);
const accessCommand = Command.make("access").pipe(
  Command.withDescription("Manage invitation-only access to a private App."),
  Command.withSubcommands([accessInviteCommand, accessListCommand, accessRevokeCommand]),
);

const submitCommand = Command.make(
  "submit",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    appId: Flag.string("app-id"),
    output: Flag.string("output"),
    bundle: Flag.string("bundle"),
    issuer: Flag.string("issuer"),
  },
  ({ directory, appId, output, bundle, issuer }) =>
    Effect.tryPromise({
      try: async () => {
        const evidence = await packageAppDirectory({ directory, output });
        await runCosign(evidence.path, bundle);
        return requestAppRuntimeBridge("developer.submissions.create", {
          appId,
          packagePath: evidence.path,
          signaturePath: Path.resolve(bundle),
          issuer,
          evidence,
        });
      },
      catch: toError,
    }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2)))),
).pipe(Command.withDescription("Package, keyless-sign, upload, and finalize an App submission."));

const submissionListCommand = Command.make("list", { appId: Flag.string("app-id") }, ({ appId }) =>
  bridge("developer.submissions.list", { appId }),
);
const submissionGetCommand = Command.make(
  "get",
  { submissionId: Argument.string("submission-id") },
  ({ submissionId }) => bridge("developer.submissions.get", { submissionId }),
);
const submissionCommand = Command.make("submission").pipe(
  Command.withDescription("Inspect durable submission validation and publication state."),
  Command.withSubcommands([submissionListCommand, submissionGetCommand]),
);

export const appDeveloperCommand = Command.make("app").pipe(
  Command.withDescription("Build, sign, test, and publish Penkra Apps."),
  Command.withSubcommands([
    packageCommand,
    signCommand,
    testCommand,
    preflightCommand,
    publisherCommand,
    registryAppCommand,
    visibilityCommand,
    accessCommand,
    submitCommand,
    submissionCommand,
  ]),
);

function bridge(method: string, params?: unknown) {
  return Effect.tryPromise({
    try: () => requestAppRuntimeBridge(method, params),
    catch: toError,
  }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))));
}

function runCosign(packagePath: string, bundle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cosign",
      ["sign-blob", Path.resolve(packagePath), "--bundle", Path.resolve(bundle)],
      { stdio: "inherit", shell: false },
    );
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("cosign is required for App signing. Install Cosign and retry.")
          : error,
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `cosign sign-blob failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
