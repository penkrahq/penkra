import Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  androidEmulatorDiscoveryDirectories,
  buildAndroidEmulatorArguments,
  parseAndroidEmulatorEndpoint,
} from "./androidEmulatorLauncher";

describe("Android Emulator native launcher contract", () => {
  it("uses hidden official emulator flags with token-authenticated loopback gRPC", () => {
    expect(
      buildAndroidEmulatorArguments({
        avdName: "penkra-pixel-1",
        reportPort: 41000,
        grpcPort: 42000,
      }),
    ).toEqual([
      "-avd",
      "penkra-pixel-1",
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-grpc",
      "42000",
      "-grpc-use-token",
      "-report-console",
      "tcp:41000,max=60",
    ]);
  });

  it("adds factory reset only for an explicit erase operation", () => {
    expect(
      buildAndroidEmulatorArguments({
        avdName: "penkra-pixel-1",
        reportPort: 41000,
        grpcPort: 42000,
        wipeData: true,
      }),
    ).toContain("-wipe-data");
  });

  it("accepts only the expected authenticated endpoint from the PID discovery file", () => {
    const protoPath = "/sdk/emulator/lib/emulator_controller.proto";
    expect(
      parseAndroidEmulatorEndpoint("grpc.port=42000\ngrpc.token=secret\n", 42000, protoPath),
    ).toEqual({
      target: "127.0.0.1:42000",
      token: "secret",
      protoPath,
    });
    expect(
      parseAndroidEmulatorEndpoint("grpc.port=42001\ngrpc.token=secret\n", 42000, protoPath),
    ).toBeNull();
    expect(parseAndroidEmulatorEndpoint("grpc.port=42000\n", 42000, protoPath)).toBeNull();
  });

  it("uses bounded platform-specific discovery roots", () => {
    expect(androidEmulatorDiscoveryDirectories("darwin", { HOME: "/Users/test" })).toEqual([
      Path.join("/Users/test", "Library", "Caches", "TemporaryItems", "avd", "running"),
    ]);
    expect(
      androidEmulatorDiscoveryDirectories("linux", {
        XDG_RUNTIME_DIR: "/run/user/test",
        USER: "test",
      }),
    ).toContain(Path.join("/run/user/test", "avd", "running"));
    expect(androidEmulatorDiscoveryDirectories("win32", { TEMP: "C:\\Temp" })).toEqual([
      Path.join("C:\\Temp", "avd", "running"),
    ]);
  });
});
