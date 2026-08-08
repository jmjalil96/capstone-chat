# Phase 6 — OpenRouter and Cost Control Implementation Plan

Status: implemented; verification complete; pending user acceptance

Code authorization: granted by the user on 2026-08-08

## Planning record

- Planning began on 2026-08-08 after the Phase 5 code review closed its implementation findings and
  the user requested the Phase 6 plan. The user subsequently accepted the corrected plan boundary
  and authorized Phase 6 implementation on 2026-08-08.
- The proposed Phase 6 baseline is commit `fc67d41` (`Harden browser scroll race handling`), which is
  also `origin/main`. Its tracked repository state is clean; the only untracked file at planning
  start is this pre-existing Phase 6 document.
- The baseline passed strict TypeScript, all production builds, the repository-scoped Biome check
  over 180 tracked files, and 488 protocol, API/PostgreSQL, and web tests: 146 protocol, 165 API, and
  177 web. Three fresh isolated Playwright runs passed 25/25 each, and the corrected smart-scroll
  scenario passed 10/10 focused Firefox/WebKit repetitions.
- Literal local `pnpm check` still reports only the globally ignored
  `.claude/settings.local.json`. That unrelated user/tooling file is not repository or CI input and
  remains outside Phase 6 scope.
- The Phase 5 implementation record was refreshed with its final 488-test measurement and accepted
  as the frozen `fc67d41` baseline before Phase 6 application work began. Phase 6 does not absorb an
  unidentified Phase 5 correction.
- The development OpenRouter credential remains only in the ignored root `.env` as
  `OPENROUTER_API_KEY`. It was used during planning only for authenticated metadata reads. No model
  generation was requested and no inference spend was incurred. The credential value does not
  enter Git, documentation, test data, logs, browser code, or PostgreSQL and must be rotated before
  shared, staging, or production use.
- An authenticated `GET https://openrouter.ai/api/v1/endpoints/zdr` on 2026-08-08 confirmed the
  three approved exact model IDs. The current healthy ZDR endpoint counts were 14 for Fast, 11 for
  Balanced, and 10 for Pro. Eligibility, context, endpoint status, and pricing remain external state
  and are not frozen by this observation.
- Current official OpenRouter documentation was checked for streaming, usage accounting, ZDR,
  provider data collection, price ceilings, endpoint metadata, generation lookup, reasoning
  exclusion, and error behavior. The plan relies on the documented contracts linked in the
  OpenRouter contract checkpoint below and requires revalidation at implementation start.
- The current compatible direct dependency versions observed during planning are
  `eventsource-parser@3.1.0` and `decimal.js@10.6.0`. Implementation must recheck their package
  metadata and Node 24 compatibility before installation and must not upgrade unrelated packages.
- The implementation-readiness review corrected four seams before code work: immediately preceding
  closed response schemas remain compatible through a narrow preferred-tier resource instead of an
  additive conversation-summary field; real policy bootstrap requires an explicit operator privacy
  attestation covering OpenRouter's workspace-level data-discount, observability I/O logging, and
  broadcast settings; catalog pricing fails closed on unsupported charge dimensions and joins ZDR
  endpoints with model capability metadata; and reconciliation preserves the established
  conversation-before-generation lock order.

## Implementation record

- Implementation completed on 2026-08-08 in the working tree against the frozen `fc67d41` Phase 5
  baseline. No implementation commit has been created yet. The additive
  `0003_openrouter_cost_control.sql` migration installs the curated catalog, workspace model and
  cost policy, versioned privacy attestation, conversation preference, and complete generation
  reservation/accounting state. Upgrade tests preserve exact Phase 5 content and classify its fake
  history as untracked; accounting rows retain no accessible content link after conversation
  deletion. Explicit non-null checks make the billable snapshot invariant effective under
  PostgreSQL's three-valued `CHECK` semantics rather than relying only on service writes.
- The employee contract accepts exactly `fast`, `balanced`, and `pro`. A separate closed tier-policy
  resource exposes only default, enabled, and available state, while an owned preferred-tier
  resource persists the next-response choice without changing conversation revision or recency.
  The browser never receives raw model IDs, provider names, price, budget, or accounting fields.
- The initial backend-only mappings are exactly Fast `deepseek/deepseek-v4-flash-0731`, Balanced
  `deepseek/deepseek-v4-pro`, and Pro `moonshotai/kimi-k3`. Simulated bootstrap is keyless and
  network-free. Real bootstrap and refresh inspect only those approved IDs, require the current
  versioned privacy attestation, and reject absent credentials, conflicting policy, arbitrary model
  arguments, simulated metadata in real mode, and incomplete or ineligible routes. An explicitly
  unapproved catalog row is not reusable at bootstrap and is unavailable to both employee policy
  reads and generation admission. The OpenRouter adapter normalizes an omitted optional fixed-
  request price to explicit zero while retaining strict present-value and unknown-charge checks;
  an absent aggregate model output limit is conservatively derived only from fully eligible
  endpoints with known positive limits.
- Every response source resolves the selected tier and conservative catalog snapshot inside the
  existing short turn-creation transaction. The transaction locks workspace policy before
  employee/conversation state, enforces the workspace-local monthly ceiling and per-employee active
  limit, reserves exact decimal USD, creates the immutable turn, and consumes only a confirmed
  ordinary draft. It commits before any gateway wait. Concurrent budget and concurrency boundary
  tests admit exactly one request and leave the losing draft/tree unchanged.
- `OpenRouterGateway` uses native `fetch`, `eventsource-parser@3.1.0`, and exact arithmetic through
  `decimal.js@10.6.0`. Requests carry one exact model, `zdr: true`,
  `data_collection: "deny"`, `require_parameters: true`, maximum output, reasoning exclusion, and
  prompt/completion/fixed-request ceilings identical to the reservation basis. The adapter bounds
  headers, JSON, SSE events, aggregate queued events, timeouts, and error normalization; it cancels
  the response body after protocol completion or rejection and never logs or exposes raw provider
  payloads. A failed exact-model catalog batch aborts and joins its sibling requests before the
  caller regains control, including lifecycle cancellation.
- Final usage and billed USD settle content, lifecycle, accounting, and reservation atomically
  before the public completion event. Deterministic no-spend failures settle zero; ambiguous
  interruptions remain reserved for bounded usage lookup or conservative expiry settlement. Late
  metadata may fill only a still-reserved terminal row and cannot overwrite actual or estimated
  accounting. Gateway and coordinator record which layer spent the single bounded usage lookup, so
  an unavailable result is never retried by another layer. The first usage-bearing stream event is
  terminal: later data fails closed without being forwarded, while the authoritative usage remains
  available for settlement. Every contract-complete real terminal also has a validated actual
  provider: missing provider metadata spends that same one lookup without replacing stream-
  authoritative cost/tokens, and lookup failure retains actual accounting on a failed terminal.
  Cross-replica Stop is observed by a 250 ms durable-state poll so stalled upstream work is aborted
  without restarting inference.
- One lifecycle-owned maintenance loop runs reconciliation before best-effort catalog refresh. Its
  25-row `SKIP LOCKED` reconciliation batches advance beyond locked candidates, preserve
  conversation-before-generation lock order, and let concurrent replicas claim disjoint work.
  Catalog refresh uses a two-minute PostgreSQL lease and performs network reads outside the claim
  and apply transactions. Shutdown aborts and awaits maintenance before closing the database pool.
- The web presents only Fast, Balanced, and Pro with Balanced as the initial default, persists a
  conversation preference across reload/navigation, retains the committed tier for an active
  response, and uses the current selection for Send, Continue, Edit, and Try again. Unavailable,
  budget, and concurrency outcomes use centralized Spanish copy, preserve drafts, and expose
  accessible status. Existing browser fixtures now provide the same deterministic tier contract as
  the migrated API instead of bypassing policy failure behavior.
- Recorded operational tuning is: 10 s response-header, 30 s first-visible-token, 30 s inactivity,
  120 s total-generation, 10 s lookup, 30 s catalog-request, 5 min reservation expiry, 30 s
  reconciliation cadence, 25-row reconciliation batches, 6 h catalog cadence, 2 min refresh lease,
  30-day privacy-attestation lifetime, 250 ms durable-state polling, 32 request plus 16 per-message
  framing tokens, 64 KiB per SSE event, 256 KiB/128-event aggregate SSE queue, 16 KiB error bodies,
  and 8 MiB catalog JSON. The documented simulated policy example is USD 100/month,
  4,096/8,192/16,384 output tokens, active limit 2, and 2,000 margin basis points; these are explicit
  bootstrap inputs, not production defaults. A content-free `model-policy:attest` command renews
  only an existing real policy with an identical or newer fresh verification and performs no
  network request.
- Final automated verification passed 613 tests: 157 protocol, 270 API/PostgreSQL, and 186 web.
  Strict TypeScript and all production builds passed. The configured Playwright matrix passed 25/25
  in 28.3 seconds across Chromium plus the critical Firefox/WebKit stream matrix after the legacy
  fixtures were brought onto the tier-policy contract. Clean-database, exact Phase 5 upgrade,
  retry-safe migration, reservation races, month/DST boundaries, deletion retention, concurrent
  reconciliation, real HTTP backpressure, cancellation, shutdown, and content-free provider
  fixtures are included.
- The repository-scoped Biome check passed all 215 applicable tracked and untracked files, and
  `git diff --check` passed. Literal local `pnpm check` reports only the pre-existing globally
  ignored `.claude/settings.local.json`; it is not repository or CI input and was not modified.
  `pnpm audit --prod --audit-level high` passed its high/critical gate and retains the same moderate
  esbuild development-server advisory through Better Auth's existing Drizzle Kit toolchain.
- The production API image built successfully, runs as `node` UID 1000, and contains migration
  `0003`, the model-policy operator, and the OpenRouter adapter. Secret and browser-boundary scans
  found no credential and no raw provider/model identifier in production web or public protocol
  code. Production builds retain Vite's existing large-chunk advisory; Phase 6 did not introduce a
  second renderer or broad frontend dependency.
- Final verification exercised the completed operator path against current official public
  OpenRouter metadata with a placeholder bearer value and a disposable migrated PostgreSQL
  database: real-mode bootstrap made all three approved tiers available at the planned limits,
  forced refresh updated all three, and privacy renewal plus its identical retry succeeded. The
  temporary database/container was removed. This metadata-only check used no stored credential,
  sent no prompt, requested no generation, and incurred no inference spend. A dedicated-workspace
  credential path and paid inference smoke test were not attempted; real streamed inference and
  live billed-cost settlement therefore remain externally unverified rather than being claimed as
  passed.
- The final Phase 6 diff adds no compaction execution, administration route or UI, policy mutation
  HTTP API, usage report, telemetry SDK, deployment integration, queue, cache service, worker, or
  other Phase 7/8 behavior.

## Objective

Replace the Phase 4/5 simulated balanced-only generation path with the approved three-tier model
service while preserving the accepted chat, stream, branch, recovery, privacy, and ownership
behavior.

An authenticated employee can select Fast, Balanced, or Pro without seeing provider or model
names. Fastify resolves the workspace policy, validates that the exact mapped model has a healthy
ZDR route, conservatively reserves budget in the same transaction that creates the turn, streams
through OpenRouter, and durably settles authoritative usage and cost. Cancellation, interruption,
process loss, and concurrent requests cannot bypass the workspace ceiling or lose accounting.

Phase 6 establishes the model catalog, tier policy, provider adapter, accounting, reservation, and
reconciliation foundation required by the roadmap. It does not add compaction, employee or model
administration screens, budget/usage tables, model-policy mutation APIs, production telemetry, or
deployment integration.

The user accepted this plan, the exact Phase 5 baseline, and the corrected implementation boundary
before authorizing Phase 6 development on 2026-08-08.

## Plan approval decisions

Approval of this plan locks the following Phase 6 interpretations. They complete the roadmap
checkpoint without pulling Phase 7 or Phase 8 forward.

1. OpenRouter remains the only real v1 model gateway. `OpenRouterGateway` is implemented behind the
   existing small `ModelGateway` boundary; no direct OpenAI, Anthropic, DeepSeek, or Moonshot SDK is
   added.
2. The employee-facing tier set becomes exactly `fast`, `balanced`, and `pro` in transport and
   persistence. Interface copy remains `Fast`, `Balanced`, and `Pro`; raw model IDs and provider
   names remain backend-only.
3. The exact initial mappings are locked as follows and supersede the older PRD entries that left
   the model choices deferred:

   | Tier | Exact OpenRouter model ID |
   | --- | --- |
   | Fast | `deepseek/deepseek-v4-flash-0731` |
   | Balanced | `deepseek/deepseek-v4-pro` |
   | Pro | `moonshotai/kimi-k3` |

4. All three mappings are initially enabled and Balanced remains the workspace default. They are
   persisted in PostgreSQL rather than read from environment variables or hard-coded as runtime
   policy. Phase 7 later supplies authenticated administrator controls for changing them.
5. Phase 6 selects one exact model per tier and sends OpenRouter a single `model` value. It does not
   configure a cross-model fallback. OpenRouter may retry or fall back among eligible provider
   endpoints for that same exact model before content begins; it may never cross to another tier.
6. Every real request sends `provider.zdr: true` and `provider.data_collection: "deny"`. No code path
   may omit, disable, or override either flag. If no route satisfies both, the request fails instead
   of weakening privacy.
7. Every real request also sends a provider `max_price` ceiling, including an explicit fixed-request
   ceiling even when it is zero, and `require_parameters: true`.
   OpenRouter may use only an endpoint that supports the sent parameters and fits the same pricing
   ceiling used for the local reservation.
8. Live catalog validation joins the authenticated ZDR endpoint response with authenticated model
   metadata instead of inferring capabilities from the endpoint payload or using scraped pages. An
   eligible endpoint must match the exact model ID, be currently healthy, have model metadata that
   accepts text and produces text, support every sent parameter including `max_tokens` and
   `reasoning`, expose usable context/output limits, and provide valid non-negative prices. If the
   optional model-level aggregate output limit is absent, Capstone derives the conservative limit
   from the minimum positive limit among fully eligible endpoints; an explicit aggregate remains an
   additional bound, and an endpoint with no known positive limit remains ineligible.
9. For each model, the persisted conservative base price is the maximum prompt, completion, and
   fixed-request price across its currently healthy eligible endpoints. Cache reads never discount
   a reservation; the prompt basis uses the greater of prompt/cache-read pricing plus any cache-write
   surcharge. The completion basis adds any internal-reasoning rate because hidden reasoning shares
   the bounded output allowance. Conditional overrides are materialized and the maximum of every
   bounded alternative is used. A non-zero image, web-search, or unknown charge dimension remains
   ineligible. OpenRouter's optional wire-level `pricing.request` omission means that endpoint has
   no fixed-request charge and is normalized to explicit zero only at the adapter boundary; a
   present null, malformed value, explicit nonzero value, or unknown charge retains its ordinary
   strict validation. The workspace margin is applied to those maxima. The resulting combined
   prompt/completion/fixed-request ceilings are both the OpenRouter `max_price` values and the local
   reservation basis.
10. Catalog refresh failure caused by connectivity or OpenRouter availability preserves the last
    successfully validated metadata and does not make Fastify unready. A successful refresh that
    confirms no eligible route marks the mapped tier temporarily unavailable.
11. Catalog refresh is best-effort and limited to approved or currently mapped models. Phase 6
    never imports the full OpenRouter catalog into PostgreSQL and never exposes an arbitrary raw
    model picker to employees.
12. Initial workspace cost policy is supplied through an explicit idempotent operator bootstrap
    command. The operator must provide the monthly USD budget, each tier's maximum output tokens,
    the per-employee active-generation limit, and the reservation margin. Production has no numeric
    fallback, and the values are stored in PostgreSQL rather than environment variables.
13. Development/test may use documented simulated bootstrap inputs and zero-cost fake metadata.
    A simulated catalog row is marked as simulated, is never treated as OpenRouter spend, makes no
    external request, and is rejected whenever the application runs in production mode.
14. Real bootstrap additionally requires a versioned operator attestation that the dedicated
    OpenRouter workspace has data-discount logging, observability I/O logging, and observability
    broadcast disabled. Provider routing flags do not substitute for this account-level boundary.
    An attestation is fresh for 30 absolute days. Missing, future, or older attestation fails closed
    before real inference. A separate content-free operator re-attestation command accepts only an
    identical retry or a newer fresh verification for an existing real policy; bootstrap remains
    immutable. The runtime stores only the attestation version/time, never an OpenRouter management
    credential.
15. The model catalog and workspace policies are backend state. Phase 6 adds no administrator web
    route or UI. A narrow operator refresh command may revalidate the locked catalog so the phase is
    operable before Phase 7.
16. The employee model-policy read returns only the three tiers, the workspace default, enabled
    state, and effective availability. It never returns raw model IDs, provider names, prices,
    budgets, output limits, or validation diagnostics.
17. A conversation persists `preferredTier`, defaulting to Balanced for existing rows and to the
    current workspace default for newly created conversations. Generation requests use the tier
    explicitly selected by the employee and persist it as the conversation's next-generation
    preference.
18. Changing a conversation's preferred tier is an owned metadata mutation, not a message-tree
    mutation. It does not change the structural conversation revision, reorder history, alter prior
    answers, consume a draft, or stop an active generation. Last accepted write wins; the generation
    transaction still revalidates current availability and budget.
19. If the preferred tier becomes disabled or unavailable, the conversation retains that preference
    but cannot generate until the employee chooses an available tier. Fastify never silently
    substitutes another tier. A transient state in which all tiers are unavailable is represented
    honestly and disables generation.
20. Existing conversation summary/detail/search wire objects remain byte-shape compatible with the
    immediately preceding closed web schemas. Preferred tier is read and written through a separate
    owned, content-free conversation resource; it is not added to existing summary responses.
21. The existing response endpoint and eight-event NDJSON catalog remain the only browser stream
    contract. Phase 6 expands `modelTier` to the three approved values but does not add model,
    provider, price, cost, budget, or reservation data to public stream events.
22. `GenerationRequest` and internal gateway events gain only the model-neutral route, parameter,
    provider-metadata, and accounting information required by the backend. OpenRouter wire types,
    SSE frames, and catalog response types remain private to `apps/api`.
23. Every real OpenRouter chat request records purpose `chat`, requested tier, requested model,
    resolved model, actual provider, OpenRouter generation ID when available, effective non-secret
    parameters, prompt/completion/reasoning/cached token counts when available, billed USD cost,
    and lifecycle timing. Phase 7 may later create purpose `compaction` records through the same
    schema.
24. OpenRouter's final reported `usage.cost` is the source of truth for actual billed cost. Catalog
    prices and local token estimates are used only for preflight and reservation. Actual cost is
    never recomputed from catalog prices or clamped to the reservation.
25. Monetary arithmetic uses `decimal.js` and PostgreSQL `numeric`; JavaScript `number` is never
    used for addition, multiplication, comparison, or aggregation of money. Provider money is
    validated and canonicalized to decimal strings at the adapter boundary.
26. The input-token estimate is deliberately conservative and local: UTF-8 bytes for the exact
    system prompt and context text plus named per-message/request framing allowances. Phase 6 adds
    no tokenizer service, remote preflight call, or model-specific tokenizer package. Actual
    OpenRouter usage remains authoritative after the request.
27. The reservation is:

    ```text
    fixed request price ceiling
    + conservative input-token estimate × prompt price ceiling
    + permitted maximum output tokens × completion price ceiling
    = reserved USD
    ```

    Cache discounts are ignored during reservation. Reasoning tokens are bounded by the same output
    allowance and billed as output. Explicit prompt caching is not introduced in Phase 6.
28. The workspace budget period is calculated in PostgreSQL from the workspace IANA timezone. It
    begins at local midnight on the first calendar day and ends at local midnight on the first day
    of the next month. The UTC boundaries are copied onto each billable generation so enforcement
    and later reporting use the same immutable period.
29. The hard budget check, per-employee concurrency check, model-policy resolution, generation
    reservation, immutable turn creation, draft consumption, selected-leaf update, and conversation
    revision change occur in one short PostgreSQL transaction. No model or catalog network wait is
    held inside it.
30. Requests from one employee are serialized for the concurrency check through the employee's
    workspace-membership row. Workspace reservations are serialized through the workspace row.
    The lock order is fixed and covered so concurrent tabs and replicas cannot independently spend
    the same remaining budget or exceed the active-generation limit.
31. A failed reservation returns `WORKSPACE_BUDGET_EXCEEDED`; an active-generation limit returns
    `EMPLOYEE_GENERATION_LIMIT_REACHED`; a disabled or unresolved tier returns `TIER_UNAVAILABLE`.
    All occur before turn persistence and preserve the draft.
32. Accounting has an independent state from generation lifecycle. A generation may already be
    cancelled, incomplete, or failed while its reservation waits briefly for authoritative provider
    usage. Budget enforcement continues to count the full reservation until it is settled.
33. Ordinary completion settles actual usage and cost in the same terminal transaction that stores
    final assistant content. The public completion event is emitted only after both conversation
    state and accounting are durable.
34. Cancellation and interruption record actual usage when the provider supplies it. When the
    stream ends without final usage but an OpenRouter generation ID exists, the gateway performs one
    bounded metadata lookup outside any database transaction. It does not retry inference.
35. Deterministic pre-provider rejection that cannot have incurred inference cost settles at actual
    zero. An ambiguous request, failed usage lookup, process loss, or missing provider generation ID
    leaves the reservation pending until expiry rather than assuming zero.
36. Expired unresolved reservations are reconciled to the full conservative reserved amount with
    cost basis `estimated`. This deliberately favors hard-budget safety over undercounting. Later
    actual metadata is not applied automatically in v1 after estimated settlement.
37. Each API replica runs the approved narrow PostgreSQL-backed reconciler. Candidate discovery does
    not establish a conflicting row-lock order. Each claimed item then follows the existing global
    order—owned conversation first when present, generation second—using `FOR UPDATE SKIP LOCKED`,
    terminalizes abandoned active generations as incomplete, and settles reservations idempotently.
    Deleted-content rows with no conversation lock only their generation. It is not a queue, worker
    service, or background model job.
38. Catalog refresh uses a short database lease stored with catalog metadata, releases the
    transaction before the OpenRouter metadata request, and updates only rows it successfully
    claimed. A dead replica leaves the rows eligible after lease expiry.
39. `OpenRouterGateway` uses Node's native `fetch` and `eventsource-parser`; no OpenRouter/OpenAI SDK,
    SSE framework, retry library, or generic HTTP client is added. The parser handles comments,
    split UTF-8 and frames, `[DONE]`, bounded event data, mid-stream errors, and the final usage
    chunk.
40. OpenRouter usage is now included automatically in the last streaming event. Phase 6 does not
    send deprecated `usage.include` or `stream_options.include_usage` flags.
41. Requests send `reasoning: { "exclude": true }`. Models may reason internally according to their
    approved/default behavior, and reasoning-token counts and cost may be recorded, but raw or
    summarized reasoning is ignored, never forwarded, never stored, and never logged.
42. Upstream connection/header, time-to-first-visible-token, inter-event inactivity, total request,
    metadata-lookup, reservation-expiry, catalog-refresh, reconciliation, and batch-size values are
    named operational tuning values. They are recorded before implementation, centralized, and
    covered; they are not exposed as employee settings.
43. Capstone never blindly retries an ambiguous request. OpenRouter may try another provider for the
    same exact model before content starts. After any content, no automatic provider or Capstone
    restart is allowed.
44. The default non-production gateway remains `FakeModelGateway`. Real OpenRouter access requires
    `MODEL_GATEWAY=openrouter` plus `OPENROUTER_API_KEY`. Production requires OpenRouter and rejects
    fake mode, a missing key, and simulated catalog metadata.
45. CI and ordinary automated tests never receive a real key and never call OpenRouter. Content-free
    recorded JSON/SSE fixtures and injected fetch transports verify the adapter. A live metadata
    refresh and one minimal paid chat smoke test are separate manual gates; the paid test requires
    explicit user approval immediately before it runs.
46. Logs and errors may contain internal generation IDs, lifecycle state, timing, token counts,
    decimal cost, safe model-policy state, and sanitized OpenRouter error type. They never contain
    prompts, responses, compaction summaries, raw provider payloads, authorization headers, or the
    OpenRouter key.
47. Phase 6 adds only `eventsource-parser` and `decimal.js` as exact direct API dependencies if their
    compatibility recheck succeeds. The web adds no dependency.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its locked/deferred decision policy.
3. `docs/prd/01-product-scope-and-experience.md` in full, especially Product principles, Model
   selection, Composer behavior, privacy, retention, product language, and the Phase 7
   administration boundary.
4. `docs/prd/02-system-architecture-and-data.md` in full, especially Configuration, API contracts,
   browser/backend responsibilities, content privacy, database transactions, workspace boundary,
   revisions, reconciliation, verification, and observability.
5. `docs/prd/03-conversation-model-and-streaming.md` in full, especially OpenRouter, curated
   catalog, prompts, controls, authoritative context, lifecycle, terminal outcomes, concurrency,
   and compaction as a Phase 7 boundary.
6. `docs/prd/04-cost-control-and-reliability.md` in full, especially accounting, USD arithmetic,
   workspace-local budget periods, reservation, cancellation, fallback, timeouts, and reconciliation.
7. `docs/prd/05-brand-system.md` for the established tier-control presentation, status, focus,
   responsive, and accessibility rules.
8. `docs/prd/06-development-roadmap.md`, especially the exact Phase 6 checkpoint and Phase 7/8
   order.
9. `docs/implementation/01-foundation-plan.md` through
   `docs/implementation/05-conversation-controls-plan.md`, including every accepted implementation
   record and correction.
10. The complete current protocol generation, conversation, stream, response-state, and error
    schemas; migrations; workspace, conversation, and generation tables; bootstrap command; actor
    resolver; generation transaction; response coordinator; cancellation; deletion; lifecycle;
    `ModelGateway`; `FakeModelGateway`; `ChatRuntime`; tier presentation point; query keys; copy;
    tests; CI; and production container.
11. Current official OpenRouter documentation and authenticated ZDR metadata for the exact three
    mappings, plus current package metadata for any proposed dependency.
12. Current `git status`, the exact accepted Phase 5 commit, and its corrected final verification
    record.

At implementation start, explicitly record these still-deferred inputs before code depends on them:

- the operator-supplied initial monthly workspace budget in USD;
- Fast, Balanced, and Pro maximum output-token allowances;
- the per-employee active-generation limit;
- the reservation margin in basis points;
- connection/header, first-token, inactivity, total-generation, and metadata-lookup timeouts;
- reservation expiry and reconciliation cadence/batch size;
- catalog refresh cadence and refresh-lease duration;
- conservative request/message framing-token allowances; and
- maximum upstream SSE event bytes and bounded pre-stream error bytes.

The first four are explicit workspace policy and must be provided to the bootstrap command. The
remaining values are operational tuning values selected conservatively, centralized in backend
settings, and revisited in Phase 8 load testing. Stop for approval if evidence requires a change to
the locked privacy, model mapping, budget semantics, retention, or employee experience.

The implementation starts with the following recorded non-production example inputs and operational
values. They are not production policy defaults:

| Input | Initial value |
| --- | ---: |
| Simulated monthly budget | USD 100 |
| Simulated Fast / Balanced / Pro output allowances | 4,096 / 8,192 / 16,384 tokens |
| Simulated per-employee active limit | 2 |
| Simulated reservation margin | 2,000 basis points |
| Response-header / first-token / inactivity / total timeouts | 10 s / 30 s / 30 s / 120 s |
| Metadata lookup timeout | 10 s |
| Reservation expiry | 5 min |
| Reconciliation cadence / batch | 30 s / 25 rows |
| Catalog refresh cadence / lease | 6 h / 2 min |
| Privacy-attestation lifetime | 30 days |
| Token-estimate framing | 32 request + 16 per message, plus exact UTF-8 bytes |
| Maximum SSE event / pre-stream error body | 64 KiB / 16 KiB |

Production bootstrap requires all four workspace inputs explicitly and may choose different values
without changing these operational safety bounds. The five-minute reservation expiry remains above
the complete 120-second request plus bounded lookup and shutdown grace.

Phase 6 does not need a compaction threshold, recent-turn count, compaction prompt, administrator
screen, employee-management route, policy-edit route, usage table UI, production venue, backup
retention, OTLP destination, or load-tested capacity target.

## OpenRouter contract checkpoint

Implementation must recheck these official contracts rather than copy examples blindly:

- [Streaming](https://openrouter.ai/docs/api/reference/streaming): streaming is SSE, comments may be
  used as keepalives, and the generation ID is exposed for correlation.
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting): usage and
  billed cost are included automatically in the final stream event; the older include flags are
  deprecated.
- [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr): `provider.zdr: true`
  restricts the request to ZDR endpoints.
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection):
  `data_collection: "deny"`, `require_parameters`, provider fallback, and per-million `max_price`
  ceilings.
- [Workspace settings](https://openrouter.ai/settings/privacy): provider routing does not disable
  OpenRouter's own data-discount or observability logging. A real bootstrap therefore requires the
  operator attestation described above; runtime inference never receives a management credential.
- [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr): authenticated live endpoint
  metadata used for approved-model validation, joined with authenticated model metadata for input,
  output, context, and supported-parameter capabilities.
- [Usage lookup](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation):
  metadata and total cost lookup by OpenRouter generation ID.
- [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens):
  `reasoning.exclude: true` suppresses reasoning content while usage may still report reasoning
  tokens.
- [Errors](https://openrouter.ai/docs/api/reference/errors-and-debugging): pre-stream HTTP failures,
  typed error categories, and mid-stream error chunks.

OpenRouter examples often show optional attribution headers and SDKs. Phase 6 sends only the
required authorization, content negotiation, and request fields; it does not add optional user,
session, trace, debug, prompt-logging, or content-echo metadata.

## Dependency direction

```text
apps/web ──JSON + NDJSON/fetch──> apps/api ──Drizzle/node-postgres──> PostgreSQL
   │                                  │
   ├─────────────────────────────────> packages/protocol
   └─────────────────────────────────> packages/brand

apps/api generation transaction
   ├──> ModelPolicyService ──> PostgreSQL catalog/policy
   ├──> BudgetService ───────> PostgreSQL numeric reservation
   `──> ModelGateway
          ├── FakeModelGateway (default development/test)
          `── OpenRouterGateway ──HTTPS/SSE──> OpenRouter

apps/api maintenance loop
   ├──> expired generation/reservation reconciliation in PostgreSQL
   `──> claimed catalog refresh ──HTTPS──> OpenRouter ZDR metadata
```

- React owns only the tier picker, unavailable-state presentation, and centralized Spanish errors.
- TanStack Query owns employee-visible tier policy and canonical conversation preference.
- `ChatRuntime` still owns active browser streams; it does not calculate price, enforce budget, or
  know model/provider names.
- Fastify owns tier resolution, context bounds, OpenRouter requests, provider normalization,
  timeouts, usage, accounting, reservations, settlement, and reconciliation.
- PostgreSQL is authoritative for catalog metadata, workspace policy, conversation preference,
  budget periods, reserved/actual/estimated cost, and durable generation lifecycle.
- `packages/protocol` contains only public tier, policy-read, preferred-tier mutation, generation,
  error, and existing stream schemas. OpenRouter schemas, decimal utilities, rows, and reconciliation
  state stay in `apps/api`.
- The backend keeps `route -> service -> explicit queries`. Catalog, budget, gateway, and reconciler
  modules are narrow feature boundaries, not repositories, command buses, provider frameworks,
  queues, or generic billing systems.

## Phase 6 checkpoint

The employee sees only this policy:

```text
Fast       available/unavailable
Balanced   available/unavailable (initial default)
Pro        available/unavailable
```

Fastify resolves it to private backend state:

```text
tier
  -> enabled workspace policy
  -> exact approved catalog model
  -> last validated healthy ZDR endpoints
  -> conservative context/output/price ceiling
  -> workspace budget and employee concurrency policy
```

Turn creation remains one authoritative transaction:

```text
lock workspace -> lock membership -> lock conversation/policy
  -> validate selected branch, tier, context, and draft
  -> sum current-period actual/estimated cost + live reservations
  -> reserve maximum cost
  -> create messages + generation
  -> persist preferred tier + selected assistant + revision
commit
  -> call OpenRouter
```

Settlement is independent from the long network wait:

```text
reserved
  |-- final authoritative usage ----------------------> actual
  |-- deterministic no-spend rejection --------------> actual $0
  `-- unresolved after expiry/reconciliation --------> estimated full reservation
```

No transaction or pooled connection survives the OpenRouter, browser, or catalog network wait.

## Public HTTP contract

All schemas remain TypeBox-owned in `packages/protocol`, closed where they are application
contracts, and additive relative to the accepted Phase 5 API.

### Employee tier policy

```http
GET /api/model-tiers
```

```json
{
  "defaultTier": "balanced",
  "tiers": [
    { "tier": "fast", "enabled": true, "available": true },
    { "tier": "balanced", "enabled": true, "available": true },
    { "tier": "pro", "enabled": true, "available": false }
  ]
}
```

- The array always contains exactly Fast, Balanced, and Pro in that order.
- `enabled` is workspace intent; `available` additionally requires a usable, validated catalog
  mapping for the active gateway mode.
- The response is authenticated, workspace-scoped, content-free, and `Cache-Control: no-store`.
- It exposes no reason string because a raw provider or cost explanation is not employee policy.
- Missing bootstrap state returns the same safe shape with no available tiers; it does not invent a
  budget or mapping.

### Preferred tier mutation

```http
GET /api/conversations/:conversationId/preferred-tier
```

```json
{ "conversationId": "<uuid>", "modelTier": "balanced" }
```

```http
PUT /api/conversations/:conversationId/preferred-tier
Content-Type: application/json
```

```json
{ "modelTier": "pro" }
```

The `PUT` response has the same narrow shape as `GET`, with the newly stored `modelTier`. Existing
conversation create, history, archive, search, selection, and detail response shapes remain
unchanged so the immediately preceding closed browser schemas continue to validate them.

- Fastify requires the authenticated owner and an enabled, currently available tier.
- Deleted or foreign conversations use scoped `NOT_FOUND`.
- The mutation may update an active or archived conversation because it changes no content and
  starts no generation.
- It changes neither structural revision nor `updatedAt`; history ordering and loaded branches do
  not move.
- A concurrent later preference write may win. Every generation still carries and revalidates its
  explicit requested tier.

### Generation requests

The four accepted response sources keep their existing shapes and now accept:

```ts
type GenerationModelTier = "fast" | "balanced" | "pro";
```

- The browser still sends no raw model identifier, price, output limit, history, provider option,
  or budget value.
- Fastify re-resolves all policy inside turn creation and persists the request tier as the
  conversation preference.
- `TIER_UNAVAILABLE`, `EMPLOYEE_GENERATION_LIMIT_REACHED`, and
  `WORKSPACE_BUDGET_EXCEEDED` are ordinary pre-stream JSON errors.
- A policy/provider loss after the turn commits uses the existing `MODEL_UNAVAILABLE` stream
  failure and canonical recovery path.

### Compatibility

- Existing conversations and generations migrate as Balanced.
- Older web builds continue sending `balanced`, which remains valid.
- Existing closed conversation schemas receive no additive field; the new browser alone calls the
  separate preferred-tier resource.
- No existing route or stream-event meaning is repurposed.
- Phase 6 adds no public catalog-write, budget-write, usage, cost, provider, or administrator route.

## Persistent model catalog and workspace policy

### Migration

Add one expand-only migration after `0002` containing:

1. `model_catalog`, keyed by an internal UUID with unique exact OpenRouter model ID. It stores the
   backend display name, canonical slug when supplied, text capabilities, supported parameters,
   conservative context limit, prompt/completion/fixed-request price ceilings, real or simulated
   metadata source, availability, successful validation time, refresh attempt time, and refresh
   lease.
2. `workspace_model_policies`, unique by workspace and tier, containing catalog mapping, enabled
   state, maximum output tokens, and timestamps.
3. `workspace_cost_policies`, one row per workspace, containing monthly USD budget, default tier,
   employee active-generation limit, reservation-margin basis points, real-workspace privacy
   attestation version/time, and timestamps.
4. `conversations.preferred_tier`, non-null with an upgrade-safe Balanced default and a three-tier
   check.
5. Generation accounting and reservation columns described below.

Use PostgreSQL checks for non-empty IDs/names, positive limits, non-negative prices/budgets, valid
tier values, valid accounting states, paired period boundaries, and internally consistent actual,
estimated, reserved, or untracked rows. Cross-row rules—one default, an enabled mapping, and
workspace/catalog ownership—remain explicit service transactions.

The migration must apply to an empty database and upgrade an exact Phase 5 database. It does not
backfill fake historical generations as spend and does not contact OpenRouter.

### Catalog validation

The catalog client fetches the ZDR endpoint catalog and exact approved model metadata once per
refresh batch and validates both responses with private TypeBox schemas that permit unrelated
additive OpenRouter fields but strictly validate every field Capstone consumes.

For each exact approved model:

1. Filter by exact `model_id` and healthy endpoint status.
2. Join the exact model metadata and require text input, text output, `max_tokens`, `reasoning`,
   positive context/output limits, and parseable non-negative prompt, completion, fixed-request,
   and cache-read prices. Normalize an omitted optional OpenRouter fixed-request field to explicit
   zero; do not normalize a present invalid field.
3. Ignore unhealthy, malformed, non-ZDR, non-text, or unsupported endpoints. Conservatively combine
   cache-read/write, internal-reasoning, and conditional-override prices as described above; reject
   non-zero image, web-search, or unknown pricing fields that the text-only reservation cannot bound.
4. Derive the lowest safe context/output limit and the maximum current price for every charge
   component across the remaining endpoints. Treat an explicit model-level output maximum as an
   additional bound, not a prerequisite for otherwise complete endpoint metadata.
5. Apply the persisted workspace reservation margin with decimal arithmetic to produce request
   ceilings.
6. Persist one compact model snapshot, not provider rows or the raw payload.
7. Mark the model available only when at least one eligible endpoint remains and the configured
   tier output limit fits its conservative context/output constraints.

An ordinary refresh network failure records only safe timing/error category metadata and preserves
the last good row. A successful catalog response that omits or invalidates the model updates the row
to unavailable. Raw bodies and provider lists are never logged.

### Bootstrap and refresh commands

Add narrowly named root/API scripts following the existing operator-command conventions:

```text
model-policy:bootstrap
model-policy:attest
model-catalog:refresh
```

`model-policy:bootstrap` requires workspace identity plus explicit budget, output limits,
concurrency limit, and margin. In OpenRouter mode it additionally requires the current explicit
privacy-attestation version, validates all three locked model IDs before one transaction, and
inserts the catalog snapshots and workspace policies. In explicitly simulated development/test
mode it inserts marked zero-cost fake snapshots without a network request or real attestation.

The command is idempotent only for identical effective inputs. A conflicting repeat fails with a
content-free operator error rather than silently changing cost policy. Phase 7 supplies controlled
policy updates.

`model-policy:attest` makes no network request and changes only the verification timestamp for an
existing real policy after the operator rechecks the same three privacy settings. An identical
retry is idempotent; the command accepts only a newer verification within the 30-day window and
rejects older, future, simulated, or unbootstrapped state.

`model-catalog:refresh` revalidates only approved rows and returns a metadata-only summary. It does
not accept arbitrary model IDs, mutate workspace mappings, or print prices unless explicitly chosen
for an operator-only diagnostic mode that still prints no secret or content.

### Tier resolution

The generation transaction resolves one policy row by workspace and requested tier, joins the
catalog row, and verifies:

- policy exists and is enabled;
- catalog mapping is approved for the configured gateway mode;
- real OpenRouter mode has a last successful real validation and is currently available;
- maximum output tokens fit the conservative model limit;
- the current prompt estimate plus output allowance fits context; and
- default-tier invariants remain valid.

Failure before turn persistence uses `TIER_UNAVAILABLE` or `MESSAGE_TOO_LARGE` as appropriate. No
policy resolver makes a live network call.

## Generation accounting and decimal rules

Extend `generations` with:

```text
purpose                         chat | compaction
requested_model
resolved_model
provider
openrouter_generation_id
prompt_tokens
completion_tokens
reasoning_tokens
cached_tokens
cost_usd
cost_basis                      actual | estimated
accounting_status               reserved | actual | estimated
estimated_input_tokens
maximum_output_tokens
reserved_cost_usd
prompt_price_ceiling_per_token
completion_price_ceiling_per_token
request_price_ceiling_usd
reservation_margin_basis_points
budget_period_start
budget_period_end
reservation_expires_at
accounting_settled_at
```

Accounting fields are nullable together for pre-Phase6 and simulated local history. Every real
OpenRouter generation has a complete reservation snapshot before its upstream request.

- USD totals use a fixed PostgreSQL `numeric` precision/scale capable of sub-cent accounting.
- Per-token rates use a higher-scale `numeric` column so current catalog rates retain precision.
- Token counts use non-negative `bigint`; backend conversion rejects unsafe or fractional provider
  values.
- Decimal strings are canonicalized at one API boundary. Scientific notation, NaN, infinity,
  negatives, and over-precision inputs are rejected rather than rounded silently.
- `effective_parameters` records only the non-secret model request controls: maximum output,
  reasoning exclusion, privacy flags, required-parameter flag, and per-million price ceilings.
- Actual cost may be above the reservation if OpenRouter reports it. Capstone records the actual
  amount, emits metadata-only operational evidence, and uses it against every later budget check.
- Conversation deletion nulls content references through the existing retention path but preserves
  all accounting columns and identifiers required for workspace reporting.

`response.completed`, `response.cancelled`, and `response.failed` continue exposing only public
input/output token counts. Reasoning, cached tokens, cost, model, and provider remain backend data
until the authorized Phase 7 administration reads are implemented.

## Budget reservation and settlement

### Month boundary

Inside PostgreSQL, derive the current local month from `workspaces.timezone`, convert its start and
next start back to UTC `timestamptz`, and store both boundaries on the new generation. Tests cover
America/Guayaquil plus a daylight-saving timezone even though v1 does not expose timezone changes.

Budget consumption for the period is derived directly from generation rows:

```text
sum(actual cost)
+ sum(estimated cost)
+ sum(still-reserved maximum cost)
```

No balance cache, Redis counter, analytics aggregate, or floating accumulator is introduced.

### Atomic reservation

Within the existing turn transaction and fixed lock order:

1. Reject an existing scoped idempotency key before reserving again.
2. Lock the workspace and require its cost policy.
3. Lock the actor's active workspace-membership row and count active generations.
4. Lock and validate the owned conversation and structural revision.
5. Lock the requested tier policy/catalog snapshot.
6. Construct authoritative context and calculate its conservative input-token upper bound.
7. Calculate the decimal reservation from the persisted price ceilings and output allowance.
8. Sum the same workspace-local period's actual, estimated, and outstanding reservations.
9. Reject if the new total exceeds the hard monthly budget.
10. Insert the messages, generation, complete reservation snapshot, consume the matching draft,
    persist preferred tier, and update selection/revision exactly as Phase 5 requires.

Every rejection before commit leaves messages, title, selection, revision, draft, generation, and
budget unchanged.

### Settlement

The terminal transaction discovers the generation location without locking, then preserves the
global order by locking its conversation first when present and its generation second. It settles
exactly once:

- authoritative usage -> store token fields and actual cost, mark `actual`, release the difference;
- deterministic no-spend rejection -> actual zero;
- no usage yet -> preserve `reserved` for later lookup or expiry;
- expired ambiguity -> copy full reserved cost to cost, mark `estimated`.

Settlement is idempotent. A late checkpoint, cancellation, completion, lookup, or reconciler cannot
change an already actual/estimated accounting row. Actual/estimated cost remains after conversation
deletion.

## OpenRouter gateway

### Request

`OpenRouterGateway` sends `POST https://openrouter.ai/api/v1/chat/completions` with:

```json
{
  "model": "<exact backend mapping>",
  "messages": ["<system + authoritative selected branch + latest user>"],
  "stream": true,
  "max_tokens": "<workspace tier allowance>",
  "reasoning": { "exclude": true },
  "provider": {
    "zdr": true,
    "data_collection": "deny",
    "require_parameters": true,
    "max_price": {
      "prompt": "<USD per million ceiling>",
      "completion": "<USD per million ceiling>",
      "request": "<fixed ceiling, including zero>"
    }
  }
}
```

The real JSON wire values follow OpenRouter's required numeric/string shapes after current contract
validation; the example emphasizes ownership, not literal TypeScript serialization.

- Messages contain only the version-controlled system prompt and backend-selected stored text.
- No tools, browsing, plugins, response format, temperature, top-p, user ID, session ID, debug,
  trace, or prompt-logging option is sent.
- Provider defaults control sampling/reasoning except for hiding reasoning output and bounding total
  output.
- Authorization is read once from frozen backend configuration and is redacted from all failures.

### SSE normalization

The gateway:

- accepts only a successful SSE response with the expected content type;
- captures the generation ID from the response header and/or validated chunk metadata;
- ignores SSE comments as content while allowing them to reset upstream inactivity;
- parses bounded `data:` events with `eventsource-parser` and treats `[DONE]` as framing only;
- validates the minimal OpenRouter chunk fields it consumes while ignoring additive fields;
- emits only non-empty valid text deltas;
- discards all reasoning/reasoning-details content without inspecting or logging it;
- records returned resolved model/provider metadata privately;
- waits for the final usage object before successful completion;
- maps `stop`, `length`, `refusal`, and `content_filter` into the accepted terminal reasons;
- maps typed pre/mid-stream errors into `MODEL_UNAVAILABLE`, `GENERATION_TIMEOUT`, or the existing
  generic generation failure without exposing provider prose; and
- treats malformed content, unsupported tool output, missing final usage, invalid cost, oversized
  frames, and premature EOF as provider/gateway failure.

The coordinator continues to own downstream NDJSON, checkpoints, backpressure, content bounds, and
canonical terminal events. The adapter never writes to Fastify replies or PostgreSQL directly.

### Timeout and abort behavior

Use composed AbortSignals and named timers for:

- request start through response headers;
- response headers through first visible text delta;
- inactivity between upstream SSE activity;
- total generation duration; and
- post-cancellation generation-metadata lookup.

Employee Stop, deletion, disconnect, application drain, cross-replica durable cancellation, or any
timeout aborts the upstream fetch promptly. Abort reasons are classified without attaching prompt,
response, raw event, or URL query data to errors.

## Cancellation accounting and reconciliation

Cancellation keeps the accepted immediate product behavior:

```text
Stop request
  -> durable cancellation + partial checkpoint + revision
  -> local/cross-replica gateway abort
  -> settle final usage if received
  -> otherwise one bounded generation lookup
  -> otherwise retain reservation until expiry
```

The cancellation HTTP response does not wait for OpenRouter metadata. The browser reconciles the
conversation exactly as in Phase 5 while backend accounting may remain reserved.

The lifecycle-owned reconciler starts only after database/application construction, stops before
pool closure, and exposes `runOnce` for deterministic tests. Each pass:

1. discovers a small batch of expired reserved generation candidates without retaining row locks;
2. claims each candidate in the established conversation-before-generation order with
   `FOR UPDATE SKIP LOCKED` (or only the generation after content deletion);
3. terminalizes abandoned active generations as incomplete/`STREAM_INTERRUPTED`;
4. settles the full reservation as estimated and releases locks in one short transaction;
5. separately claims due catalog rows with a short lease;
6. refreshes claimed metadata outside a transaction; and
7. applies validated results in another short transaction.

Failures are metadata-only and leave work retryable. The loop has no content payload, model
generation, queue, worker deployment, or in-memory authority.

## Browser integration

- Add one model-tier query under the authenticated query scope.
- Render exactly Fast, Balanced, and Pro in the existing conversation header and new-chat path using
  centralized Spanish purpose/status copy.
- Initialize a new conversation from the returned workspace default; existing conversations render
  their persisted preference.
- Persist employee selection through the preferred-tier endpoint and update canonical TanStack
  Query data. Components do not infer model availability or mutate conversation revisions locally.
- Keep the picker usable while a response streams so the employee may prepare the next tier; the
  active runtime retains the tier committed at start.
- Disable unavailable options. If the current preference is unavailable, present one calm localized
  status and block Send/Edit/Try again until an available tier is selected.
- Map the three new pre-stream cost/policy codes through centralized Spanish copy while preserving
  draft, focus, inline edit, and stale/canonical recovery behavior.
- Do not display model/provider names, prices, remaining budget, token counts, cost, or internal
  diagnostics.
- Add no generalized form library, client billing utility, provider SDK, or global state store.

## Configuration and secret boundary

Extend the frozen backend configuration with:

```text
MODEL_GATEWAY=fake | openrouter
OPENROUTER_API_KEY=<secret, required only for openrouter>
```

- Development/test default to fake when `MODEL_GATEWAY` is omitted.
- Real local calls require the explicit `openrouter` value; the mere presence of a key never spends.
- Production permits only `openrouter` and requires a non-empty key.
- The key remains backend-only and is never stored in PostgreSQL or returned through an API.
- `.env.example` documents the variable names without a real credential.
- Startup may log only gateway mode and whether required non-secret configuration is valid.
- Tests inject a fetch transport and fake key; they never read the developer `.env` or reach the
  network.

## Dependency policy

Phase 6 may add only:

| Package | Workspace | Purpose |
| --- | --- | --- |
| `eventsource-parser` | `apps/api` | Standards-aware incremental OpenRouter SSE framing |
| `decimal.js` | `apps/api` | Exact decimal comparison and reservation arithmetic before PostgreSQL numeric persistence |

Both are exact direct versions after revalidation. Do not add the OpenRouter SDK, OpenAI SDK,
Undici as a direct dependency, a tokenizer package, ORM repository layer, cron package, queue,
cache, billing platform, or frontend dependency.

## Implementation sequence

### 1. Freeze and reproduce the Phase 5 baseline

- Correct and accept the Phase 5 implementation record.
- Record commit `fc67d41`, status, test counts, bundle sizes, browser evidence, migration set, and
  container result.
- Record the explicit workspace bootstrap inputs and operational Phase 6 tuning values.
- Stop if the baseline changes or contains an unrelated dirty correction.

### 2. Encode additive tier and policy contracts

- Expand the public tier schema to Fast/Balanced/Pro.
- Add employee tier-policy read and preferred-tier mutation schemas.
- Keep conversation summary/detail/search schemas unchanged and expose preference through the
  separate owned preferred-tier resource; preserve old stream shapes.
- Cover closed schemas, stable errors, new-resource compatibility, and older Balanced clients.

### 3. Add the catalog, policy, accounting, and reservation migration

- Add the three policy/catalog structures, conversation preference, and generation fields/checks.
- Apply all migrations to empty and exact Phase 5 databases.
- Prove existing conversations are Balanced and historical fake generations are untracked cost.

### 4. Implement decimal, period, catalog, and bootstrap primitives

- Add canonical decimal parsing/arithmetic and PostgreSQL month-boundary queries.
- Implement private OpenRouter endpoint/model metadata schemas, exact-model validation,
  conservative known-charge aggregation, unsupported-charge checks, and the explicit real-workspace
  privacy attestation.
- Add real and simulated idempotent bootstrap, newer-only privacy re-attestation, and manual catalog
  refresh.
- Do not start inference or expose administrator HTTP routes.

### 5. Resolve tiers and reserve budget inside turn creation

- Introduce the fixed lock order and employee concurrency enforcement.
- Resolve policy/context/output/price, calculate reservation, and enforce the monthly ceiling.
- Persist tier preference and the full accounting snapshot atomically for draft, Continue, edit, and
  retry sources.
- Preserve every accepted idempotency, draft, title, branch, and no-network-in-transaction invariant.

### 6. Implement `OpenRouterGateway`

- Add frozen config selection, native fetch, privacy-safe request construction, SSE parsing,
  metadata capture, usage/cost normalization, timeout classification, and abort behavior.
- Test only through content-free recorded fixtures and injected transports.
- Keep `FakeModelGateway` deterministic and compatible with all three tiers without fake spend.

### 7. Integrate accounting with stream terminals and cancellation

- Record provider metadata as soon as safely available.
- Settle actual completion in the terminal transaction.
- Add zero-cost deterministic rejection, bounded cancellation lookup, and pending ambiguity paths.
- Preserve public NDJSON ordering and emit terminal events only after durable content/accounting.

### 8. Add reconciliation and catalog refresh lifecycle

- Implement one lifecycle-owned narrow loop with deterministic `runOnce` tests.
- Claim/settle expired reservations and abandoned generations with `SKIP LOCKED`.
- Claim catalog refresh leases, perform metadata fetches outside transactions, and apply validated
  results idempotently.
- Integrate graceful shutdown without keeping the pool alive after lifecycle stop.

### 9. Add employee tier presentation

- Add query/API wrappers, picker, new-chat/default behavior, preference persistence, disabled states,
  and centralized Spanish error/status copy.
- Exercise draft, active stream, edit, retry, archive, reload, navigation, and unavailable-tier
  behavior without exposing backend metadata.

### 10. Complete proportional verification

- Add protocol, unit, migration, PostgreSQL concurrency, gateway fixture, real HTTP stream, browser,
  privacy, and lifecycle tests.
- Run dependency audit, full static/test/build gates, Playwright, migration upgrades, container
  inspection, and log/secret scans.
- Perform authenticated metadata refresh without generation spend.
- Ask the user immediately before one minimal paid live generation smoke test; record only metadata.

### 11. Update documentation and record acceptance evidence

- Replace planning status with exact implementation commit, migration, dependencies, tuning values,
  bootstrap inputs without secrets, test counts, live metadata/smoke scope, and residual advisories.
- Update README, `.env.example`, operator commands, local fake/real opt-in instructions, cancellation
  accounting, and recovery behavior.
- Re-audit the final diff for Phase 7/8 leakage before requesting acceptance.

## Required verification cases

### Protocol and compatibility

- All generation sources accept only Fast/Balanced/Pro; raw IDs and unknown tiers fail validation.
- Tier-policy and preferred-tier schemas are closed and content-free.
- Existing conversation responses remain unchanged; the separate preferred-tier resource carries
  the preference.
- Public NDJSON events remain the approved eight types and contain no private cost/provider fields.
- The immediately preceding Balanced-only web build can still use the new API.

### Migration and policy

- Empty and Phase 5 upgrades succeed; rerunning migration application is safe.
- Existing conversations become Balanced; fake history has no billable accounting state.
- Bootstrap identical repeat is a no-op; conflicting budget/limits/mappings fail safely.
- Production rejects fake gateway, absent key, simulated metadata, missing billable policy, and
  invalid numeric inputs before inference can start.
- At least one enabled default is enforced through service transactions.

### Catalog and privacy

- Exact model/endpoint joins import; arbitrary, malformed, non-text, unhealthy, non-ZDR,
  missing mandatory price, present-invalid optional price, unsupported-parameter, or
  unsupported-charge endpoints do not. Omitted optional fixed-request pricing becomes explicit
  zero only at the OpenRouter boundary.
- Price maxima, margin, context minima, and output fit use exact decimal/integer arithmetic.
- Network refresh failure preserves last good metadata; confirmed removal marks unavailable.
- Refresh leases recover after replica loss and do not hold a connection over the network.
- Every inference fixture asserts `zdr: true`, `data_collection: "deny"`, required parameters,
  single exact model, maximum output, reasoning exclusion, and matching prompt, completion, and
  fixed-request price ceilings.
- Real bootstrap fails without the current operator attestation that data-discount logging,
  observability I/O logging, and observability broadcast are disabled; no management secret enters
  runtime configuration or persistence. Exact-boundary freshness, expiry across startup/read/
  generation admission, and idempotent/newer-only renewal are covered.

### Reservation and concurrency

- Month boundaries are correct in America/Guayaquil and across a DST transition zone.
- Actual, estimated, and outstanding reserved rows all count against the same period.
- Two concurrent reservations that cannot both fit allow exactly one; the loser creates nothing and
  preserves its draft.
- Separate employees share the hard workspace ceiling; one employee cannot exceed the configured
  active-generation limit across conversations.
- Same idempotency key never reserves twice; same-conversation active uniqueness remains intact.
- Actual lower than reservation releases the remainder; actual above reservation is recorded in
  full and affects later requests.
- Budget-month rollover excludes the prior period without deleting its accounting.

### Gateway and accounting

- SSE comments, arbitrary chunk boundaries, split Unicode, multiple data lines, `[DONE]`, empty
  deltas, reasoning-only chunks, final usage, and generation metadata normalize correctly.
- Prompt/completion/reasoning/cached token counts and actual cost persist exactly once.
- Resolved model/provider/OpenRouter ID persist privately and survive conversation deletion.
- Pre-stream typed failures, mid-stream errors, invalid frames, oversized events, missing usage,
  empty success, and premature EOF map safely without raw payload leakage.
- Connection, first-token, inactivity, total, and lookup timeouts abort and normalize independently.
- Employee Stop, disconnect, deletion, cross-replica cancellation, and shutdown abort upstream and
  never restart inference.

### Settlement and reconciliation

- Completion commits content, lifecycle, usage, actual cost, and released reservation atomically
  before `response.completed`.
- Cancellation with usage settles actual; lookup success settles actual; lookup ambiguity remains
  reserved until expiry.
- Deterministic no-spend rejection settles zero; ambiguous failure never assumes zero.
- Expired reservation settles full estimate exactly once and abandoned active generation becomes
  incomplete.
- Concurrent reconcilers claim disjoint batches with `SKIP LOCKED` while preserving
  conversation-before-generation lock order; crash/retry remains idempotent.
- A late checkpoint, terminal event, lookup, or cancellation cannot overwrite settled accounting.

### Browser and experience

- Employees see only Fast, Balanced, and Pro with correct default and disabled states.
- Preferred tier persists across reload/navigation and does not change history order or structural
  revision.
- A mapping change/unavailability never silently substitutes another tier.
- Active response retains its committed tier while the picker may prepare the next one.
- Draft send, Continue, edit, and Try again use the currently selected tier and preserve ordinary
  drafts exactly as before.
- Budget, concurrency, tier, and model-unavailable states use centralized Spanish copy, preserve
  focus, and expose accessible status without provider prose.
- Critical tier/send/Stop/recovery behavior passes Chromium, Firefox, and WebKit where the current
  matrix requires it.

### Security, privacy, and operations

- CI and tests make zero external OpenRouter requests and require no key.
- Secret scanning finds no API key in Git, build output, fixtures, snapshots, logs, errors, or
  browser bundles.
- Captured logs contain no prompt, response, raw SSE/JSON payload, reasoning, system prompt,
  authorization header, or catalog body.
- API image contains the new migration/operator code, runs non-root, and starts only with valid
  production gateway configuration.
- Reconciler stops before pool closure and does not prevent graceful stream drain.
- Repository dependency review confirms only the two approved direct packages and no Phase 7/8
  infrastructure.

## Phase boundary

### Accepted Phase 1–5 behavior

- Preserve identity, workspace/ownership, drafts, immutable trees, revisions, search, pagination,
  streaming, cancellation, recovery, edit, retry, Undo, alternatives, Markdown, copy, and smart
  scrolling.
- Do not rewrite accepted modules broadly or mix unrelated cleanup into provider/cost work.
- Existing FakeModelGateway and browser fixture coverage remain the deterministic test foundation.

### Phase 7 — Compaction and administration

- No compaction table, summary, trigger, prompt, model call, context-warning emission, reuse, or
  oldest-turn fallback.
- No `/admin` navigation/page, employee administration, session administration, model catalog form,
  mapping editor, tier enable/default editor, output-limit editor, budget editor, manual-refresh web
  route, usage/cost table, or employee/tier reporting endpoint.
- Phase 6 may expose internal services and operator bootstrap/refresh required to run safely, but no
  browser-admin contract.

### Phase 8 — Production hardening

- No OpenTelemetry SDK, observability vendor, frontend error ingestion, platform deployment,
  secret-manager adapter, edge configuration, backup automation, DR rehearsal, general load suite,
  or production capacity claim.
- Phase 6 performs proportional timeout, concurrency, cross-browser, privacy, and container checks
  only.

### Features outside approved v1 scope

- No browsing, tools, agents, subagents, skills, retrieval, document upload, image generation,
  attachments, memory, sharing, workflows, external application integration, or arbitrary model
  access.
- No provider-specific reasoning UI, raw chain of thought, hidden content persistence, custom
  sampling controls, employee output controls, or API-key management screen.

## Manual verification runbook

From the frozen accepted Phase 5 baseline with Docker and supported browsers available:

1. Run every accepted Phase 5 gate and record the clean baseline.
2. Install only the two approved dependencies with a frozen lockfile diff review.
3. Apply all migrations to empty PostgreSQL and upgrade an exact Phase 5 database.
4. Inspect tables, constraints, indexes, numeric scales, nullable historical accounting, and absence
   of Phase 7 admin/compaction structures.
5. Run simulated model-policy bootstrap and verify local fake Fast/Balanced/Pro behavior incurs no
   spend and requires no key.
6. Run real metadata bootstrap/refresh with the ignored development key; inspect only sanitized
   model availability/count/price metadata and confirm no inference request occurred. Exercise an
   identical and a newer fresh re-attestation, and prove stale/future/older input fails closed.
7. Start fake mode and exercise default Balanced plus tier preference through new, existing,
   archived, reload, active-stream, edit, retry, and unavailable states.
8. Race concurrent users/tabs/replicas against a deliberately small test budget and concurrency
   limit; inspect one atomic winner, preserved losing drafts, and exact reservation rows.
9. Exercise actual, zero, pending, cancelled, interrupted, expired estimated, deletion-retained, and
   month-rollover accounting with injected provider fixtures.
10. Start two replicas, abandon a generation, and verify one reconciler claims and settles it while
    the other skips it.
11. Interrupt catalog refresh between claim/network/update and verify lease recovery without
    weakening the last good policy.
12. Feed the OpenRouter adapter recorded success, refusal, filter, length, provider fallback,
    pre/mid-stream failure, malformed, timeout, usage, cost, reasoning, and abort fixtures.
13. Inspect outgoing captured requests for the exact model, privacy flags, price ceiling, output
    allowance, reasoning exclusion, and absence of optional identity/debug fields.
14. Inspect all server/browser logs and error artifacts for secrets or employee/provider content.
15. Run `pnpm check` and report only any genuine repository failure; do not edit ignored user files.
16. Run `pnpm typecheck`.
17. Run `pnpm test`.
18. Run the configured Playwright matrix and focused tier/stream repetitions proportionate to any
    race corrected during implementation.
19. Run `pnpm build`, build/inspect the production API image, and exercise production config
    rejection for fake/missing-key/simulated-policy states.
20. Run `pnpm audit --prod --audit-level high`, `git diff --check`, secret scans, and a final
    forbidden-scope review.
21. Ask the user for immediate authorization to incur a tiny real-model charge. If approved, run one
    minimal generation per the agreed smoke scope, verify streamed text and authoritative accounting,
    and record metadata only. If not approved, report the real inference path as unverified rather
    than treating it as passed.
22. Rotate the development key before any shared or production use.

## Definition of done

Phase 6 is complete only when:

- The corrected Phase 5 baseline is accepted, frozen, and reproducible.
- PostgreSQL contains the approved curated catalog, explicit workspace cost/model policy,
  conversation preference, and complete generation accounting/reservation state with safe upgrade
  behavior.
- Employees can use exactly Fast, Balanced, and Pro without seeing or submitting raw provider/model
  identifiers, and unavailable tiers never silently substitute.
- Every real request uses the exact mapped model, ZDR, data-collection denial, required parameters,
  output bound, reasoning exclusion, and a price ceiling identical to the reservation basis.
- Turn creation atomically enforces model availability, context, employee concurrency, hard
  workspace budget, reservation, idempotency, branch state, and draft consumption without holding a
  transaction across a network wait.
- Completion, cancellation, failure, interruption, deletion, and process loss preserve immutable
  content behavior while settling actual or conservative estimated cost exactly once.
- OpenRouter's final usage/cost is authoritative, all money arithmetic is decimal/PostgreSQL
  numeric, and current-period enforcement counts actual, estimated, and outstanding reserved cost.
- The reconciler and catalog refresher are narrow, PostgreSQL-coordinated, idempotent, lifecycle-
  owned loops with no queue, worker deployment, content payload, or background generation.
- `FakeModelGateway` remains the zero-network default for development/tests, production rejects it,
  CI never receives a real credential or spends money, and stale real-workspace privacy attestation
  blocks startup/admission until the narrow operator renewal succeeds.
- Protocol, migration, database concurrency, gateway fixtures, real HTTP streaming, browser,
  cancellation, lifecycle, privacy, and container tests pass proportionately across the approved
  browser matrix.
- Documentation explains explicit bootstrap values, fake versus real opt-in, key handling, model
  refresh, budget semantics, settlement, estimated reconciliation, and the exact unverified scope if
  a paid smoke test was not authorized.
- The final diff contains no Phase 7 compaction/admin UI and no Phase 8 platform/observability work.
- Any failed, skipped, paid, or externally unavailable verification is reported exactly rather than
  treated as complete.

Completion of Phase 6 authorizes no automatic Phase 7 work. Phase 7 begins only after Phase 6 is
reviewed, explicitly accepted, planned against its exact baseline, and separately authorized.
