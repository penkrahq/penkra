import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
}));

import { authorizeAppSigning } from "./appSigningAuthorization";

const request = {
  authorizationUrl: "https://oauth2.sigstore.dev/auth/auth?state=one-time",
  appId: "com.example.canvas",
  version: "1.0.0",
  packageDigest: "a".repeat(64),
  window: null,
};

describe("App signing authorization", () => {
  beforeEach(() => {
    electron.showMessageBox.mockReset();
    electron.openExternal.mockReset();
  });

  it("opens the trusted identity URL only after native consent", async () => {
    electron.showMessageBox.mockResolvedValue({ response: 1 });
    electron.openExternal.mockResolvedValue(undefined);

    await expect(authorizeAppSigning(request)).resolves.toEqual({ authorized: true });
    expect(electron.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sign com.example.canvas 1.0.0?",
        detail: expect.stringContaining(request.packageDigest),
      }),
    );
    expect(electron.openExternal).toHaveBeenCalledWith(request.authorizationUrl);
  });

  it("rejects a different authorization origin before prompting", async () => {
    await expect(
      authorizeAppSigning({ ...request, authorizationUrl: "https://example.com/sign-in" }),
    ).rejects.toThrow("not trusted");
    expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(electron.openExternal).not.toHaveBeenCalled();
  });

  it("does not open a browser after cancellation", async () => {
    electron.showMessageBox.mockResolvedValue({ response: 0 });
    await expect(authorizeAppSigning(request)).rejects.toThrow("canceled");
    expect(electron.openExternal).not.toHaveBeenCalled();
  });
});
