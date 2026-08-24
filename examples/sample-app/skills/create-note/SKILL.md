---
name: sample-create-note
description: Create a short note with the installed Sample App.
---

# Create a Sample note

Call Sample with structured input:

```json
{
  "command": ["sample", "notes", "create"],
  "input": { "text": "Review the launch checklist", "confirm": true }
}
```

Set `confirm` to true when the user should review or edit the note in the Sample App before the
operation completes. The command is available only when Sample and this skill are enabled in the
current Space.
