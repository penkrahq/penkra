# App Account identity

`account-identity` lets a reviewed Penkra App authenticate to a backend outside Penkra's own
Account-data namespace. It is a high-risk permission because the returned credential contains the
signed-in Account's verified email.

## App contract

Declare exactly one lowercase DNS audience on the permission and show a specific user-visible
reason. Call `identity.getToken` only for that exact audience:

```ts
import { identity } from "@penkra/sdk/tab";

const { token, expiresAt } = await identity.getToken({ audience: "api.example.com" });
```

The token is valid for five minutes. Apps should request it immediately before a backend call,
cache it only until `expiresAt`, send it as `Authorization: Bearer <token>`, and never log it. There
is no refresh token. A revoked permission or removed App access stops new issuance; an already
issued token remains valid until its short expiry.

## Backend contract

The JWT uses EdDSA and carries standard `iss`, `aud`, `sub`, `iat`, `exp`, and `jti` claims plus:

- `app_id`: the immutable manifest identifier of the calling App.
- `space_id`: opaque host context for the calling Space.
- `email`: the normalized verified Penkra Account email.
- `email_verified`: always `true` at issuance.

Fetch signing keys from `/.well-known/penkra-app-identity-jwks.json` on the configured Penkra
Account-service origin. Verifiers must allow only `EdDSA`, select by `kid`, require the configured
issuer and exact audience, reject expired or over-five-minute tokens, validate the App IDs allowed
for each endpoint, and require `email_verified === true`.

`sub` is stable for one Penkra Account and audience. It intentionally remains the same across
different Apps using that audience and changes for every other audience. Store `(iss, sub)` as the
federated identity key. A backend may use the verified email only on first login to link an existing
account; subsequent logins must resolve by `(iss, sub)`.

## Key rotation

The JWKS publishes the active key and configured previous public keys. Penkra signs only with the
active key. Operators should publish the new public key before switching the signing private key,
retain the previous public key for at least the five-minute token lifetime plus clock tolerance,
then remove it. Verifiers should honor JWKS cache headers and refetch after an unknown `kid`.
