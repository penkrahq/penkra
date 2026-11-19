# Local models — findings

Machine: M1 Max, 64 GB. Harness: `run.ts` (10 tasks: 5 basic, 5 full). Temperature 0.2, 3 runs each.

## Qwen3.5-4B (Q4), MLX (mlx-lm 0.32.2) vs llama.cpp (llama-server, -fa on)

| | MLX | llama.cpp |
|---|---|---|
| Basic | 15/15 | 15/15 |
| Full | 14/15 (11/15 before the max_tokens fix) | 14/15 |
| debug-from-error | 2/3 | 2/3 |
| Invalid tool calls | 0 | 0 |
| Decode tok/s (median per task) | ~75–160 | ~47–131 |
| First-token latency, short tasks | ~1–3.7 s | ~2.6–4.8 s |
| 60k-token lookup | 453 s | 530 s |
| Memory (phys_footprint) | 8.4–9.2 GB peak at 60k ctx, grows on demand | 12 GB with 131k ctx preallocated |

- **Decision: MLX.** Same task quality, faster decode and first token, memory grows only with use.
- The earlier MLX gap was the harness: mlx_lm.server caps replies at 512 tokens unless the request
  sets max_tokens, which truncated Qwen3.5's reasoning. The provider must always send max_tokens.
- Prompt processing is ~150–170 tok/s on M1 Max for both: a 60k-token first turn takes minutes.
  The provider must keep context small and reuse the server's prompt cache across turns.
- Qwen3.5-4B is a viable 8–16 GB tier model: all basic tasks, nearly all full tasks.

## Qwen3.8-27B (MLX 4-bit, 16.1 GB) — 2026-11-17, M1 Max 64 GB

| Runs | Basic | Full | Peak memory | Decode tok/s | 60k lookup |
|---|---|---|---|---|---|
| 3 | 15/15 | 15/15 | 26–27 GB | ~8–30 (median ~11) | ~2310–2450 s |

Perfect score, but slow: decode ~11 tok/s and a 60k-token first turn takes ~40 min on M1 Max.
Fits the 32 GB+ tier on memory; usable only with compact context and prompt-cache reuse.

## Devstral-Small-2-24B (MLX 4-bit, ~13 GB) — 2026-11-17 — DROPPED

- Clean rounds: basic 5/5, full 3/5 (r1, r2). Failed long-context-lookup both times (wrong answer after 23–41 min).
- The server crashed on debug-from-error in every round: macOS GPU watchdog
  (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`) at ~74k tokens of context.
  Smaller prefill chunks (`--prefill-step-size 256`) did not help: the cost is full attention over the long context, not the chunk size.
  Qwen3.5/3.8 (hybrid linear attention) never hit this.
- Peak memory: 27–28 GB. r3 is invalid (server dead).
- Verdict: weaker than Qwen3.8-27B and unstable at long context. Not listed.

Provider requirements from this run: restart the runtime when the generation thread dies; cap context so that dense-attention models never reach the watchdog limit.

## Qwen3.5-9B (MLX 4-bit, ~5 GB) — 2026-11-17

| Runs | Basic | Full | Peak memory | Decode tok/s (typical) | 60k lookup |
|---|---|---|---|---|---|
| 3 | 15/15 | 15/15 | 11 GB | ~45–90 | ~690–750 s |

Perfect score at 11 GB peak (60k context). Pick for 16 GB Macs; also a fast option on 32 GB+.
(Very high tok/s values are short tool-call turns; ignore.)

## Wider candidate sweep — 2026-11-17

Candidates came from Artificial Analysis and model cards (Nov 2026). Each was tested with one run of the suite on an M1 Max, plus a cold read of the ~10k-token OpenCode prompt.

| Model | Size | Basic | Full | Cold 10k prompt | Notes |
|---|---|---|---|---|---|
| MiniCPM5-2B (official MLX) | 1.4 GB | 5/5 | 4/5 | 22 s | ~2× Qwen3.5-4B decode speed. Repetition loops on two tasks (~5 min each, one failed). |
| Ornith-1.5-9B (official MLX 4-bit) | 5.1 GB | 5/5 | 5/5 | 63 s | Same score as Qwen3.5-9B, ~35% slower wall time, slower prompt reading. |
| Ling-3.0-tiny (rapid-mlx 4-bit) | 4.5 GB | — | — | — | Fails to load in mlx-lm 0.32.2 ("Quantized Bailing V3 kv_b_proj weights are not supported"). |
| K2 Horizon 3.7B/7B | — | — | — | — | No `k2_horizon` support in mlx-lm yet (PR ml-explore/mlx-lm#1948). |

| Ornith-1.5-35B-A3B (official MLX 4-bit) | 19.5 GB | 5/5 | 5/5 | 39 s (incl. load) | MoE, ~3B active. 23 GB peak. Whole suite 499 s vs 3,132 s for Qwen3.8-27B; median decode 67 tok/s vs 10. 80k-token long-context task in 404 s with no GPU watchdog kill. |
| Nanbeige4.3-33B (Nurymanau MLX 4-bit) | 18.7 GB | 5/5 | 3/5 | 325 s | Dense. 37 GB peak, ~9 tok/s decode. Wrong answer on long-context-lookup after 43 min, then the GPU watchdog killed the generation thread (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`). |

Verdict (2026-11-18): Ornith-1.5-35B-A3B replaces Qwen3.8-27B. It matches its score and beats it on every measure (speed, memory, long context); the only cost is a larger download.
Keep Qwen3.5-4B / Qwen3.5-9B / Ornith-1.5-9B. Nanbeige4.3-33B is not listed: slower, more memory, unstable at long context.
MiniCPM5-2B, re-run 3× with the repetition guard (2026-11-18): 8/10, 7/10, 6/10. The guard stopped one exact loop; two other tasks still ran ~6 min on non-exact degenerate output, and one run hit the GPU watchdog. Not listed: too unreliable even for 8 GB Macs, where Qwen3.5-4B stays the pick.
Ornith-1.5-35B-A3B long context (2026-11-18, cold, needle in the middle of real source): 89k tokens in 439 s and 112k tokens in 649 s, both recalled correctly, no GPU watchdog kill, 31 GB peak. Cap is 128k on Macs with 48 GB+, 64k on 32 GB Macs.
