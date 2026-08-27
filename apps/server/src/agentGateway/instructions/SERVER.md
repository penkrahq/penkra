# Working with Penkra

Penkra is the application the user is sitting in front of, and this server is how you reach anything
inside it: the Spaces, folders, and Threads their work is organized into, the Apps installed in this
Space, the tabs currently on their screen, and the Threads you can start, read, and wait on. Reach
for it whenever a request names something the user can see, points at the product itself, or asks
for a result that has to end up somewhere they can find again.

This is the operating manual returned by `penkra --help`: how to reason about Penkra-owned Threads,
tabs, opening, and App development, followed by the Penkra operation summaries generated from the
same declarations that parse and execute those commands. Use the exact operation's `--help` for its
validated schemas, operation-specific instructions, and examples.

## The words the product uses

The user's screen is organized by three containers, and everything you can address sits inside them.

A **Space** is a local workspace that keeps one area of work separate from another — a job in one,
personal projects in another. It has a name, an icon, and a place in the sidebar. Crucially, a Space
decides which Apps are installed: the same App can be present in one Space and absent in the next,
with different permissions and settings in each. A Space is local to this installation. It is not an
account, a team, or an organization, and it has no members, so nothing you do in a Space shares
anything with another person.

A **folder** is a named group of Threads inside one Space. It carries the working-directory context
its Threads start from. A folder is not a directory on disk, even when it points at one; moving a
folder changes which Space owns its Threads and moves no files.

A **Thread** is one conversation with an agent — messages, tool activity, approvals, and the runtime
state needed to keep going. This session is a Thread. Every Thread belongs to exactly one folder and
therefore to exactly one Space, which is how Penkra knows which Apps you may reach. You never supply
that Space yourself; it is derived from the Thread you are running in.

Against those containers sit the things you act on.

An **App** is a program installed into a Space with its own window, its own private storage, and
optionally a set of operations you can call. Every App has a globally unique slug — `canvas`,
`browser` — and that slug is the first word of every command the App registers. Apps are isolated
from each other by App and by Space: one App cannot read another's storage, borrow its permissions,
or look at its tabs.

An **operation** is a named, validated action published by Penkra or by an App. Each one declares an
input schema, an output schema, and a summary of when to use it. An operation is not a shell
command; Penkra routes it directly to a declared handler and validates the data at the boundary,
which is why a malformed call fails with a schema error naming the field rather than doing something
approximate.

A **tab** is one retained instance of an App inside a Thread, with a stable host-owned identifier so
you can target the exact surface the user opened. An App tab is not a browser tab. An App
like Browser may host web pages inside its own tab, but those pages stay separate, isolated
surfaces.

Opening a window and invoking an operation are different acts. So are installing an App, opening
it, invoking it, packaging it, and publishing it. Finishing one is never evidence that
another happened.

## Calling a Penkra command

`penkra_exec_command` is a dispatcher over a registry of declared operations — not a shell, not a
program on `PATH`, and not a namespace you can route other providers' tools through. It never
interprets pipes, redirects, substitutions, environment variables, or chained commands, because it
never reaches a shell in the first place.

A call has one field:

```json
{
  "command": "canvas documents create --title 'Q3 review'"
}
```

`command` uses ordinary command-line spelling: command words, `--name value` options, and quotes
around values containing spaces or JSON. Penkra parses that text directly into a registered
operation; it never passes it to a shell or executable, so pipes, redirects, substitutions,
environment expansion, and PATH lookup have no effect. Follow the operation's generated examples
and schema. Object or array values use JSON, normally through `--input '{...}'`; Penkra decodes the
outer JSON value once and ordinary schema validation owns everything after that.

Core commands begin with the reserved word `penkra`, as in `penkra threads list`. App commands
begin directly with the App slug. An App that declares the operation key `issues.create` is called
as `linear issues create` — the dotted key is how the manifest writes it, words are how you invoke
it. Never prefix an App command with `penkra`; that root belongs to the host alone.

Append `--help` whenever an operation is unfamiliar. Help is generated
from the manifest, so it is the authoritative and current input contract — it is worth more than
your recollection of a similar tool elsewhere.

For operating-system commands and native executables, use the provider's ordinary
command-execution tool instead. Providers name that tool differently, so do not assume it is called
`exec_command`. Native programs live entirely outside Penkra's registry, and an App slug never
shadows a program on `PATH`.

## Working out what a request is about

The user chooses which Apps to install, per Space. That means you cannot predict what is available
from your training, from the wording of the request, or from the tools you happen to hold. The live
catalog is the only evidence. Read it with `apps list` when the request names a
capability or an unfamiliar proper noun, when the user points at something on screen, or when the
work could plausibly be done either inside a visual App or with your own tools.

That last case is the one that quietly goes wrong. A result can be technically correct and still
useless because it was made in the wrong system — a file written to disk that the App cannot see, a
design that never reaches the user's account, a browser session the user cannot watch. Ask where the
user expects the result to live, not just how to produce one.

After `apps list` identifies an App, run `<slug> --help` for its operating instructions and
operation summaries. Read operation names before App names, since an App called something evocative may not do the thing
its name suggests, while an operation's declared summary describes an actual effect. Treat both as
leads rather than specifications, and confirm with help before any write, deletion, send, or
submission. If several Apps fit, prefer the one in the currently visible tab, then one already used
in this session. If candidates are still equally plausible, ask the user and name the practical
difference between them — that question is short and the wrong choice is expensive.

Nothing outside the live catalog is evidence that a Penkra App exists. Not a Skill that mentions it,
not a native application with the same name, not a directory in the repository, not a provider
plugin, not an MCP server, not a tool of your own that sounds similar. Those are separate capability
systems that happen to share vocabulary.

## Seeing what the user sees

`penkra tabs current` and `penkra tabs list` show the App tabs in this Thread and
Space. Snapshot, find, and interaction commands take an exact `--tab-id` and can address a retained
tab even when another tab is on screen. Screenshot is intentionally different: it takes no tab ID
and captures only the App tab currently visible for the caller Thread. Run `penkra tabs --help` for
the exact observation and interaction forms.

Take a fresh snapshot before you use an element reference. References are bound to the observed
state they came from, so a reference from an earlier snapshot may now point at a different element
or at nothing. Re-observing costs one call; acting on a stale reference can click the wrong thing.

Prefer an App's declared semantic operation whenever one expresses the domain action being asked
for. It is validated, it reports what it did, and it does not depend on the layout holding still.
Reach for tab interaction when the thing you need is genuinely visual: state that no operation
exposes, UI-only behavior, accessibility checks, or confirming with your own eyes that a change
landed.

Tab observation is host-owned and provider-neutral. It reaches only App-tab content in this Thread
and Space. It is not a capability Apps can use against each other.

Use `penkra open --path <path>` or `penkra open --url <url>` when the user asks Penkra to open something, so
it goes to the Space's configured handler. Supply the `with` flag only when the user explicitly
chose an eligible handler themselves. If you later write a clickable link to a local file, copy the
exact path the command returned rather than shortening or reconstructing it.

## Threads

Use `penkra context` when you need the current Thread ID, active turn ID, folder ID,
provider, or your thread-read, thread-create, thread-wait, and diagnostics permissions. This is the
authoritative per-session capability report; do not infer those values from the conversation or a
provider's own task system. Its `policyVersion` is machine-readable metadata for diagnosing which
Penkra instruction-set revision governed the session. It does not grant a permission.

Creating a Thread starts a real agent working in the user's product. Call
`penkra threads create` once per Thread you need; there is no batch form, and separate
calls are independent rather than atomic. Choose `target` values from
`penkra capabilities` rather than guessing a provider, model, or option key — provider option
keys are not interchangeable, so follow the `targetConstruction` returned for the provider you
picked. Give each call a distinct, stable `requestId`, a short outcome-oriented title, and
instructions that stand alone. The new Thread cannot see this conversation, so anything you leave
implicit is simply missing.

Because the calls are independent, a failure partway through a batch leaves the earlier Threads
alive and running. That is a real outcome, not a mess to clean up: keep the successful Thread IDs,
report them, and retry only the failed call with its original `requestId` and inputs. Restarting
from the beginning creates duplicate work in the user's sidebar.

When the user wants results, wait on every Thread ID you created with
`penkra threads wait`, then synthesize the outcomes together. A wait can time out with
work still in flight; that is not permission to create a replacement.

For example, to start two independent reviews: call `context` if you need your current folder or
permission state; call `capabilities` for the intended provider; then call `threads create` twice,
with request IDs such as `review-api-contract` and `review-ui-states`. Give each Thread the files,
constraints, and expected result it needs in its own prompt. Keep both returned Thread IDs and wait
on both. If the second creation reports that its Thread may already exist, retain the first result
and retry only the second call with the exact same request ID and inputs.

`penkra threads send` posts a follow-up such as "continue" into a _different_ existing
Thread. It records an agent-authored message carrying the user role and starts another turn, which
is why it must never target the Thread you are running in — doing so would put words in the user's
mouth and stack a second turn on the one already executing. The command rejects that target. In the
UI these messages are marked "Sent by agent," so the user can tell them apart.

Reading a Thread has a ladder. Use list, read, and activity for user-facing history; events and
runtime-events when you need the lower-level record; and diagnose when something is actually wrong.
Reach for Penkra's SQLite files or process logs only when a diagnostic response explicitly reports
that the coverage you need is unavailable.

Your provider's own subagent or task tools are an implementation detail of how you work. They do not
create Penkra Threads and cannot stand in for a request to create one.

When you start background work, decide deliberately whether to tell the user now or stay quiet until
there is a result worth reading. Both are reasonable; drifting into silence without choosing is not.

## When a command fails

Treat what a command returns as the only evidence of what happened. Do not report a Thread, an App
operation, an open, a publication, or any external effect as done unless its command returned
success. This is the single easiest way to mislead a user, and it is entirely avoidable.

Read the structured error rather than paraphrasing it. Penkra's errors name the invalid field, the
unavailable provider, the missing capability, or the Thread that may already exist — that detail is
usually the fix. When a listing is paginated, follow `nextCursor` until it is null before calling the
list complete or computing a total from it.

`penkra threads retry-projection` is only for the case diagnosis names: a quarantined
provider-runtime event. It releases the preserved head event for another projection attempt. It does
not skip the event and does not delete it.
