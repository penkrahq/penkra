# Canonical question card: numbered Dev check

2026-10-17. Penkra Dev slot 1, localhost:5733, rebuilt desktop/main/preload and
current renderer. Production was not changed. A stale preload from the earlier
Dev process first reported a missing voice-power method after hot reload;
quitting and starting the standard Applications launcher supplied matching code.
No compatibility branch was added.

An ordinary request asked the default OpenCode model to help plan a personal
website and ask one multiple-choice question first. Thread
`81a18d2f-75f6-4897-a30e-0b5c2d2face4` showed a purpose question above the composer
with four options and a custom-answer field. The sidebar requested attention.
Selecting Portfolio removed the question card, changed the sidebar to working,
and displayed the answered question and selected answer in the transcript. The
same turn continued (the elapsed timer continued rather than restarting) and
finished with its website plan and a Worked-for 54s header; the sidebar no longer
showed attention. Computer Use accessibility observations and a painted final
window were inspected.

This is one real OpenCode question flow through the common clean-core schema,
not a claim of real Claude/Codex login coverage. The converter's answer metadata,
lifecycle generation, open/answered/cancelled mapping and canonical ordering also
have focused unit checks. Native desktop logs showed the server-owned working
set for this thread rather than a renderer-derived activity snapshot.

The Mac locked during subsequent attachment-viewer dock-drag QA. No visual
drag/pan/zoom pass or Production installation is claimed from that attempt.

The combined clean-core test gate also caught a P1 question-count regression
before packaging: the shared summary projection named `threads.id` directly,
but search selects from its `candidates` CTE. All five existing search tests
failed with `no such column: threads.id`. The expression now correlates against
the outer `id`, as the other summary subqueries already do. The five tests pass;
an additional test checks distinct per-thread open counts and answered-question
exclusion through that CTE. The search, connection-facts and thread-list files
pass 15 tests together. The rollback test now compares all pre/post item rows,
including the required turn marker, rather than assuming a single text row.
