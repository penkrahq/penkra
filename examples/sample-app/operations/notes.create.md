# Creating a Sample note

Use this operation only when the user wants text saved as a note in Sample's private Space-scoped
storage. Pass the intended note text through unchanged. Do not silently summarize, polish, or
reinterpret it.

`confirm` is required:

- Use `false` when the request unambiguously authorizes saving this exact text.
- Use `true` when the user asked to review or edit it first, or when unresolved wording means the
  person must decide before storage. The operation opens a bounded App interaction and waits.

A confirming call that returns `saved: false` means the person declined. That is a completed
decision, not a transient failure. Do not retry with `confirm: false`.

A schema error naming `text` or `confirm` means the input was invalid. Both fields are required,
the text must be nonempty, and additional properties are rejected. Correct the named input rather
than replaying the same call.
