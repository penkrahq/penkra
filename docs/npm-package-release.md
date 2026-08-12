# Public npm package releases

Penkra publishes `@penkra/sdk` and `@penkra/ui` independently from the desktop product, backend,
and registry Apps. A version approval for one release surface does not authorize or select a
version for another.

Public npm releases use `.github/workflows/npm-publish.yml` on a GitHub-hosted runner. npm trusts
that exact workflow through OpenID Connect (OIDC), issues a short-lived credential for the publish,
and generates package provenance automatically. The repository must not store an npm publication
token.

## One-time configuration

1. Create a GitHub environment named `npm`. Restrict it to `main` and configure the required
   maintainers as deployment reviewers. Do not add an npm token secret.
2. Sign in with a current npm CLI as a maintainer of both public packages.
3. Register the exact workflow and environment as each package's trusted publisher:

   ```sh
   npm trust github @penkra/sdk --repo penkrahq/penkra --file npm-publish.yml --env npm --allow-publish --yes
   npm trust github @penkra/ui --repo penkrahq/penkra --file npm-publish.yml --env npm --allow-publish --yes
   ```

4. After one trusted publication succeeds for each package, set its npm **Publishing access** to
   **Require two-factor authentication and disallow tokens**, then revoke any obsolete automation
   token.

npm allows only one trusted-publisher configuration per package. Repository, workflow filename,
and environment matching are exact and case-sensitive.

## Publishing a version

1. Obtain explicit approval for the exact package and version.
2. Change only that package's version and the lockfile, commit the release source, merge it to
   `main`, and wait for the exact commit's `Penkra CI Quality Gate` to pass.
3. Manually run **Publish Public npm Package** on `main`, selecting the package and entering the
   exact committed version.
4. Approve the `npm` environment deployment after reviewing the package and version shown by
   GitHub.
5. Confirm npm shows the exact version, repository source, and provenance attestation.

The workflow refuses non-`main` source, a version that differs from the selected package manifest,
an unsupported or non-public package, a commit without the successful aggregate CI gate, and any
version already present in the npm registry. npm package versions are immutable; a correction gets
a new explicitly approved version.

## Runtime policy

The publication job pins Node 24.15.0, matching Penkra's declared minimum Node runtime, and pins
the npm CLI version needed for trusted publishing. Workspace dependency installation remains
locked to the committed Bun lockfile. Release jobs do not use a package manager cache.

References:

- <https://docs.npmjs.com/trusted-publishers/>
- <https://docs.npmjs.com/generating-provenance-statements/>
- <https://docs.npmjs.com/cli/v11/commands/npm-trust/>
