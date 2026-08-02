// FILE: appIdentityService.ts
// Purpose: Derives stable pairwise Account and opaque Space identities for one App.
// Layer: Trusted desktop App runtime

import { createHmac, randomBytes } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

export interface AppRuntimeIdentity {
  subject: string | null;
  space: string;
}

export class AppIdentityService {
  readonly #secret: Buffer;
  readonly #getAccountId: () => Promise<string | null>;

  private constructor(secret: Buffer, getAccountId: () => Promise<string | null>) {
    this.#secret = secret;
    this.#getAccountId = getAccountId;
  }

  static async open(input: {
    userDataPath: string;
    getAccountId: () => Promise<string | null>;
  }): Promise<AppIdentityService> {
    const path = Path.join(input.userDataPath, "apps", "identity.key");
    await FS.mkdir(Path.dirname(path), { recursive: true });
    let secret: Buffer;
    try {
      secret = await FS.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      secret = randomBytes(32);
      await FS.writeFile(path, secret, { flag: "wx", mode: 0o600 });
    }
    if (secret.byteLength !== 32)
      throw new Error("The App identity key must contain exactly 32 bytes.");
    return new AppIdentityService(secret, input.getAccountId);
  }

  async resolve(appId: string, spaceId: string): Promise<AppRuntimeIdentity> {
    const accountId = await this.#getAccountId();
    return {
      subject: accountId ? `sub_${this.#derive("subject", appId, accountId)}` : null,
      space: `space_${this.#derive("space", appId, spaceId)}`,
    };
  }

  #derive(namespace: "space" | "subject", appId: string, value: string): string {
    return createHmac("sha256", this.#secret)
      .update(`${namespace}\0${appId}\0${value}`)
      .digest("base64url");
  }
}
