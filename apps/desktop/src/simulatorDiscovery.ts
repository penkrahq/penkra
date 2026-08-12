// FILE: simulatorDiscovery.ts
// Purpose: Converts official Apple and Android simulator inventories into the public SDK model.
// Layer: Trusted desktop simulator host

import type { AppSimulatorDeviceType, AppSimulatorRuntime } from "@penkra/sdk";

export interface SimulatorDiscoveryResult {
  runtimes: ReadonlyArray<AppSimulatorRuntime>;
  deviceTypes: ReadonlyArray<AppSimulatorDeviceType>;
}

interface SimctlRuntime {
  identifier?: unknown;
  name?: unknown;
  version?: unknown;
  isAvailable?: unknown;
  availabilityError?: unknown;
}

interface SimctlDeviceType {
  identifier?: unknown;
  name?: unknown;
  productFamily?: unknown;
  minRuntimeVersion?: unknown;
  maxRuntimeVersion?: unknown;
  minRuntimeVersionString?: unknown;
  maxRuntimeVersionString?: unknown;
}

export function parseSimctlDiscovery(json: string): SimulatorDiscoveryResult {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || !Array.isArray(value.runtimes) || !Array.isArray(value.devicetypes)) {
    throw new Error("simctl returned an invalid runtime inventory.");
  }

  const runtimes = value.runtimes.flatMap((candidate: SimctlRuntime) => {
    if (!isRecord(candidate)) return [];
    const identifier = stringValue(candidate.identifier);
    const name = stringValue(candidate.name);
    const version = stringValue(candidate.version);
    if (!identifier || !name || !version) return [];
    const available = candidate.isAvailable === true;
    return [
      {
        id: identifier,
        platform: "ios" as const,
        name,
        version,
        status: available ? ("available" as const) : ("incompatible" as const),
        installable: false,
        message: available
          ? null
          : stringValue(candidate.availabilityError) || "This Apple runtime is unavailable.",
      },
    ];
  });

  const nativeTypes = value.devicetypes.filter(isRecord) as SimctlDeviceType[];
  const deviceTypes = runtimes.flatMap((runtime) =>
    nativeTypes.flatMap((candidate) => {
      const id = stringValue(candidate.identifier);
      const name = stringValue(candidate.name);
      const family = stringValue(candidate.productFamily).toLowerCase();
      if (!id || !name || (family !== "iphone" && family !== "ipad")) return [];
      if (!supportsRuntime(candidate, runtime.version)) return [];
      return [
        {
          id,
          platform: "ios" as const,
          runtimeId: runtime.id,
          formFactor: family === "ipad" ? ("tablet" as const) : ("phone" as const),
          name,
        },
      ];
    }),
  );
  return { runtimes, deviceTypes };
}

export function parseAndroidSdkManagerDiscovery(
  output: string,
  deviceProfilesOutput: string,
  options: { preferredAbi?: string } = {},
): SimulatorDiscoveryResult {
  const sectionByLine = sdkManagerSections(output);
  const candidatesByVersion = new Map<
    string,
    Array<{
      runtime: AppSimulatorRuntime;
      installed: boolean;
      tag: string;
      abi: string;
    }>
  >();
  for (const { line, installed } of sectionByLine) {
    const packageId = line.split("|")[0]?.trim() ?? "";
    const match = /^system-images;android-([^;]+);([^;]+);([^;]+)$/.exec(packageId);
    if (!match) continue;
    const version = match[1]!;
    const tag = match[2]!;
    const abi = match[3]!;
    const runtime: AppSimulatorRuntime = {
      id: packageId,
      platform: "android",
      name: `Android ${version} (${humanizeAndroidToken(tag)}, ${abi})`,
      version,
      status: installed ? "available" : "missing",
      installable: true,
      message: installed ? null : "Install this system image to create a device.",
    };
    const candidates = candidatesByVersion.get(version) ?? [];
    candidates.push({ runtime, installed, tag, abi });
    candidatesByVersion.set(version, candidates);
  }

  const profiles = parseAvdManagerDeviceProfiles(deviceProfilesOutput);
  const preferredAbi = options.preferredAbi ?? hostAndroidAbi();
  const runtimes = [...candidatesByVersion.values()].flatMap((candidates) => {
    const compatible = candidates.filter(
      (candidate) => candidate.installed || candidate.abi === preferredAbi,
    );
    if (compatible.length === 0) return [];
    return [
      [...compatible].sort(
        (left, right) =>
          androidImageScore(right, preferredAbi) - androidImageScore(left, preferredAbi) ||
          left.runtime.id.localeCompare(right.runtime.id),
      )[0]!.runtime,
    ];
  });
  return {
    runtimes,
    deviceTypes: runtimes.flatMap((runtime) =>
      profiles.map((profile) => ({ ...profile, runtimeId: runtime.id })),
    ),
  };
}

function androidImageScore(
  candidate: { installed: boolean; tag: string; abi: string },
  preferredAbi: string,
): number {
  const tagScore =
    candidate.tag === "google_apis_playstore"
      ? 8
      : candidate.tag === "google_apis"
        ? 6
        : candidate.tag === "default"
          ? 4
          : 0;
  return (candidate.installed ? 100 : 0) + (candidate.abi === preferredAbi ? 20 : 0) + tagScore;
}

function hostAndroidAbi(): string {
  return process.arch === "arm64" ? "arm64-v8a" : "x86_64";
}

function parseAvdManagerDeviceProfiles(
  output: string,
): ReadonlyArray<Omit<AppSimulatorDeviceType, "runtimeId">> {
  const blocks = output.split(/^-{4,}\s*$/m);
  return blocks.flatMap((block) => {
    const id = /^id:\s*\d+\s+or\s+"([^"]+)"/m.exec(block)?.[1];
    const name = /^\s*Name:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (!id || !name) return [];
    const lower = `${id} ${name}`.toLowerCase();
    if (/(wear|tv|automotive|desktop)/.test(lower)) return [];
    return [
      {
        id,
        platform: "android" as const,
        formFactor: /(tablet|pixel_c|nexus_7|nexus_9|nexus_10)/.test(lower)
          ? ("tablet" as const)
          : ("phone" as const),
        name,
      },
    ];
  });
}

function sdkManagerSections(output: string): ReadonlyArray<{ line: string; installed: boolean }> {
  let installed = false;
  let relevant = false;
  const lines: Array<{ line: string; installed: boolean }> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Installed packages:/i.test(line)) {
      installed = true;
      relevant = true;
      continue;
    }
    if (/^Available Packages:/i.test(line)) {
      installed = false;
      relevant = true;
      continue;
    }
    if (/^Available Updates:/i.test(line)) {
      relevant = false;
      continue;
    }
    if (relevant && line.startsWith("system-images;")) lines.push({ line, installed });
  }
  return lines;
}

function supportsRuntime(deviceType: SimctlDeviceType, runtimeVersion: string): boolean {
  const runtime = numericVersion(runtimeVersion) ?? [];
  const minimum =
    numericVersion(stringValue(deviceType.minRuntimeVersionString)) ||
    appleRuntimeVersion(deviceType.minRuntimeVersion);
  const maximum =
    numericVersion(stringValue(deviceType.maxRuntimeVersionString)) ||
    appleRuntimeVersion(deviceType.maxRuntimeVersion);
  return (
    (minimum.length === 0 || compareVersions(runtime, minimum) >= 0) &&
    (maximum.length === 0 || compareVersions(runtime, maximum) <= 0)
  );
}

function numericVersion(value: string): ReadonlyArray<number> | null {
  if (!value.trim()) return null;
  return value.split(".").map(Number).filter(Number.isFinite);
}

function appleRuntimeVersion(value: unknown): ReadonlyArray<number> {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return [Math.floor(value / 10_000), Math.floor((value % 10_000) / 100), value % 100];
  }
  return numericVersion(stringValue(value)) ?? [];
}

function compareVersions(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function humanizeAndroidToken(value: string): string {
  return value
    .split("_")
    .map((part) => (part === "apis" ? "APIs" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
