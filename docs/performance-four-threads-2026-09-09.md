# Production observation: September 9, 2026

Production Penkra 0.12.4, main PID 63263, backend 63734. Measurements are
live-work observations, not controlled before/after experiments. CPU percentages
use cumulative process CPU-time deltas: 100% is one logical core. The machine
has 10 logical cores. Dev and unrelated applications are excluded from totals.

## CPU

| Owner                               | 20:48:41–20:49:11 Denver | 21:02:37–21:03:07 Denver |
| ----------------------------------- | -----------------------: | -----------------------: |
| Production host and direct children |                   57.61% |                   95.98% |
| Direct-backend Codex processes      |                    2.39% |                    2.49% |
| Renderer 64269                      |                   22.59% |                   26.63% |
| Backend 63734                       |                    9.97% |                   25.57% |
| GPU 63408                           |                    8.77% |                   19.02% |
| Renderer 63735                      |                    3.29% |                   16.39% |
| Main 63263                          |                    6.81% |                    1.99% |

The host rows include the individual component rows; do not add them twice.
The endpoint harness excludes processes that do not survive both endpoints.
The later observation overlapped a five-second native sample of renderer 64269;
profiling overhead and changing user/agent activity prevent a regression claim.
Six resident provider processes were present initially, five in the later matched
endpoint set. Resident processes are not the number of working Threads.
The registered working-Thread list initially returned four entries and a null
next cursor. That count was not reverified during the later window.

## Memory

At 20:58:18 Denver, macOS footprint reported 10.236 GiB total footprint across
77 validated production host processes, with no tool errors or warnings.
The tool's swapped field was 5.755 GiB. This is not 10.236 GiB of resident RAM,
and swapped occupancy does not establish an ongoing swapping rate.

Largest individual footprints:

| PID   | Verified identity                                               |  Footprint |
| ----- | --------------------------------------------------------------- | ---------: |
| 63408 | GPU                                                             | 2268.5 MiB |
| 66442 | Canvas 0.2.72 Node operation controller, from process arguments | 1548.4 MiB |
| 66595 | Renderer; surface unverified                                    |  925.0 MiB |
| 63263 | Main                                                            |  691.4 MiB |
| 64269 | Renderer; surface unverified                                    |  442.4 MiB |

Canvas controller 66442 had negligible CPU in the initial CPU observation.
Its footprint is a separate memory finding, not attribution of renderer CPU to
Canvas. Neither retained memory nor a lifetime peak proves a leak.

## Attribution evidence and limits

Source inspection found that SingleChatSurface aggregates retained App panes
across its dock state, and RightDock keeps inactive panes mounted with opacity
and pointer-event changes. Focused RightDock/AppDockPane tests passed: two files,
three tests. This confirms the tested lifecycle contract, not the identity or
necessity of every production renderer.

The production renderer-to-surface mapping remains unverified. Runtime App-tab
negative renderer tokens are not OS PIDs. Native window enumeration also does
not establish which windows are shell windows versus auxiliary windows.

The first three-second renderer sample mostly caught waiting. The subsequent
five-second sample caught some active main-thread work (402 of 451 main-thread
observations remained in mach-message waiting). Release Electron symbols contain
large nearest-export offsets and cannot identify React functions or an animation
cause. This sampling result is not a process CPU percentage.

Read-only local Canvas source inspection found explicit renderer destruction and
image/paragraph deletion in screenshot paths. It does not establish the installed
controller's heap composition, a leak, or parity between local and installed code.

## Evidence provenance

Raw evidence retained under `.penkra/scratch/performance-20260908/`:

- `four-threads-current.json`: initial 30.101-second endpoint observation.
- `four-threads-followup.json`: later 30.079-second endpoint observation.
- `four-threads-host-footprint.json`: macOS footprint report.
- `hot-renderer-64269.sample.txt`: first native sample.
- `hot-renderer-64269-followup.sample.txt`: second native sample.
- `endpoint-sample.rb`: cumulative CPU-time measurement harness.

No product code, animations, tabs, or running agents were changed for this
investigation. No live SQLite access, production restart, or heap dump was used.
