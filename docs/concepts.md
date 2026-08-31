# Penkra concepts

These terms describe the product model shared by Penkra, its Apps, and the agents that operate
them. Other documentation links here instead of defining the same term again.

## Space

A **Space** is a local workspace that keeps one area of work separate from another. It has a name,
an icon, and a position in the Penkra sidebar. A person might use one Space for a job and another
for personal work.

Folders live in a Space, and every Thread lives in one of those folders. A Space also determines
which Apps are enabled. The same App can be enabled in one Space and disabled in another, with
separate permissions and settings in each.

A Space is local to the Penkra installation. It is not an account, an organization, or a group of
members. When an App receives a Space identifier, that identifier is isolation context; it does
not make the App's remote data collaborative or grant another person access to it.

## Thread

A **Thread** is one conversation with an agent. It contains the user's messages, the agent's
responses, tool activity, approvals, and the runtime state needed to continue the conversation.
Every Thread belongs to one folder and therefore to one Space.

Starting another agent task creates another Thread; it does not create a browser tab or an App tab.
Penkra may keep a Thread running when it is not visible, so a Thread the user cannot see is not
necessarily idle.

A Thread is also the unit of authority. Because every Thread sits in exactly one folder and
therefore one Space, the Thread an agent runs in determines which Apps it can reach and which tabs
it can observe. An agent never supplies that Space itself; Penkra derives it. A provider's own
subagent or task mechanism is internal to how that agent works and does not create a Thread.

## Folder

A **folder** is a named group of Threads inside one Space. Folders organize conversations in the
sidebar and provide the working-directory context used when their Threads start work.

A folder is not a filesystem directory, even when it refers to one. Moving a folder changes which
Space contains its Threads; moving files on disk is a separate operation.

## App

An **App** is a program installed in Penkra with its own visual surface, private storage, and,
optionally, operations an agent can call. Apps come from the Penkra registry or are sideloaded
during development.

An App has a globally unique slug such as `canvas` or `browser`. The slug is the first word of each
of its registered commands. The App's window and operations belong to the same package but are
different surfaces: opening a window does not invoke an operation, and invoking an operation does
not necessarily open a window.

Apps are isolated by App and Space. One App cannot read another App's storage, use another App's
permissions, or inspect another App's tabs.

## Operation

An **operation** is a named, validated action published by Penkra or an App for an agent or another
App to invoke. Each operation declares an input schema, an output schema, and a summary explaining
when to use it.

App manifests use dotted local keys such as `documents.create`. A registered command expresses the
same key as separate words after the App slug, such as `canvas documents create`. Core operations
use the reserved `penkra` root. An operation is not a shell command: Penkra dispatches it directly
to a declared handler and validates its data at the boundary.

## Controller

An App's **controller** is its isolated, non-visual execution context for operations. Penkra starts
one controller for an active App installation in a Space and routes declared operation calls to it. The
controller is a permission-bounded Node process: ordinary Node filesystem, HTTP, crypto, Buffer,
stream, and packaged JavaScript facilities are available, while child processes, worker threads,
WASI, and native add-ons are disabled by the initial controller policy. Penkra-owned capabilities
remain available only through the controller subset of the public SDK.

A controller is not an App tab and has no trusted shell access. It can ask Penkra to open or target
an App-owned tab through the SDK, but it cannot inspect arbitrary windows, Threads, or other Apps.
Visual-tab services such as file pickers, opaque handles, App storage, transfers, composer staging,
hosted browser or simulator control, context menus, and tab-local routing are not controller APIs.

## Tab

An App **tab** is one retained instance of an App inside a Penkra Thread. Penkra gives it a stable,
host-owned tab identifier so operations and observation commands can target the exact surface.

An App tab is not a browser tab. An App such as Browser may host web pages inside its own App tab,
but those pages remain separate, isolated surfaces. Closing or reloading an App tab invalidates its
temporary resources and references even when Penkra later restores the App route.

## Installation

An **installation** is one accepted App package associated with a Space. It records the immutable
package version and source, whether the App is enabled, its reviewed permissions, and its settings
for that Space.

The App, its installation, and an open tab are different things. An App can have installations in
several Spaces with different state, and one installation can have several open tabs. Installing,
enabling, opening, updating, and uninstalling are separate actions.

## Skill

A **Skill** is a packaged operating procedure that teaches an agent how to perform a bounded kind
of work. A Skill contains a `SKILL.md` and may include supporting references, scripts, templates,
or assets. Loading a Skill supplies instructions; it does not install an App, grant a permission,
or prove that a tool mentioned by the Skill is available.

An App may contribute Skills from its verified package. Penkra exposes only Skills enabled for the
current Space and keeps their App attribution. Agents load the current Skill before following it
because the installed revision may have changed.

## Sideload

To **sideload** an App is to validate and install an unpacked development build directly from a
local directory instead of downloading a published registry version. Sideloading is intended for
interactive development and remains scoped to the caller's current Space.

A sideload is still an installation: it passes package validation and runs through the same
isolated App runtime. It is not publication, does not update a registry release, and is not evidence
that another account or machine can install the App. The existing sideload command automatically
claims or verifies the globally unique development identifier for the signed-in developer; this is
private provenance, not a listing or published version.
