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

export type AppDeveloperBridge = (method: string, params?: unknown) => Promise<unknown>;

export async function publishAppDirectory(input: {
  directory: string;
  visibility: "public" | "private";
  bridge: AppDeveloperBridge;
  env?: NodeJS.ProcessEnv;
  dependencies?: {
    test?: typeof testAppDirectory;
    package?: typeof packageAppDirectory;
  };
}): Promise<unknown> {
  const test = input.dependencies?.test ?? testAppDirectory;
  const packageApp = input.dependencies?.package ?? packageAppDirectory;
  const temporary = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-publish-"));
  try {
    const integration = await test({ directory: input.directory });
    const packagePath = Path.join(temporary, "app.penkra");
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
      const submissionId = requiredText(existingSubmission, "submissionId", "submission");
      const submission = retryableValidationFailure(existingSubmission)
        ? await input.bridge("developer.submissions.retry-validation", { submissionId })
        : publicationInfrastructureFailure(existingSubmission)
          ? await input.bridge("developer.submissions.retry-publication", { submissionId })
          : existingSubmission;
      await input.bridge("developer.apps.visibility.set", {
        appId: identity.appId,
        visibility: input.visibility,
      });
      return {
        app: identity,
        integration,
        package: durablePackageEvidence(evidence),
        submission,
        resumed: true,
      };
    }
    const submission = await input.bridge("developer.submissions.create", {
      appId: identity.appId,
      packagePath: evidence.path,
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

function hasFailure(submission: Record<string, unknown>, status: string, code: string): boolean {
  if (submission.status !== status) return false;
  const failure = submission.failure;
  return (
    typeof failure === "object" &&
    failure !== null &&
    !Array.isArray(failure) &&
    (failure as Record<string, unknown>).code === code
  );
}

function retryableValidationFailure(submission: Record<string, unknown>): boolean {
  return (
    hasFailure(submission, "validation-failed", "VALIDATION_INFRASTRUCTURE_FAILED") ||
    hasFailure(submission, "validation-failed", "AUTOMATED_VALIDATION_FAILED")
  );
}

function publicationInfrastructureFailure(submission: Record<string, unknown>): boolean {
  return hasFailure(submission, "publication-failed", "RELEASE_PUBLICATION_FAILED");
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
    const submissions = records(
      await bridge("developer.submissions.list", {
        appId: registryAppId,
      }),
    );
    return {
      appId,
      registryAppId,
      submissions: await Promise.all(
        submissions.map((submission) => enrichSubmissionStatus(submission, bridge)),
      ),
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

const submissionStatusesWithDetail = new Set([
  "draft",
  "uploaded",
  "validating",
  "validation-failed",
  "ready",
  "publication-failed",
]);

async function enrichSubmissionStatus(
  submission: Record<string, unknown>,
  bridge: AppDeveloperBridge,
): Promise<Record<string, unknown>> {
  if (!submissionStatusesWithDetail.has(text(submission.status) ?? "")) return submission;
  const submissionId = requiredText(submission, "submissionId", "submission");
  try {
    const detail = record(
      await bridge("developer.submissions.get", { submissionId }),
      "submission detail",
    );
    return { ...submission, ...detail };
  } catch (error) {
    return {
      ...submission,
      detailError: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
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
