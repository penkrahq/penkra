# UI, Themes, and App Bar

An App owns everything inside its App tab. Penkra owns the surrounding trusted panel tab, shell,
permissions, and installation UI. Use semantic HTML and normal browser controls; do not embed a
Pencil runtime or reproduce trusted chrome.

`@penkra/ui/tokens.css` maps the active Penkra appearance to semantic colors, typography,
interaction, focus, radius, and motion tokens. Apps should consume the semantics, not detect preset
names. The host controls System/Light/Dark mode and Codex Light/Dark defaults.

The standard App Bar supports ordered leading and trailing actions plus an absent, display, input,
or custom center. It is optional per page. If the center is not an input, no input listener is
attached. Apps can build the same contract with framework-neutral DOM primitives, React adapters,
or their own framework while preserving the token and accessibility behavior.
