# 0.12.2 verification evidence

Observed September 6, 2026. This records completed checks, not release publication authority.

## Fresh desktop checks

Computer Use exercised standard `/Applications/Penkra Dev.app`, using its existing isolated
slot-1 profile. Production Penkra was not replaced or restarted.

Coordinator Thread `e3b5c75b-777c-4ec3-bf81-6b0126570c7e` in folder
`3cb231c3-8f38-4969-9f9f-293e734bb147` created six independent weather Threads. Their sidebar
rows appeared without refresh; working and completed states were observed. Show more exposed the
remaining row. All six completed. Archiving Sidebar Check 1 removed it immediately; restoring it
returned the row without another message. A fresh standard Dev quit/relaunch preserved the rows,
transcripts and agent-message source attribution.

| Title           | Thread ID                                |
| --------------- | ---------------------------------------- |
| Sidebar Check 1 | `agent-25331cbba1cad1f11fef6f2f23399f34` |
| Sidebar Check 2 | `agent-0c1c50a79e7fe62b1db9fb5fef906ad6` |
| Sidebar Check 3 | `agent-92ff5707f2d55b504981a06b1aef589e` |
| Sidebar Check 4 | `agent-d9cbe894c336f79bc5ac06b0a2c3dd1c` |
| Sidebar Check 5 | `agent-f2d1503d572afd6dd1d6abe8bc8075b7` |
| Sidebar Check 6 | `agent-3595bdc11a8283996cabaefcf1e6918b` |

## Connection routing

With the coordinator still bound to its existing Codex account, the composer changed the host
default to the other account. A create request omitting `connectionId` returned the new default;
an explicit request returned the named original account. Both completed. The child Connection
popup confirmed the omitted request used the new default. The original host default was restored
after this check and verified in host settings.

| Thread          | ID                                       | Observed selection                                     |
| --------------- | ---------------------------------------- | ------------------------------------------------------ |
| Weather Default | `agent-b54185c21a664a16377044a5f48e5968` | Host default, not caller binding                       |
| Weather Plus    | `agent-fb42a6ffdac645b1f8c3cb2bac214688` | Explicit Codex Connection                              |
| Weather Claude  | `agent-53a2024a232b33b00744a7e6fa76ce0f` | Saved Claude Connection; `claude-sonnet-5`             |
| Weather Free    | `agent-15f5d5130cb1c56b4bb86ddc32007c49` | Explicit JSON null; `opencode/ling-3.0-flash-fin-free` |

The Claude and OpenCode rows appeared live and reached Done. Opening the Claude transcript later
revealed `Credit balance is too low`: this validates the selected route and visible error, not a
successful Claude answer. A Done sidebar icon alone was insufficient response evidence.
The agent initially supplied the
literal CLI value `--connection-id null`; structured JSON null is required. The operation help now
states that distinction explicitly. No paid Connection was substituted for the Free request.

Computer Use had intermittent stale/blank-window observations following renderer reloads. A
canonical Dev quit/relaunch restored the UI. A healthy backend alone was not counted as desktop QA.

## Automated checks

`bun run release:verify` completed all stages in 402.6 seconds: repository contracts, formatting,
lint, typecheck, migration lineage, release smoke, unit/integration tests, desktop production build,
React compiler contract, and both browser partitions concurrently. ChatView passed 75 tests;
components passed 219 tests across 43 files. An earlier parallel browser import failure did not
recur in this complete run; no speculative runner fix was made.

The subsequent worker-added matrices were independently read and rerun by the coordinator:

- Server existing resolver plus matrix: 68/68 passing.
- Shared existing settings plus matrix: 35/35 passing.

After the execution-authority correction and gateway integration tests, a second complete
`bun run release:verify` passed in 469.2 seconds, including all 75 ChatView and 219 component tests.
The focused authority suite passed 19 tests; gateway integration passed 43 tests, including
authority rechecks across same-native steering and rejection after a genuinely different execution.

These checks are source/Dev evidence, not evidence that a packaged release was published.

The separate creation-retry characterization suite passed 5/5 on an independent coordinator run;
server typecheck also passed after its addition. It checks deterministic command/Thread/turn IDs,
preservation of an existing account over a changed default, pre-dispatch explicit-account conflict
rejection, stale-binding rejection, and no dispatch/account substitution on discovery failure.
Its synthetic dispatch fixtures do not establish durable receipt replay by themselves. A changed
binding or unavailable catalog can still reject a retry; this is not universal success replay.

## Observed native-steer authority failure

Production worker `agent-bcd2c5f70e6bc6e1d19d2bb1437f4133` received a native steer while working.
Durable delivery events `2585106` and `2585423` accepted its original and corrective logical
requests into the same native provider turn `01a075a7-600b-7933-8f4a-0578dfb47786`. Its running
session ended only at `07:47:48.505Z`, but earlier handoff writes reported `caller_turn_inactive`.

The authority resolver required exactly one matching logical row. Accepted steering intentionally
creates multiple logical rows for one native execution, so the resolver rejected this valid
execution as ambiguous. This finding is grounded in the durable journal and source, not inferred
from the final idle state. The original account/default test matrices did not cover this boundary.

After a fresh standard Dev launch (backend started `2026-09-06T08:09:30.631Z`), Computer Use sent
a weather-writing request, queued a follow-up, and clicked Steer. The server accepted
`thread.turn.steer-queued` command `d8167a2c-1120-466e-bf4b-0213631368c1` at `08:10:27.671Z`,
sequence `370086`. The agent subsequently archived Sidebar Check 2 successfully; its sidebar row
disappeared without refresh. A separate restore request returned the same row without sending it
another message. The exact Codex rollout then confirmed that the steer message at `08:11:05.289Z`,
archive call at `08:11:15.241Z`, and successful `{archived:true}` result at `08:11:15.524Z`
all belonged to native turn `01a075c4-798c-7c70-8884-285db42e19a1`, which started at
`08:10:05.591Z` and completed at `08:11:17.612Z`. This was same-execution steering, not a
later fresh-turn fallback. The separate restore completed at `08:11:50.739Z`.
