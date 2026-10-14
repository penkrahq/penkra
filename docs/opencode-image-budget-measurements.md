# OpenCode image-budget measurements

2026-10-13; installed OpenCode 1.19.0; repository application code unchanged. No N or budget policy selected. No paid inference or token-counting requests were made. The recovery/Stop bundle was already committed before this request and remains uninstalled pending review.

## Scope and measurement boundary

Safe Penkra `connections list` and per-account `models list --availability available` returned two active OpenCode Go API-key connections: A `09989ced-53e0-439b-ad53-0298c215f035` (default, 32 models), B `bf624040-3073-4e81-9693-e61e919ee850` (29 models). Credentials and key suffixes are omitted. There are **33 distinct configured model ids** across these catalogs. Other native provider catalogs can include anonymous/default models; they are not treated as additional configured Go connections.

Native-session census: 60 retained `provider-native-state/*/opencode.db` stores, plus the session APIs of running OpenCode programs. Two native stores were open: discovery store (0 sessions), and a store shared by legacy 1.18.35 programs (8 distinct sessions, all 0 images). The other 58 stores were not held according to lsof; their DB+WAL files were copied to isolated scratch, with size/mtime stability checked before/after. Copied bytes: **1,731,035,208**. No Penkra state.sqlite, credential file or historical Production backup was opened or copied.

Scratch OpenCode 1.19.0 servers used those copies, isolated HOME/XDG/PENKRA_HOME, no configured plugins/MCP/credentials, disabled provider availability/model fetching/updates, and only GET APIs. `/experimental/session?limit=10000&archived=true` enumerated all projects and archived sessions; ordinary `/session` is project-scoped and cannot prove an installation-wide count. GET session/message supplied history. Scratch startup may migrate its copies; originals were untouched. All task-owned scratch servers were terminated afterwards. Copies and metadata remain under `~/penkra-rehearsal/opencode-image-budget` and `/tmp/penkra-image-budget-*.json` for review.

**1077 distinct sessions enumerated; 1070 read successfully; 7 historical sessions returned HTTP 400 and are marked unknown rather than 0. 32 readable sessions contain images; 651 image occurrences, including 614 tool attachments.** Complete per-session measurements, including zero-image and unreadable sessions: [opencode-image-budget-sessions.csv](opencode-image-budget-sessions.csv).

An image occurrence is a top-level file part or tool state attachment with `mime` beginning `image/`. URL hashes supply the distinct-image count. “Turn” here is the chronological native user-message segment, including synthetic native user prompts; it is not a verified Penkra turn_id mapping. “Screenshot run” is a **tool-image proxy**: tool images before the next native user message; artwork read by a tool can also count. Consecutive run resets on a tool call with no image. Stored history includes compacted images: these numbers do not assert how many images a particular outgoing request retained after pruning, compaction or Penkra's plugin. No historical assembled requests were available.

## 1. Limits and configured models

The **actual Go route's** image count, per-image bytes/dimensions and total-body limits are unpublished/unverified for most models. Go can change upstream routes independently of the model slug. Its [official Go model list](https://opencode.ai/v2/docs/console/go/) establishes model availability, not those image limits. `U` below means unverified for the Go route, not unlimited. Vision comes from the observed native provider metadata; `no` is a capability declaration, not a measured hard image-count limit.

### Official direct-provider limits (not promises for Go)

| Ref | Exact models/family | Images/request | Image bytes/dimensions | Total body | Source and scope |
| --- | --- | --- | --- | --- | --- |
| D1 | GPT-5.6 Luna; GPT-6 Luna exact sizing unverified | Direct vision guide: 1,500 | GPT-5.6 Luna high: 2048px and 2,500 patches; original: 65,535px and 30,000-patch reject boundary. Separate per-image byte cap not established here. | 512 MB | [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision). Exact GPT-6 Luna details are not inferred from Astra. |
| D2 | Claude Haiku 5.5 (catalog 1M context) | Direct API: 600 for non-200k models; 100 for 200k models | 10 MB encoded/direct; 8000×8000 absolute; many-image requests need ≤2000px for portability. 4.7+ native-resolution budget 2576px / 4784 visual tokens. | 32 MB standard; partner limits can differ | [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision). Go gateway behavior U. |
| D3 | DeepSeek Flash vision route; legacy Vision Exp alias | Direct API: 600 | Inline 32 MiB; 8192px/side, reduced to 4096px at ≥15 images | 48 MiB | [DeepSeek vision](https://api-docs.deepseek.com/guides/vision/). **Observed Go errors instead cap routes at 20 or 64**, below. Text-only Pro/Flash Go metadata is not overridden by direct alias docs. |
| D4 | Grok 4.6/4.7 family | Direct guide says no count limit | 20 MiB/image; hard dimension bound not established | U | [xAI image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding). Context still bounds requests. |
| D5 | Kimi K3/K2.7 Code family | Direct guide says no fixed image count | Recommends ≤4096×2160; hard per-image size/dimension cap not established | 100M (docs' units) | [Kimi vision](https://platform.kimi.com/docs/guide/use-kimi-vision-model). Recommendation is not a hard rejection threshold. |
| D6 | MiMo V2.6 Flash/Pro and V2.5 | Context-bound; no fixed count stated | URL binary ≤50 MB; inline base64 string ≤50 MB; hard dimensions U | U | [Xiaomi MiMo image understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding). V2.5 Pro is not claimed covered by this vision list. |
| D7 | MiniMax M3 | Fixed count U | ≤10 MB/image; hard dimensions U | 64 MB | [MiniMax Anthropic compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api). MCode's own 20-image budget is **client policy**, not proof of an API count limit. |
| D8 | Muse Spark contributor family | Direct API: 50, enforced | Inline image ≤50,000,000 bytes; hard dimensions U | U | [Meta image understanding](https://dev.meta.ai/docs/image-understanding). Exact contributor-route overrides through Go U. |
| D9 | Qwen3.8 Max/Flash and Qwen3.7 Plus | Direct: 250 inline; 2,048 public-URL/local inputs | Original ≤20 MB; data URI ≤20 MB OpenAI-compatible / 32 MB Anthropic-compatible; recommend ≤7680×4320 (not asserted hard cap) | 64 MB workspace domain; 16 MiB DashScope domain | [Alibaba vision](https://help.aliyun.com/en/model-studio/vision). These are endpoint-specific. |
| D0 | Other/free/stealth/text-only entries | U | U | U | [Go catalog](https://opencode.ai/v2/docs/console/go/) does not publish image bounds; no replacement model/family is guessed. |

### Every configured model

All ids below are prefixed `opencode-go/`. A/B indicate the catalog that returned them. The Go columns apply to that service, separately from the direct-provider references above.

| Model id suffix | A/B | Advertised image input | Go images/request | Go image bytes/dimensions | Go total bytes | Direct-doc reference |
| --- | --- | --- | --- | --- | --- | --- |
| cat-jam-free | A | no | U | U / U | U | D0 |
| claude-haiku-5-5 | A | yes | U | U / U | U | D2 |
| deepseek-v4-flash | A / B | no | U | U / U | U | D0 |
| deepseek-v4-flash-vision-exp | A / B | yes | U | U / U | U | D3 |
| deepseek-v4-pro | A / B | no | U | U / U | U | D0 |
| deepseek-v4.1-flash | A / B | yes | 20 / 64 observed routes; current guaranteed cap U | U / U | U | D3 |
| glm-5.2 | A / B | no | U | U / U | U | D0 |
| glm-5.3 | A / B | no | U | U / U | U | D0 |
| glm-5.3-flash | A / B | yes | U | U / U | U | D0 |
| gpt-5.6-luna | A / B | yes | U | U / U | U | D1 |
| gpt-6-luna | A / B | yes | U | U / U | U | D1 |
| grok-4.6 | A / B | yes | U | U / U | U | D4 |
| grok-4.7 | A / B | yes | U | U / U | U | D4 |
| hy3 | A / B | no | U | U / U | U | D0 |
| hy4-preview | A / B | no | U | U / U | U | D0 |
| kimi-k2.7-code | A / B | yes | U | U / U | U | D5 |
| kimi-k3 | A / B | yes | U | U / U | U | D5 |
| longcat-2.0 | A / B | no | U | U / U | U | D0 |
| longcat-2.5-preview-free | A / B | yes | U | U / U | U | D0 |
| mimo-v2.5 | A / B | yes | U | U / U | U | D6 |
| mimo-v2.5-pro | A / B | no | U | U / U | U | D0 |
| mimo-v2.6-flash | A / B | yes | U | U / U | U | D6 |
| mimo-v2.6-pro | A / B | yes | U | U / U | U | D6 |
| minimax-m2.7 | A / B | no | U | U / U | U | D0 |
| minimax-m3 | A / B | yes | U | U / U | U | D7 |
| muse-spark-1.2-contributor | A / B | yes | U | U / U | U | D8 |
| muse-spark-1.3-contributor | A / B | yes | U | U / U | U | D8 |
| qwen3.7-plus | A / B | yes | U | U / U | U | D9 |
| qwen3.8-flash | A / B | yes | U | U / U | U | D9 |
| qwen3.8-max | A / B | yes | U | U / U | U | D9 |
| space-bunny | A | yes | U | U / U | U | D0 |
| space-bunny-free | B | U | U | U / U | U | D0 |
| step-5-preview-free | A | yes | U | U / U | U | D0 |

### Runtime metadata

OpenCode 1.19.0's [Models.dev model schema](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/models-dev.ts#L67-L121) exposes `limit.context`, optional `limit.input`, `limit.output`, `attachment` and input/output modalities. No image-count, per-image dimensions/bytes or request-body-byte limit is declared. Observed `/provider` limits use those token fields plus image capability booleans. There is **no runtime catalog N** established by these reads. Direct `models.dev/api.json` retrieval was HTTP 403; the installed metadata and pinned schema were inspected instead.

Client processing is separate: [1.19.0 image normalization](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/image/image.ts#L10-L12) defaults to 2000×2000 and 5,242,880 encoded bytes per image, resizing when enabled. [V2 attachment docs](https://opencode.ai/v2/docs/attachments) describe configurable matching limits and warn that unavailable resizing can pass the original through. These are not an aggregate request budget or a provider guarantee. An image-count limit alone does not bound base64 request bytes.

## 2. Real image-limit failures

HerWebCraft Academy Canvas Flyer (`5e032cd0-260a-484d-b162-1883bbb81155`): retained lifecycle evidence at [thread-lifecycle-evidence-2026-09-07.md](thread-lifecycle-evidence-2026-09-07.md#two-flyer-failures) records **“Streaming response failed: [400] At most 4 image(s) may be provided in one prompt.”**, turn-failure event 2603712 and runtime-error event 2603714 at 2026-09-06 23:45:22.807Z. The harness is OpenCode; the upstream provider/model and assembled request were **not retained/established** there. No matching named/native-session title or exact error was found in this census. “Luna High v1.18.29” in the prior worker report was explicitly corrected as conflating its research model with runtime version. It is not evidence of HerWebCraft's failed model. That model remains unverified; no attribution is fabricated.

| Native session | Date UTC | Native model | Exact stored error | Observed upstream route |
| --- | --- | --- | --- | --- |
| Chore `ses_f2297bda1ffe0QrBBnikfilOc5` | 2026-10-01 06:55:03.530 and 06:55:35.794 | opencode-go/deepseek-v4.1-flash | Upstream request failed: [invalid_request_error] a request may include at most 20 images | valarai-dsv4.1flash; deepseek-ai/DeepSeek-V4.1-Flash |
| `ses_f2869b434ffeXLhcyUWZsF1orS` | 2026-09-25 08:17:05.443 | opencode-go/deepseek-v4.1-flash | Upstream request failed: [invalid_request_error] a request may include at most 20 images | valarai; deepseek-ai/DeepSeek-V4.1-Flash |
| `ses_eeede3041ffejD0MIL7pIlOfzI` | 2026-10-06 12:50:15.178 | opencode-go/deepseek-v4.1-flash | Upstream request failed: [invalid_request_error] Too many images in request: 67 > 64 | frank/DeepSeek-V4.1-Flash |

These are four stored errors across three sessions. Route identity comes from safe response metadata; no auth headers or keys are reported. No inference was replayed. The census found unrelated image/tool-access errors too, but they are not count-limit evidence. Chore's separate current `Q.startsWith` failure remains the known malformed tool-attachment transform bug, not one of these numeric image limits; its isolated reproduction is in [opencode-chore-image-investigation.md](opencode-chore-image-investigation.md).

## 3. Real usage and references

Largest image-bearing sessions are below; full counts for every enumerated session are in the CSV. Run column uses the native-user-segment/tool-image definition above.

| Native session | Images / unique URLs | Tool images | Maximum images in a native user segment | Longest same-segment tool-image run | Longest consecutive image-bearing tool calls |
| --- | --- | --- | --- | --- | --- |
| ses_f23e462d3ffeDiU5ILYvTh4y7o | 237 / 234 | 235 | 16 | 16 | 5 |
| ses_eeede3041ffejD0MIL7pIlOfzI | 67 / 67 | 67 | 67 | 67 | 22 |
| ses_05d8d866cffeMtN6IBOnC7uOsP | 57 / 41 | 51 | 11 | 11 | 3 |
| ses_f28699d3effexRb3Ji3SdyB7NR | 45 / 44 | 45 | 45 | 45 | 6 |
| ses_f2297bda1ffe0QrBBnikfilOc5 (Chore) | 35 / 32 | 32 | 9 | 9 | 2 |
| ses_f2869b434ffeXLhcyUWZsF1orS | 34 / 34 | 34 | 34 | 34 | 9 |
| ses_f223b06c7ffeNFQvpierrjQNXD | 33 / 31 | 33 | 11 | 11 | 6 |
| ses_0e4c5f2c1ffeppEDWUviJ1Rhyb | 26 / 25 | 26 | 18 | 18 | 8 |
| ses_f28698738ffeuqhoeBZI3cUIEc | 24 / 24 | 24 | 24 | 24 | 8 |
| ses_f2869c9bbffesd68i30uE6S3Ij | 18 / 18 | 18 | 18 | 18 | 4 |
| ses_ef5c1caa8ffeUcHunyfIYoWNal | 14 / 13 | 14 | 13 | 13 | 1 |
| ses_05a17afafffepJ6c7OdcqvH1R8 | 12 / 10 | 9 | 2 | 2 | 2 |
| ses_fa9d1cfaaffeIJ4CoDGa0HGhp6 | 9 / 6 | 2 | 3 | 2 | 2 |
| ses_0e4ba4fcdffeFFgHQoJCzFxoI7 | 8 / 8 | 8 | 8 | 8 | 8 |
| ses_f150be4f9ffeGV5k6McPnsS8lp | 4 / 4 | 0 | 4 | 0 | 0 |
| ses_0572f63fdffeYZzvEAtuWZiH18 | 4 / 4 | 3 | 4 | 3 | 3 |
| ses_fa9d1d004ffe6vKRqxGxZ65u1V | 3 / 3 | 0 | 3 | 0 | 0 |
| ses_fcc156b8effePx3Att9GsCLPkd | 3 / 3 | 3 | 1 | 1 | 1 |
| ses_05499b8eaffe4D3TZKCSld7sF1 | 3 / 3 | 3 | 2 | 2 | 2 |
| ses_f6616380effeAl5SxhH10bKNLH | 2 / 2 | 2 | 2 | 2 | 1 |
| ses_1703851f6ffeyXj1hurFKn0kHz | 2 / 2 | 0 | 1 | 0 | 0 |
| ses_f86e96cd8fferr8EpaHD5t2zce | 1 / 1 | 0 | 1 | 0 | 0 |
| ses_eef113414ffebodAB26AiUiCLI | 1 / 1 | 1 | 1 | 1 | 1 |
| ses_fa9cb0fdaffeQmUN66n4m2lTLF | 1 / 1 | 0 | 1 | 0 | 0 |
| ses_fa9cb1221ffeTvk7FtyhkMULqZ | 1 / 1 | 0 | 1 | 0 | 0 |
| ses_f2873ad0cffe7IuJPhmbcYdYUV | 1 / 1 | 1 | 1 | 1 | 1 |
| ses_01fe9e396fferlKPzzxT5255j3 | 1 / 1 | 1 | 1 | 1 | 1 |
| ses_033b6863effeYw9PHcA2Bo7eYZ | 1 / 1 | 1 | 1 | 1 | 1 |
| ses_04d2642d8ffeEI4IDjj5bADuhM | 1 / 1 | 1 | 1 | 1 | 1 |
| ses_0572f649bffeTklflRmwnQX4ur | 1 / 1 | 0 | 1 | 0 | 0 |
| ses_06dd98879ffeIeLdOl6UOMv5fy | 1 / 1 | 0 | 1 | 0 | 0 |
| ses_2a9adab40ffesgg5utma11pJjO | 1 / 1 | 0 | 1 | 0 | 0 |

**References heuristic:** order image occurrences chronologically, call the newest k; inspect generated assistant text **and reasoning** until later image occurrences. Count explicit mentions of an older image's full read path (or its supplied filename), only when that label occurs once in the session. Repeated generic labels are excluded. Deduplicate to one `(current image k, backward distance)` pair; no claim is made about visual attention, implicit comparisons, synonyms or images reread under a new id. User text/tool arguments are not searched as the agent's own prose.

| Back-reference | Distinct matched k/distance pairs |
| --- | --- |
| k−1 | 1 |
| k−2 | 3 |
| k−3 | 0 |
| k−4 | 0 |
| k−5 | 0 |
| k−6 | 0 |
| k−7 | 0 |
| k−8 | 0 |
| k−9 | 0 |
| k−10 | 1 |
| k−28 | 1 |

Across 32 image-bearing sessions and 651 image positions, the conservative matcher found 6 pairs. There were 249 generated text/reasoning segments with ambiguous “previous/earlier/last … screenshot/image” cues among 6098 post-image segments. Those cues cannot reliably distinguish k from k−1 and are not assigned a distance. This heuristic **undercounts implicit references** and does not prove that older screenshots are unneeded. Chore has 1 unique-label k−1 match, 34 ambiguous cues and 893 post-image segments. No model budget is chosen from these counts.

## 4. Screenshot bytes and local token fixtures

No paid calls, provider token-counting endpoint or actual billing measurement. The local fixture evaluates two vendors' documented image-sizing/token rules against measured PNG dimensions: GPT-5.6 Luna at `detail=high` (32px patches, 1.2 multiplier, resize budget) and MiMo V2.6 (official round-to-32px pixel grid and merge). Fixture results are **estimates**, not measured Go billed tokens; request detail defaults/routing can change them. Sources: [OpenAI image cost rules](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs) and [MiMo official calculation](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding#explanation-of-image-token-usage-and-scaling-rules).

| Observed tool PNG dimensions | Samples | Median binary bytes | Median data: URL bytes | Minimal image_url JSON block bytes | GPT-5.6 Luna high fixture tokens | MiMo V2.6 fixture tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 920×2000 | 228 | 222810.0 | 297104.0 | 297147.0 | 2193 | 1798 |
| 400×250 | 30 | 10875.0 | 14524.0 | 14567.0 | 125 | 96 |
| 1200×1500 | 22 | 304933.5 | 406600.0 | 406643.0 | 2144 | 1786 |
| 800×2000 | 20 | 2318160.0 | 3090904.0 | 3090947.0 | 1890 | 1550 |

Tool-image binary range in the readable corpus: 537–3,810,845 bytes, median 172,674.5; image format/dimensions missing from non-PNG headers are not invented. The 920×2000 group dominates this corpus, but tool-returned artwork is not separated from screenshots, so it is not a universal screenshot distribution.

Exact byte rule for PNG: `data:` URL is `22 + 4×ceil(binaryBytes/3)` bytes; an OpenAI-compatible `image_url` block adds 43 bytes to that URL. Base64 inflation is approximately 4/3. Four median 920×2000 blocks alone occupy 1,188,588 bytes; four 800×2000 blocks occupy 12,363,788 bytes. Text, tool schemas, other history, request envelope and any different provider encoding add more. These are measured-component/local-fixture sizes, **not captured whole upstream requests**. Complete fixture output: `/tmp/penkra-image-budget-cost-fixture.json`.

## 5. Hook layer: installed 1.19.0 versus V2

In 1.19.0, [legacy Hooks](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/plugin/src/index.ts#L282-L289) defines experimental.chat.messages.transform with the full native `{info, parts}[]`. [Normal prompt assembly](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/prompt.ts#L1255-L1262) invokes it before MessageV2.toModelMessagesEffect. It also runs during compaction's selected-head serialization. chat.message sees one incoming message, chat.params/headers see settings and one user message, and session.compacting sees summary context/prompt; none is a second direct native-list hook.

The hook sees retained native conversation parts, not a complete serialized HTTP request: system/instruction/tool context is assembled afterwards, and model-specific conversion can extract tool images into synthetic user messages. Its empty input argument supplies no model limit; the native user message carries model identity, but Models.dev supplies no count budget.

Thus it is the **only direct legacy hook with that full native list**, not the only possible interception layer: [V2 AI SDK language hook in 1.19.0](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/plugin/src/v2/promise/aisdk.ts) can supply/wrap a LanguageModelV3 whose doStream/doGenerate later receives a converted prompt. That is a different layer and shape, not another native parts-array callback.

The official GitHub latest-release endpoint returned v1.19.0 (published October 11), not a verified installed/tested OpenCode-2 release. For the **V2 preview source**, pinned dev SHA `52ba7d630fd06beedfa51886541244c84d1e308a`, the old named experimental hook is not declared. [V2 Session hooks](https://github.com/anomalyco/opencode/blob/52ba7d630fd06beedfa51886541244c84d1e308a/packages/plugin/src/promise/session.ts#L21-L36) instead expose context with full AI messages, plus [model.request/http.request hooks](https://github.com/anomalyco/opencode/blob/52ba7d630fd06beedfa51886541244c84d1e308a/packages/plugin/src/promise/session.ts#L138-L148). [Hook domains](https://github.com/anomalyco/opencode/blob/52ba7d630fd06beedfa51886541244c84d1e308a/packages/core/src/plugin/hooks.ts#L15-L27) dispatch session/aisdk/tool domains. V2 does **not preserve the same plugin API contract** in that source. No compatibility claim for an untested V2 binary is made.

## 6. Compaction and pruning

- [1.19.0 prune](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/compaction.ts#L273-L315): requires compaction.prune enabled; scans backward, protects the newest user segment, ignores skill tools, estimates **text output**, protects 40,000 tokens and marks old completed tools compacted only when over 20,000 tokens would be reclaimed. [Message conversion](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/message-v2.ts#L303-L309) then clears those marked tools' attachments from outgoing context. It does not delete original stored images. A short-text screenshot can evade text-based pruning, and current-turn accumulation remains protected.
- [Automatic compaction trigger](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/prompt.ts#L1161-L1170) checks the previous finished response's token overflow, not an image count/byte budget.
- [Compaction summary serialization](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/compaction.ts#L52-L83) converts files/tool media to labels; the summary request sends text. [Recent-tail selection](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/compaction.ts#L225-L258) retains recent history within its token budget, so those retained tail images can still enter later normal requests. Old compacted head is excluded by filterCompactedEffect.
- Overflow-triggered recovery can remove media while compacting, but the earlier [HerWebCraft classifier audit](thread-lifecycle-evidence-2026-09-07.md#opencode-image-count-upstream-audit-correction) found that exact four-image wording was not classified as context overflow. That pinned 1.18.29 result is not asserted to be a new 1.19.0 execution test. Compaction cannot be assumed to cure every gateway image rejection.

## Evidence and limits

Safe catalogs: `/tmp/penkra-image-budget-connections.json`. Native measurements: `/tmp/penkra-image-budget-session-measurements.json`; live metadata `/tmp/penkra-image-budget-native-summary.json`; refined reference matcher output `/tmp/penkra-image-budget-reference-measurements.json`. Source snapshots/tree SHAs under `/tmp/penkra-image-budget-source`; local readers and fixture are task-owned scratch, not product code.

Unverified: HerWebCraft's upstream provider/model and request image count; numeric Go limits for other models/routes; 7 older native histories rejected by the API; actual Penkra-turn grouping across synthetic compaction user prompts; real per-image billed tokens/full outgoing request bytes; semantic image attention; V2 binary compatibility. No product code, plugin, credentials, Production DB, provider session or installed app was changed. N and the budget shape remain with the operator.

## Implemented budget verification (2026-10-13)

The standalone transform retains every image occurrence in the newest user message, then fills the four-image budget from newest occurrences across the request. It examines only top-level file parts and top-level tool attachment arrays. Older file parts become text notes; older tool images are removed and noted in string outputs, preserving non-image attachments and empty arrays. The same hook applies during compaction.

Startup writes the plugin before a thread program can start: `OpenCodeAdapter.startSession` awaits `loadOpenCodeConfigContent(serverConfig.homeDir)`, which awaits `ensureOpenCodeImageTransformPlugin`, before `connectToOpenCodeServer`. The ensure function compares the complete source and rewrites stale files. The approved swap restarts the app and its programs; no manual Chore repair is required for thread startup. Discovery/probe startup stays unchanged per reviewer ruling: the plugin must be current before a thread server starts; discovery/probes do not send chat history.

The local OpenCode 1.19.0 fixture passes with the plugin enabled and disabled: first tool-image turn HTTP 200 (two model-fixture calls), second turn HTTP 200 (one call), no errors and no paid requests. Evidence: `~/penkra-rehearsal/opencode-image-budget-fixed-repro/report.json`.

Chore's copied native history was read through GET only and transformed in memory: 1,008 messages, 35 image occurrences before, four after, four surviving tool attachments, zero undefined MIME values and zero malformed file parts. The exact converter MIME-filter operation that previously threw now passes. This validates converter input, rather than claiming a paid native replay of the entire Chore conversation. Evidence: `~/penkra-rehearsal/opencode-image-budget-fixed-repro/chore-replay.json`. Production data was untouched.

Focused plugin/config tests: 11 passed. Root typecheck: 11/11 successful, 7.803 s.

## Native observable-effect check (2026-10-14)

The plugin source exports only `PenkraOpenCodeImageTransform`; `IMAGE_BUDGET` is a private constant inside that standalone source. Every unit-test import asserts that single export.

A fresh OpenCode 1.19.0 session sends six PNG images to a local mock provider, then a new text-only user message makes those images historical. The request received by the mock on that second turn contains exactly **four image parts and two text notes**, `[image: fixture-0.png]` and `[image: fixture-1.png]`. The plugin-off control receives six image parts and zero notes. Both turns return HTTP 200 in both runs; inspecting the native logs finds **zero plugin-load errors**. This proves the transformation occurred, unlike the earlier HTTP-success-only check. No paid provider calls or Production writes occurred.

Evidence: `~/penkra-rehearsal/opencode-image-budget-observable/run.mjs`, `report.json`, and `{plugin-on,plugin-off}/native.log`.
