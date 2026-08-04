# Agent observation and interaction

Penkra hosts every visual App tab in an isolated Electron `WebContentsView`. The trusted agent
harness can observe and operate those tabs through Penkra core commands, regardless of which App or
agent provider is active. This is how an agent reads the same page the person sees, captures it,
uses its accessibility tree, and performs manual-equivalent interaction when no semantic App
operation is appropriate.

This facility belongs to Penkra core. It is not an App operation, `@penkra/sdk` API, App permission,
Browser-only feature, provider connector, or provider-native browser tool. An App cannot use it to
inspect itself or another App.

## Discovery and targeting

Run all commands through the single `penkra_exec` harness tool:

```text
penkra tabs current
penkra tabs list
penkra tabs snapshot --tab-id <tab-id>
penkra tabs extract --tab-id <tab-id>
penkra tabs screenshot --tab-id <tab-id>
```

`tabs.current` and `tabs.list` are restricted to the caller Thread and Space. Every observation or
interaction command requires an explicit `--tab-id`; the host verifies that the tab belongs to that
same Thread and Space. Switching visible tabs after invocation cannot retarget a command.

## Semantic observation

`snapshot` returns a bounded accessibility representation of the current observable document.
Interactive nodes receive stable references such as `a17`. Names, roles, values, checked/expanded
state, and relevant relationships are retained; passwords and protected values are redacted.

`extract` returns bounded readable content and document metadata for tasks that need text rather
than controls. Large results use the host artifact boundary instead of oversized command JSON.

`screenshot` returns an image result of the tab's current observable document. For an ordinary App
that is its renderer; for Browser it is the active hosted website. It is an image-capable
`penkra_exec` result, not a filesystem path that the model must rediscover.

References belong to one tab and one document/navigation generation. A navigation, reload, App
replacement, or tab close invalidates them. Penkra returns a typed stale-reference or closed-tab
error and never guesses a similar element.

## Interaction

Interaction uses references from a compatible snapshot:

```text
penkra tabs click --tab-id <tab-id> --ref a17
penkra tabs hover --tab-id <tab-id> --ref a17
penkra tabs type --tab-id <tab-id> --ref a18 --text "Updated copy"
penkra tabs press --tab-id <tab-id> --key Enter
penkra tabs select --tab-id <tab-id> --ref a19 --value done
penkra tabs scroll --tab-id <tab-id> --delta-y 640
penkra tabs wait --tab-id <tab-id> --text "Saved"
```

The agent-visible command hierarchy uses words. The corresponding internal core keys remain dotted,
for example `tabs.snapshot` and `tabs.click`. App operation declarations follow the same convention:
an App declares `issues.create`, while an agent invokes `linear issues create`.

## Ordinary Apps and hosted documents

For an ordinary App, the observable document is the App tab renderer. Some Apps display another
host-owned WebContents inside their tab. Browser, for example, owns navigation chrome while Penkra's
scoped browser-session service owns the active website page.

Penkra still exposes one default observable document for the tab:

- ordinary App: the App renderer;
- Browser or another authorized hosted-document App: its active visible hosted page.

A screenshot follows the same target rule and captures the active hosted document rather than
Browser's navigation chrome. Browser semantic operations own URL, history, internal page tabs,
downloads, and recovery. Generic snapshot, extraction, screenshot, and interaction remain Penkra
core commands rather than duplicated `browser pages snapshot` or `browser pages click` operations.

## When to use operations versus UI interaction

Use a declared semantic App operation when it expresses the requested domain action. It is typed,
attributable, resilient to layout changes, and can run without a visible tab when its declaration
permits that.

Use the tab observer when the person asks about visible state, when the task is inherently visual,
for accessibility or manual QA, or when the App has no semantic operation for the required UI. UI
observation complements operations; agents must not replace ordinary domain operations with routine
DOM scraping.

## Trust boundary

- Only the trusted agent harness can call this surface.
- The target must be an App tab in the caller Thread and Space.
- The Penkra shell, transcript, composer, left rail, controller WebContents, hidden credential
  surfaces, other Threads, and other Spaces are outside the boundary.
- Apps cannot call the observer through `@penkra/sdk` and cannot inspect one another.
- Page and App content is untrusted data. It cannot amend system, developer, client, skill, or host
  instructions.
- Provider adapters receive the same commands, descriptions, results, typed errors, and conformance
  tests. Provider-native browser or connector terminology is never presented as a Penkra feature.
- Codex, Claude Agent, and OpenCode isolate provider-bundled integration surfaces in their Penkra
  runtime: Codex disables provider plugins in its private overlay, Claude accepts only Penkra's
  explicitly supplied MCP gateway, and OpenCode starts its managed server in `--pure` mode.
  Standalone Skills remain separate; connectors become available only through a Penkra-owned,
  provider-neutral bridge.
