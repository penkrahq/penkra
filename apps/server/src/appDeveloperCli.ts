// FILE: appDeveloperCli.ts
// Purpose: Exposes the small, end-to-end public workflow for building and publishing Penkra Apps.
// Layer: Developer CLI

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  packageAppDirectory,
  testAppDirectory,
  type AppPackageEvidence,
} from "./appDeveloperTools";
import { requestAppRuntimeBridge } from "./appRuntimeCli";

const APP_GUIDE_URL = "https://github.com/Emanuele-web04/Penkra/blob/main/docs/app-development.md";
const DEFAULT_SIGSTORE_ISSUER = "https://oauth2.sigstore.dev/auth";

const packageCommand = Command.make(
  "package",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    output: Flag.string("output").pipe(Flag.withDescription("Output .penkra archive path.")),
  },
  ({ directory, output }) =>
    attempt(() => packageAppDirectory({ directory, output })).pipe(printJson),
).pipe(Command.withDescription("Validate and create a deterministic Penkra App package."));

const testCommand = Command.make(
  "test",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
  },
  ({ directory }) => attempt(() => testAppDirectory({ directory })).pipe(printJson),
).pipe(Command.withDescription("Run an unpacked App in an isolated temporary Penkra host."));

const sideloadCommand = Command.make(
  "sideload",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
  },
  ({ directory }) => bridge("developer.sideload", { sourcePath: Path.resolve(directory) }),
).pipe(
  Command.withDescription(
    "Load and watch an unpacked App in the running Penkra development instance.",
  ),
);

const publishCommand = Command.make(
  "publish",
  {
    directory: Argument.path("directory", { pathType: "directory", mustExist: true }),
    visibility: Flag.choice("visibility", ["public", "private"]).pipe(
      Flag.withDefault("private"),
      Flag.withDescription("Registry visibility. Defaults to private."),
    ),
  },
  ({ directory, visibility }) =>
    attempt(() => publishApp({ directory, visibility })).pipe(printJson),
).pipe(
  Command.withDescription(
    "Test, package, sign, register, upload, and submit an App using the signed-in account.",
  ),
);

const statusCommand = Command.make(
  "status",
  { appId: Flag.string("app-id").pipe(Flag.optional) },
  ({ appId }) =>
    attempt(() => appStatus(appId._tag === "Some" ? appId.value : undefined)).pipe(printJson),
).pipe(Command.withDescription("Show owned Apps and their publication status."));

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
  Command.withDescription("Manage account access to a private App."),
  Command.withSubcommands([accessInviteCommand, accessListCommand, accessRevokeCommand]),
);

export const appDeveloperCommand = Command.make("app").pipe(
  Command.withDescription(`Build and publish Penkra Apps. Complete guide: ${APP_GUIDE_URL}`),
  Command.withSubcommands([
    testCommand,
    sideloadCommand,
    packageCommand,
    publishCommand,
    statusCommand,
    accessCommand,
  ]),
);

async function publishApp(input: {
  directory: string;
  visibility: "public" | "private";
}): Promise<unknown> {
  const temporary = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-publish-"));
  try {
    const integration = await testAppDirectory({ directory: input.directory });
    const packagePath = Path.join(temporary, "app.penkra");
    const signaturePath = Path.join(temporary, "publisher.sigstore.json");
    const evidence = await packageAppDirectory({ directory: input.directory, output: packagePath });
    await runCosign(evidence.path, signaturePath);
    const identity = await ensureRegistryIdentity(evidence, input.visibility);
    const submission = await requestAppRuntimeBridge("developer.submissions.create", {
      appId: identity.appId,
      packagePath: evidence.path,
      signaturePath,
      issuer: process.env.SIGSTORE_OIDC_ISSUER?.trim() || DEFAULT_SIGSTORE_ISSUER,
      evidence,
    });
    return { app: identity, integration, package: evidence, submission };
  } finally {
    await FS.rm(temporary, { recursive: true, force: true });
  }
}

async function ensureRegistryIdentity(
  evidence: AppPackageEvidence,
  visibility: "public" | "private",
): Promise<{ appId: string; identifier: string; publisherId: string; slug: string }> {
  const publishers = records(await requestAppRuntimeBridge("developer.publishers.list"));
  const owned = await Promise.all(
    publishers.map(async (publisher) => {
      const publisherId = requiredText(publisher, "id", "publisher");
      return {
        publisherId,
        apps: records(await requestAppRuntimeBridge("developer.apps.list", { publisherId })),
      };
    }),
  );
  const existing = owned
    .flatMap((entry) => entry.apps.map((app) => ({ app, publisherId: entry.publisherId })))
    .find(({ app }) => text(app.identifier) === evidence.appId);
  if (existing) {
    const appId = requiredText(existing.app, "id", "App");
    await requestAppRuntimeBridge("developer.apps.visibility.set", { appId, visibility });
    return {
      appId,
      identifier: evidence.appId,
      publisherId: existing.publisherId,
      slug: evidence.slug,
    };
  }

  const defaults = publisherDefaults(evidence.appId);
  let publisher =
    publishers.find((candidate) => text(candidate.slug) === defaults.slug) ??
    (publishers.length === 1 ? publishers[0] : undefined);
  if (!publisher) {
    publisher = record(
      await requestAppRuntimeBridge("developer.publishers.create", {
        slug: defaults.slug,
        displayName: defaults.displayName,
      }),
      "created publisher",
    );
  }
  const publisherId = requiredText(publisher, "id", "publisher");
  const app = record(
    await requestAppRuntimeBridge("developer.apps.create", {
      publisherId,
      identifier: evidence.appId,
      slug: evidence.slug,
      displayName: evidence.name,
      summary: evidence.summary,
      visibility,
    }),
    "created App",
  );
  return {
    appId: requiredText(app, "id", "App"),
    identifier: evidence.appId,
    publisherId,
    slug: evidence.slug,
  };
}

async function appStatus(appId?: string): Promise<unknown> {
  if (appId) {
    return {
      appId,
      submissions: await requestAppRuntimeBridge("developer.submissions.list", { appId }),
    };
  }
  const publishers = records(await requestAppRuntimeBridge("developer.publishers.list"));
  const owned = [];
  for (const publisher of publishers) {
    const publisherId = requiredText(publisher, "id", "publisher");
    const apps = records(await requestAppRuntimeBridge("developer.apps.list", { publisherId }));
    owned.push({ publisher, apps });
  }
  return { publishers: owned };
}

function publisherDefaults(identifier: string): {
  slug: string;
  displayName: string;
} {
  const segments = identifier.split(".");
  const namespace = segments.slice(0, -1).join(".");
  const label = segments.at(-2)!;
  const suffix = createHash("sha256").update(namespace).digest("hex").slice(0, 8);
  const base =
    label
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 53)
      .replace(/-+$/g, "") || "app";
  return {
    slug: `${base}-${suffix}`,
    displayName: label.replace(
      /(^|-)([a-z0-9])/g,
      (_, prefix, value: string) => `${prefix ? " " : ""}${value.toUpperCase()}`,
    ),
  };
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("The App registry returned an invalid list.");
  return value.map((entry) => record(entry, "registry list item"));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredText(value: Record<string, unknown>, key: string, label: string): string {
  const result = text(value[key]);
  if (!result) throw new Error(`The ${label} response is missing ${key}.`);
  return result;
}

function bridge(method: string, params?: unknown) {
  return attempt(() => requestAppRuntimeBridge(method, params)).pipe(printJson);
}

function attempt<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: toError });
}

const printJson = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))));

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
          ? new Error("Publishing currently requires Cosign for keyless App signing.")
          : error,
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `App signing failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
