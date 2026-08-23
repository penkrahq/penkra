# Penkra documentation

Penkra keeps two documentation audiences separate.

[`concepts.md`](concepts.md) is the normative glossary for the product model shared by both
audiences. Other guides link to those definitions instead of creating local variants.

## Public App-author documentation

[`app-development.md`](app-development.md) is the public contract for people and agents creating
Penkra Apps. It covers package structure, manifests, the SDK, runtime boundaries, registered author
commands, testing, packaging, publication, and compatibility. It must not contain Penkra repository
setup, numbered development launchers, localhost services, internal seeds, product QA, deployment,
or desktop-release procedures.

The standalone `@penkra/sdk` and `@penkra/ui` package READMEs are also public App-author surfaces.

## Penkra contributor and operator documentation

The repository `README.md`, `AGENTS.md`, this directory's remaining architecture documents, and
[`app-development-internals.md`](app-development-internals.md) are for people working on Penkra
itself. They may document internal development and production environments, testing, QA, migration,
deployment, release, recovery, and implementation details.

[`release.md`](release.md) is the desktop release runbook. The root `TODO.md` is the active product
and implementation plan; the root `ROADMAP.md` contains explicit deferrals.
[`npm-package-release.md`](npm-package-release.md) is the independent runbook for publishing the
public SDK and UI packages.

[`provider-connections.md`](provider-connections.md) records the managed provider, account
isolation, exact Thread binding, and switching invariants. Its operator QA matrix lives in
[`../qa/provider-connections/README.md`](../qa/provider-connections/README.md).

[`database-reliability.md`](database-reliability.md) defines local SQLite ownership, supported
offline maintenance, fail-closed recovery, and the required concurrency/restart QA matrix.

When information is useful to both audiences, keep the stable public contract in the public guide
and link to it from the contributor document. Do not copy internal environment mechanics into the
public guide or make contributor procedures appear to be App APIs.
