import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({
  default: {
    app: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    webContents: { getFocusedWebContents: () => ({ send: native.send }) },
  },
  shell: {},
}));

// Exercise the installed dependency, not a mock of its cache behavior. The
// native encryption mock keeps this fixture entirely separate from OS secrets.
import { electronClient } from "@better-auth/electron/client";

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const entries = new Map<string, unknown>();
  const plugin = electronClient({
    protocol: "com.penkra.fixture",
    signInURL: "https://account.example.test/sign-in",
    storagePrefix: "penkra-account",
    storage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => void entries.set(key, value),
    },
  });
  const hooks = plugin.fetchPlugins[0]!.hooks!;
  const success = async (path: string, data: unknown, cookie?: string) => {
    await hooks.onSuccess!({
      request: { url: new URL(`https://account.example.test/api/auth${path}`) },
      response: new Response(null, {
        headers: cookie ? { "set-cookie": cookie } : {},
      }),
      data,
    } as unknown as Parameters<NonNullable<typeof hooks.onSuccess>>[0]);
  };
  const cached = () => {
    const value = entries.get("penkra-account.local_cache");
    return typeof value === "string"
      ? JSON.parse(Buffer.from(value, "base64").toString())
      : undefined;
  };
  return { entries, hooks, success, cached };
}

describe("pinned Better Auth Electron session persistence contract", () => {
  it("persists a sign-in cookie without creating a cached account reading", async () => {
    const f = fixture();
    await f.success(
      "/electron/token",
      { token: "fixture-only", user: { id: "account-a" } },
      "better-auth.session_token=fixture-only; Path=/; HttpOnly",
    );
    expect(f.entries.has("penkra-account.cookie")).toBe(true);
    expect(f.cached()).toBeUndefined();
  });

  it("writes the server session reading only when get-session succeeds", async () => {
    const f = fixture();
    const reading = { session: { id: "session-a" }, user: { id: "account-a" } };
    await f.success("/get-session", reading);
    expect(f.cached()).toEqual(reading);
    await f.success("/get-session", null);
    expect(f.cached()).toBeNull();
  });

  it("does not erase a cached account when the server returns an error", async () => {
    const f = fixture();
    const reading = { session: { id: "session-a" }, user: { id: "account-a" } };
    await f.success("/get-session", reading);
    await f.hooks.onError!({
      request: { url: new URL("https://account.example.test/api/auth/get-session") },
      error: { status: 503, message: "Fixture unavailable" },
    } as unknown as Parameters<NonNullable<typeof f.hooks.onError>>[0]);
    expect(f.cached()).toEqual(reading);
    expect(native.send).toHaveBeenCalledOnce();
  });
});
