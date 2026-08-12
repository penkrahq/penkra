import { describe, expect, it } from "vitest";

import { parseAndroidSdkManagerDiscovery, parseSimctlDiscovery } from "./simulatorDiscovery";

describe("simulator platform discovery", () => {
  it("maps supported iPhone and iPad profiles from official simctl JSON", () => {
    const result = parseSimctlDiscovery(
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            name: "iOS 26.0",
            version: "26.0",
            isAvailable: true,
          },
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            name: "iOS 17.0",
            version: "17.0",
            isAvailable: false,
            availabilityError: "runtime profile not found",
          },
        ],
        devicetypes: [
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            name: "iPhone 17",
            productFamily: "iPhone",
            minRuntimeVersion: 180000,
          },
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro",
            name: "iPad Pro",
            productFamily: "iPad",
          },
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch",
            name: "Apple Watch",
            productFamily: "Apple Watch",
          },
        ],
      }),
    );

    expect(result.runtimes).toEqual([
      expect.objectContaining({ id: expect.stringContaining("iOS-26-0"), status: "available" }),
      expect.objectContaining({ id: expect.stringContaining("iOS-17-0"), status: "incompatible" }),
    ]);
    expect(result.deviceTypes).toContainEqual(
      expect.objectContaining({ name: "iPhone 17", formFactor: "phone" }),
    );
    expect(result.deviceTypes).toContainEqual(
      expect.objectContaining({ name: "iPad Pro", formFactor: "tablet" }),
    );
    expect(result.deviceTypes.some(({ name }) => name.includes("Watch"))).toBe(false);
  });

  it("maps installed and installable Android images with phone/tablet profiles", () => {
    const result = parseAndroidSdkManagerDiscovery(
      `Installed packages:
Path                                            | Version | Description
system-images;android-36;google_apis;arm64-v8a | 1       | Google APIs ARM 64

Available Packages:
Path                                          | Version | Description
system-images;android-35;google_apis;x86_64   | 9       | Google APIs Intel x86_64
Available Updates:
`,
      `---------
id: 0 or "pixel_8"
    Name: Pixel 8
---------
id: 1 or "pixel_c"
    Name: Pixel C
---------
id: 2 or "wear_round"
    Name: Wear OS Round
`,
      { preferredAbi: "x86_64" },
    );

    expect(result.runtimes).toEqual([
      expect.objectContaining({ version: "36", status: "available" }),
      expect.objectContaining({ version: "35", status: "missing", installable: true }),
    ]);
    expect(result.deviceTypes.filter(({ name }) => name === "Pixel 8")).toHaveLength(2);
    expect(result.deviceTypes).toContainEqual(
      expect.objectContaining({ name: "Pixel C", formFactor: "tablet" }),
    );
    expect(result.deviceTypes.some(({ name }) => name.includes("Wear"))).toBe(false);
  });

  it("collapses SDK image variants to one best native package per Android version", () => {
    const result = parseAndroidSdkManagerDiscovery(
      `Installed packages:
Path | Version | Description
Available Packages:
Path | Version | Description
system-images;android-36;default;x86_64 | 1 | Default
system-images;android-36;google_apis;arm64-v8a | 1 | Google APIs
system-images;android-36;google_apis_playstore;x86_64 | 1 | Play Store
`,
      '----\nid: 0 or "pixel_8"\n    Name: Pixel 8\n',
      { preferredAbi: "arm64-v8a" },
    );

    expect(result.runtimes).toEqual([
      expect.objectContaining({
        id: "system-images;android-36;google_apis;arm64-v8a",
      }),
    ]);
    expect(result.deviceTypes).toHaveLength(1);
  });

  it("rejects malformed simctl inventory rather than inventing availability", () => {
    expect(() => parseSimctlDiscovery('{"devices":{}}')).toThrow("invalid runtime inventory");
  });
});
