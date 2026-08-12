// FILE: providerConnectionDisplayIdentity.ts
// Purpose: Derives provider-authored, user-visible Connection identities without custom names.

export type ProviderConnectionDisplayIdentityStrategy =
  | { readonly kind: "account-email" }
  | { readonly kind: "secret-suffix"; readonly prefix: string };

export function accountEmailConnectionLabel(providerIdentityId: string | null): string {
  const email = providerIdentityId?.trim() ?? "";
  if (email.length === 0) {
    throw new Error("The provider did not return the account email for this Connection.");
  }
  return email;
}

export function secretSuffixConnectionLabel(input: {
  readonly prefix: string;
  readonly secret: string;
}): string {
  const characters = Array.from(input.secret);
  if (characters.length < 4) {
    throw new Error("The provider credential is too short to identify this Connection.");
  }
  return `${input.prefix} / ••••${characters.slice(-4).join("")}`;
}
