// FILE: appDeveloperLifecycle.ts
// Purpose: Owns App test, package, publication, status, and access workflows for registered commands.
// Layer: Developer lifecycle service

import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  packageAppDirectory,
  testAppDirectory,
  type AppPackageEvidence,
} from "./appDeveloperTools";
import { getPublisherIdentityToken } from "./appPublisherIdentity";
import { sign as sigstoreSign } from "sigstore";

const DEFAULT_SIGSTORE_ISSUER = "https://oauth2.sigstore.dev/auth";

export type AppDeveloperBridge = (method: string, params?: unknown) => Promise<unknown>;

export async function publishAppDirectory(input: {
  directory: string;
  visibility: "public" | "private";
  bridge: AppDeveloperBridge;
  env?: NodeJS.ProcessEnv;
  dependencies?: {
    test?: typeof testAppDirectory;
    package?: typeof packageAppDirectory;
    sign?: typeof signAppPackage;
  };
}): Promise<unknown> {
  const test = input.dependencies?.test ?? testAppDirectory;
  const packageApp = input.dependencies?.package ?? packageAppDirectory;
  const sign = input.dependencies?.sign ?? signAppPackage;
  const temporary = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-publish-"));
  try {
    const integration = await test({ directory: input.directory });
    const packagePath = Path.join(temporary, "app.penkra");
    const signaturePath = Path.join(temporary, "publisher.sigstore.json");
    const evidence = await packageApp({
      directory: input.directory,
      output: packagePath,
    });
    const identity = await ensureRegistryIdentity(evidence, input.bridge);
    const existingSubmission = await findVersionSubmission(
      identity.appId,
      evidence.version,
      input.bridge,
    );
    if (existingSubmission) {
      if (text(existingSubmission.packageDigest) !== evidence.packageDigest) {
        throw versionCollision(evidence.version);
      }
      await input.bridge("developer.apps.visibility.set", {
        appId: identity.appId,
        visibility: input.visibility,
      });
      return {
        app: identity,
        integration,
        package: durablePackageEvidence(evidence),
        submission: existingSubmission,
        resumed: true,
      };
    }
    const signing = await sign({
      packagePath: evidence.path,
      bundlePath: signaturePath,
      evidence,
      bridge: input.bridge,
      env: input.env ?? process.env,
    });
    const submission = await input.bridge("developer.submissions.create", {
      appId: identity.appId,
      packagePath: evidence.path,
      signaturePath,
      issuer: signing.issuer,
      evidence,
    });
    await input.bridge("developer.apps.visibility.set", {
      appId: identity.appId,
      visibility: input.visibility,
    });
    return {
      app: identity,
      integration,
      package: durablePackageEvidence(evidence),
      submission,
      resumed: false,
    };
  } finally {
    await FS.rm(temporary, { recursive: true, force: true });
  }
}

export async function appPublicationStatus(
  appId: string | undefined,
  bridge: AppDeveloperBridge,
): Promise<unknown> {
  if (appId) {
    const owned = await listOwnedRegistryApps(bridge);
    const match = owned.find(({ app }) => text(app.id) === appId || text(app.identifier) === appId);
    if (!match) {
      return { appId, registryAppId: null, submissions: [] };
    }
    const registryAppId = requiredText(match.app, "id", "App");
    return {
      appId,
      registryAppId,
      submissions: await bridge("developer.submissions.list", {
        appId: registryAppId,
      }),
    };
  }
  const publishers = records(await bridge("developer.publishers.list"));
  const owned = [];
  for (const publisher of publishers) {
    const publisherId = requiredText(publisher, "id", "publisher");
    const apps = records(await bridge("developer.apps.list", { publisherId }));
    owned.push({ publisher, apps });
  }
  return { publishers: owned };
}

async function listOwnedRegistryApps(bridge: AppDeveloperBridge): Promise<
  Array<{
    publisher: Record<string, unknown>;
    app: Record<string, unknown>;
  }>
> {
  const publishers = records(await bridge("developer.publishers.list"));
  const owned = [];
  for (const publisher of publishers) {
    const publisherId = requiredText(publisher, "id", "publisher");
    const apps = records(await bridge("developer.apps.list", { publisherId }));
    owned.push(...apps.map((app) => ({ publisher, app })));
  }
  return owned;
}

async function findVersionSubmission(
  appId: string,
  version: string,
  bridge: AppDeveloperBridge,
): Promise<Record<string, unknown> | undefined> {
  const submissions = records(await bridge("developer.submissions.list", { appId }));
  return submissions.find((submission) => text(submission.version) === version);
}

function versionCollision(version: string): Error {
  return Object.assign(
    new Error(
      `App version ${version} already has a registry submission with different bytes. Bump the App version before publishing.`,
    ),
    { code: "APP_VERSION_EXISTS" },
  );
}

function durablePackageEvidence(evidence: AppPackageEvidence): Omit<AppPackageEvidence, "path"> {
  const { path: _temporaryPath, ...durable } = evidence;
  return durable;
}

async function ensureRegistryIdentity(
  evidence: AppPackageEvidence,
  bridge: AppDeveloperBridge,
): Promise<{
  appId: string;
  identifier: string;
  publisherId: string;
  slug: string;
}> {
  const publishers = records(await bridge("developer.publishers.list"));
  const owned = await Promise.all(
    publishers.map(async (publisher) => {
      const publisherId = requiredText(publisher, "id", "publisher");
      return {
        publisherId,
        apps: records(await bridge("developer.apps.list", { publisherId })),
      };
    }),
  );
  const existing = owned
    .flatMap((entry) => entry.apps.map((app) => ({ app, publisherId: entry.publisherId })))
    .find(({ app }) => text(app.identifier) === evidence.appId);
  if (existing) {
    const appId = requiredText(existing.app, "id", "App");
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
      await bridge("developer.publishers.create", {
        slug: defaults.slug,
        displayName: defaults.displayName,
      }),
      "created publisher",
    );
  }
  const publisherId = requiredText(publisher, "id", "publisher");
  const app = record(
    await bridge("developer.apps.create", {
      publisherId,
      identifier: evidence.appId,
      slug: evidence.slug,
      displayName: evidence.name,
      summary: evidence.summary,
      visibility: "private",
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

async function signAppPackage(input: {
  packagePath: string;
  bundlePath: string;
  evidence: AppPackageEvidence;
  bridge: AppDeveloperBridge;
  env: NodeJS.ProcessEnv;
}): Promise<{ issuer: string }> {
  const issuer = input.env.SIGSTORE_OIDC_ISSUER?.trim() || DEFAULT_SIGSTORE_ISSUER;
  let token: Promise<string> | undefined;
  const bundle = await sigstoreSign(await FS.readFile(Path.resolve(input.packagePath)), {
    identityProvider: {
      getToken: () =>
        (token ??= getPublisherIdentityToken({
          issuer,
          bridge: input.bridge,
          appId: input.evidence.appId,
          version: input.evidence.version,
          packageDigest: input.evidence.packageDigest,
        })),
    },
    ...(input.env.SIGSTORE_FULCIO_URL?.trim()
      ? { fulcioURL: input.env.SIGSTORE_FULCIO_URL.trim() }
      : {}),
    ...(input.env.SIGSTORE_REKOR_URL?.trim()
      ? { rekorURL: input.env.SIGSTORE_REKOR_URL.trim() }
      : {}),
  });
  await FS.writeFile(Path.resolve(input.bundlePath), `${JSON.stringify(bundle)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { issuer };
}
