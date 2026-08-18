# Phase 11 (B2) — Workspace Behavior Controls Plan

Status: implementation and required local verification complete on 2026-08-17 from exact baseline
`0718468`; owner acceptance and external launch evidence pending

The owner authorized Phase 11 application code, migration, protocol, web, test, and documentation
changes on 2026-08-17. This authorization does not extend to provider or production mutations,
commit, push, pull request, deployment, database reset, destructive action, or paid-model calls.

## Planning record and prelaunch premise

- The application baseline is clean `main` at commit `0718468`, apart from this newly added Phase 11
  planning record. Phase 10 automated verification and user acceptance are complete.
- On 2026-08-17 the owner approved Decisions A through E below and confirmed that Capstone Chat has
  no users, user data, active browser clients, or production history that must survive this phase.
- Immediately before implementation on 2026-08-17, the owner reconfirmed that clean-slate premise
  and separately authorized the scoped code changes described above.
- Phase 11 is therefore a clean-slate prelaunch change. It has one complete protocol and schema,
  one synchronized API/web release, and no historical-data reconstruction or old-client path.
- Migration `0009` contains schema only. Initialization after all migrations creates the first
  truthful prompt and policy revisions. If implementation preflight finds any application rows in
  the current database, do not migrate it. Provision an empty replacement database under separate
  infrastructure/spend authorization; Phase 11 performs no in-place truncation or data copy.
- Preflight must record zero rows for identities/invitations/sessions, workspaces/memberships,
  catalog approvals/policies, conversations/messages/drafts/generations/reservations, reports, and
  every other application-owned table. Migration-journal and provider-neutral infrastructure rows
  are the only permitted state. The release also requires a traffic fence with zero active
  sessions or generations and no serving instance or refresh job writing during schema
  initialization.
- If replacement is required, create the same approved region, PostgreSQL major version, backup
  policy, egress allowlist, and separately scoped application/migration/initialization/recovery
  roles; initialize it from reviewed source inputs; then switch component-scoped URLs during the
  fenced cutover. Copy no identities, invitations, configuration, catalog state, conversations,
  generations, accounting, or reports. Retain the old database only for the approved recovery
  window, then require separate destructive authorization to delete it.
- If invitations, real user data, or a served client are introduced before Phase 11 ships, this
  premise becomes false and the plan must be reviewed again before implementation.
- The review covered all locked PRDs, prior implementation records, protocol contracts,
  administrator and member routes, generation admission, context planning, compaction, title
  generation, catalog ingestion, OpenRouter request shaping, accounting, recovery, CI, and the
  corresponding tests.
- OpenRouter behavior was checked during planning against its current primary documentation for
  [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
  [model metadata](https://openrouter.ai/docs/guides/overview/models), and
  [parameter routing](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters).
  Recheck it at implementation time because capability semantics can change.

## Implementation record

### Delivered boundary (2026-08-17, uncommitted on `07184680259ca5cb133bf42024c1493b6cee9336`)

- No implementation commit exists because commit, push, pull request, deployment, provider access,
  and production mutation were not authorized. The delivered boundary is the current uncommitted
  working tree on the exact baseline above.
- Protocol adds closed assistant-rules current/preview/mutation/history/revert contracts, model
  capability and parameter-support diagnostics, complete model-policy history/revert contracts,
  and the two stable assistant-rules conflict codes.
- Migration `0009_workspace_behavior_controls.sql`, snapshot, and journal add immutable assistant
  prompt and model-policy ledgers, current heads, catalog capability fields, per-tier behavior
  intent, generation prompt/policy references, schema-2 initialization, and a fail-closed
  application-empty guard. Its final SHA-256 is
  `4a20afded8434ae06cdc6428016a53acb805b6a71a3552444d73458f5a24eb46`.
- API adds normalized workspace-rule composition with the locked `capstone-chat-base-v2` block,
  member/admin routes, actor-attributed append-only save/reset/revert history, catalog capability
  normalization, immutable policy mutation/history/revert, pure effective-parameter resolution,
  reasoning-safe OpenRouter request shaping, and exact chat/compaction/title policy references.
- The generation admission statements now lock and capture the prompt head in the same prepared
  transaction as budget and policy authority. This preserves policy-before-prompt lock order,
  removes an extra admission round trip under concurrency, and passes the captured prompt and
  effective parameters through every context-planning branch.
- Production initialization is one schema-2 latch and one coherent identity, assistant-rules,
  catalog, policy, and policy-tier transaction after migration. Direct identity/model bootstrap
  commands and package scripts are retired. Readiness validates the policy mode that matches the
  configured gateway.
- Web adds the member **Reglas del asistente** page, administrator **Asistente** editor with
  preview/reset/history/revert, expanded **Modelos** controls with capability diagnostics and
  immutable policy history/revert, centralized Spanish copy, responsive behavior, literal text
  rendering, and fresh-session/CAS handling.
- Operations add quiesced and initialization App Platform contracts, protected `cutover-stage`
  workflow handling, schema-2 cutover/recovery documentation, behavior-ledger recovery integrity
  checks, and a built-container smoke that performs and idempotently repeats unified initialization.
- Local `pnpm dev` now starts loopback PostgreSQL, migrates, performs the same schema-2 initialization
  with a dedicated live OpenRouter key and ignored content-free privacy attestation, validates
  existing authority on later starts, and withholds the provider key from Vite and non-provider
  setup processes.
- Post-implementation backend audit findings were remediated before handoff: malformed recognized
  provider metadata now aborts a refresh and preserves the last good catalog; policy revert
  revalidates every tier against current eligibility; administrator reads and readiness reject live
  policy/head drift; and both immutable ledgers enforce truthful actor/change attribution pairs.

### Verification evidence (2026-08-17, local, Docker running)

- `pnpm check` passed for 396 files; `pnpm typecheck`, `pnpm verify:repository` (513 files),
  `pnpm verify:operations`, and `git diff --check` passed.
- `pnpm test` passed: protocol 213 (8 files), API 668 (60 files), and web 314 (37 files), 1,195
  tests total. This includes fresh migration, clean-slate refusal, initialization idempotency,
  ledger/head/reference recovery, prompt/policy races, reasoning/accounting, route access, literal
  rendering, history/revert coverage, catalog-refresh preservation, policy-drift rejection, revert
  revalidation, and database-enforced ledger attribution.
- `pnpm test:e2e` passed 50 Playwright cases across the configured Chromium, Firefox, and WebKit
  projects, including administration accessibility, account-menu access, model controls, and
  assistant-rules surfaces.
- `pnpm build` and `pnpm report:bundle` passed. The initial route contains 17 assets / 874,495 raw /
  329,687 gzip bytes and 5 initial chunks; administration remains deferred as 10 chunks / 11
  modules.
- Deterministic load passed against an isolated PostgreSQL 18 database and local load server: 20
  employees / 40 streams, 10 warm-up + 2 measured waves, 35 completed / 4 cancelled / 1
  intentionally failed per wave, zero leaked work, and passed isolation, reconciliation, pool,
  hot-poll, and memory gates. Response-start p95 was 351.25 ms and 245.77 ms against the 500 ms
  objective.
- The separately constrained 1 vCPU / 1 GiB Docker repetition completed all functional and safety
  gates but missed only the host-local response-start objective at 516.94, 528.08, and 525.82 ms.
  This is not recorded as App Platform capacity evidence; rerun on the approved managed candidate
  remains an external launch gate.
- A rebuilt `capstone-chat:phase11` image passed `pnpm smoke:container` against a fresh loopback
  PostgreSQL 18 database at the baseline revision above. The smoke applies schema `0009`, creates
  revision-1 prompt/policy state atomically, proves an exact idempotent initialization repeat, and
  passes built-service readiness and static asset checks.

### Remaining external acceptance

- Reconfirm the application-empty database and writer fence immediately before cutover.
- Refresh the live catalog and perform the separately authorized bounded ZDR/provider trials,
  accounting reconciliation, trace-exclusion evidence, and in-flight before/after isolation checks.
- Rehearse the exact App Platform health-only cutover, distinct roles, egress, backups/restore, and
  managed 1 vCPU / 1 GiB capacity gate.
- Build, commit, hash, and smoke the separately reviewed schema-aware forward candidate.
- Complete manual VoiceOver/screen-reader, 200% zoom, mobile, and short-viewport review.
- Obtain the owner's explicit Phase 11 acceptance. Invitations remain closed until these gates pass.

Two facts about the starting baseline were important:

1. Model-policy revision checking prevented stale replacement, but there was no immutable
   policy history, actor attribution, history API, or revert operation.
2. Reasoning-token accounting and the administrator usage column already existed. Phase 11 extends
   configuration and verification; it does not add a duplicate usage concept.

## Authority and required PRD amendments

Read this plan with `AGENTS.md`, `docs/prd/README.md`, all six locked PRDs, and the accepted prior
implementation records. Phase 11 is a post-roadmap amendment and does not reopen earlier phases.

Before behavior code, amend the locked documents to record these replacements:

| Earlier requirement | Approved Phase 11 replacement |
|---|---|
| The minimal system prompt is wholly code-owned and cannot be customized. | A mandatory code-owned base remains locked. One administrator-owned workspace text layer supplies company context and house rules. |
| Prompt text never comes from database configuration. | The base and composition rules remain in backend code; only the normalized workspace layer is revisioned in PostgreSQL and read by Fastify. |
| Provider defaults govern chat sampling and reasoning. | Administrators configure one bounded temperature preset, reasoning effort, and reasoning budget per tier. Fastify sends only conservatively supported effective values. |
| Model-policy revision is stale-write protection only. | Every successful policy mutation appends a complete immutable snapshot with actor and time. Revert creates a newly validated head revision. |
| The administrator area contains Employees, Models, Usage, and Reports. | It adds **Asistente** for workspace rules. Tier controls and policy history remain under **Modelos**. |
| Employees have no behavior-configuration surface. | Employees still cannot edit behavior, but every active member may read the current locked and workspace rules under **Reglas del asistente**. |
| The tier output allowance is the only explicit output control. | The tier maximum remains the total provider output envelope, including hidden reasoning. The reasoning budget is a sub-cap and is never additive. |
| Every release tolerates the immediately preceding browser build and uses ordinary expand/contract deployment. | The one-time no-user Phase 11 cutover may use one required contract and strict schema behind a health-only writer fence. The ordinary release rule resumes immediately after Phase 11. |

Update these documents before implementation:

- `docs/prd/README.md`: Phase 11 amendment summary, clean-slate premise, and link;
- `01-product-scope-and-experience.md`: administrator and member surfaces plus approved disclosure;
- `02-system-architecture-and-data.md`: prompt/configuration exception, immutable ledgers,
  revision retention, generation references, clean-slate initialization, and the one-time
  health-only deployment exception;
- `03-conversation-model-and-streaming.md`: prompt precedence, generation snapshots, tier controls,
  capability resolution, hidden-call behavior, and trace exclusion;
- `04-cost-control-and-reliability.md`: output-envelope invariant, reasoning sub-cap, reservation,
  settlement, and reconciliation behavior; and
- `06-development-roadmap.md`: Phase 11, the approved foundation exception, the prompt checkpoint,
  and one synchronized prelaunch release.

All privacy, authorization, deletion, ZDR, logging, cost, hard-budget, tier-abstraction, model-
hiding, title, compaction, transport, and operational decisions not explicitly amended here remain
locked. Historical implementation plans remain unchanged.

## Outcome and scope

Deliver one administrator-owned behavior slice in this product order:

1. build and accept workspace rules end to end; then
2. expose and apply per-tier reasoning and temperature controls.

The narrow storage/protocol foundation may include both features before the prompt checkpoint so
one coherent migration can establish all foreign keys and immutable ledgers. It must not expose or
activate tier behavior early.

Acceptance requires:

- the next generation admitted after a rule or policy save uses the new revision, while an already
  admitted generation retains its captured revision;
- every chat prompt contains the locked base after the editable workspace layer, and employees can
  read but never edit current rules;
- history identifies actor and time, retains prior complete snapshots, and revert appends a new
  validated head;
- long workspace rules participate in context planning and compaction without creating a late
  `MESSAGE_TOO_LARGE` surprise;
- tier settings save atomically with mappings, enabled states, output ceilings, default tier, and
  monthly budget;
- unsupported or approximate controls are described truthfully and omitted or translated without
  making an otherwise valid chat fail;
- raw reasoning never reaches messages, persistence, logs, telemetry, reports, or the browser;
  only normalized counts and cost do;
- title and compaction remain isolated from workspace rules and employee-answer style settings;
  and
- reasoning use settles correctly and cannot breach the USD 100 workspace ceiling under
  concurrency.

Excluded: employee-authored or personal instructions, conversation controls, composer controls,
prompt/preset libraries, employee model selection, reasoning traces, model-written memory, queues,
workers, caches, service splits, new dependencies, or an employee-facing parameter description.

## Approved product decisions

Decisions A through E were approved together on 2026-08-17.

### Decision A — workspace-layer limits and normalization

- Maximum 3,200 Unicode code points after normalization.
- Maximum 12,800 UTF-8 bytes after normalization.
- HTTP body limit 20 KiB for dedicated mutation and preview routes.
- Require a well-formed Unicode string; normalize to NFC; convert CRLF and lone CR to LF; reject
  C0 controls U+0000–U+001F except TAB U+0009 and LF U+000A, plus DEL/C1 U+007F–U+009F; then trim
  only the outer code points removed by ECMAScript `String.prototype.trim()`. Preserve all other
  internal whitespace and line breaks.
- Empty workspace text is valid and means “locked base only.”

The code-point limit is deterministic; it is not a promise of exactly 800 provider tokens.

### Decision B — initial and reset workspace text

Initialization creates revision 1 with this exact single-line code-versioned UTF-8 text.
**Restablecer** restores the same bytes in a new revision:

```text
Eres el asistente interno de Capstone en Ecuador. Usa USD como moneda predeterminada y considera, cuando corresponda, la normativa del SRI, el IESS y el Código del Trabajo. Cuando no tengas una cifra exacta o información suficiente, dilo con claridad; nunca inventes datos financieros. Trata a las personas de «usted» salvo que pidan otro tratamiento.
```

An administrator may save an empty layer. Reset is a fresh-session server mutation, not a local
discard action.

### Decision C — temperature surface and initial tier values

Administrators choose named presets; the browser never accepts an arbitrary float:

| Stored preset | Provider value | Spanish label |
|---|---:|---|
| `precise` | 0.2 | Más preciso |
| `balanced` | 0.4 | Equilibrado |
| `flexible` | 0.6 | Más flexible |
| `creative` | 0.8 | Más creativo |

Initial policy:

| Tier | Reasoning effort | Reasoning budget | Temperature |
|---|---|---:|---|
| Fast | off | 0 | Más preciso (0.2) |
| Balanced | off | 0 | Equilibrado (0.4) |
| Pro | high | 8,192 | Equilibrado (0.4) |

The numeric temperature may appear in administrator diagnostics and history. Employees never see
the parameter or model.

### Decision D — deterministic reasoning contract

#### Configuration and ratios

- `maximumOutputTokens` remains the total hidden-plus-visible output envelope.
- Effort values stored by Phase 11 are `off | low | medium | high`.
- Budget is `0` when effort is `off`.
- Enabled budget choices are 1,024, 2,048, 4,096, or 8,192. The API and UI expose only choices
  that leave at least 1,024 tokens for visible output.
- Canonical provider-effort ratios are: `none/off = 0%`, `minimal = 10%`, `low = 20%`,
  `medium = 50%`, `high = 80%`, and `xhigh/max = 95%`.
- For enabled reasoning:
  `effectiveReasoningBudget = max(1024, min(configuredBudget,
  floor(effortRatio × maximumOutputTokens)))`.
- Policy validation runs before resolution and guarantees
  `configuredBudget <= maximumOutputTokens - 1024`; resolution never enlarges the total output
  envelope.

#### Capability source and normalization

OpenRouter's model and endpoint `supported_parameters` arrays prove only top-level parameter
acceptance. The current model catalog also exposes a structured `reasoning` object with
`supported_efforts`, `default_effort`, `default_enabled`, `supports_max_tokens`, and `mandatory`.
Phase 11 parses those documented fields directly; it does not infer semantics from model names or
persist free-form descriptions.

Normalize with these exact rules:

- no model `reasoning` object and no top-level `reasoning` parameter means `mode = none`;
- a reasoning object plus top-level `reasoning`, with `mandatory: true`, means
  `mode = mandatory`; otherwise that consistent pair means `mode = optional`;
- exactly one of the structured object or top-level parameter being present means
  `mode = unverified`, `traceSafety = unverified`, and catalog availability false until a later
  successful refresh is consistent;
- omitted `supported_efforts` means no proven effort selector; `null` means all recognized gateway
  efforts; an array is filtered to recognized values and becomes no selector if none remain;
- even a non-empty normalized effort list is usable only when the exact model and every otherwise
  eligible endpoint also advertise top-level `reasoning_effort`; otherwise normalize effort
  support to `none`;
- unknown effort strings are ignored, while a recognized reasoning field with a malformed type or
  value rejects that refresh and preserves the prior known-good snapshot;
- omitted/false `supports_max_tokens` means no budget control; true plus consistent top-level
  `reasoning` support proves nested max-token wire acceptance only. Top-level `max_tokens` remains
  solely the total output-envelope control;
- `default_effort` and `default_enabled` are retained only as sanitized diagnostics and do not
  override administrator intent; and
- the exact model plus every otherwise eligible endpoint must advertise top-level `reasoning`
  before any reasoning object can be sent.

OpenRouter documents `exclude` as supported across its reasoning interface. Recheck that primary
contract during implementation and each dependency/provider review. If that guarantee is absent,
or if any eligible endpoint cannot accept the reasoning object, a reasoning-capable model is
unavailable rather than allowed to return a trace.

`supports_max_tokens` never proves an exact upstream token cap. In Phase 11 every positive
max-token reasoning budget is therefore `translated`; `exact` is used only for zero when reasoning
is successfully disabled and for an unchanged supported effort. Claiming an exact positive token
cap later requires a separately approved provider-specific contract amendment.

#### Resolution order for employee chat

The resolver rejects an `unverified` catalog row before reservation; it is never a generation-time
fallback. For an available row:

1. A non-reasoning model omits the `reasoning` object entirely. Effort and budget are
   `unsupported`.
2. For optional reasoning with configured `off`, send
   `reasoning: { enabled: false, exclude: true }`; off is `exact` and budget is `exact` at zero.
3. For mandatory reasoning with configured `off`, send only
   `reasoning: { exclude: true }`; off is `mandatory` and the UI says
   `Este modelo razona siempre`. Both effort and budget statuses are `mandatory`.
4. For enabled reasoning with `supports_max_tokens`, send only
   `reasoning: { max_tokens: effectiveReasoningBudget, exclude: true }`. Budget status follows the
   approved `translated` rule; effort is also `translated` intent.
5. Otherwise, for enabled reasoning with at least one supported positive effort, send the
   configured effort when it is supported. Do not select `none` for enabled intent. If the
   configured effort is unavailable, choose the supported positive effort with the smallest
   absolute ratio distance;
   an exact tie chooses the lower ratio and lower expected cost. If ratios are also equal, canonical
   order is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, so `xhigh` wins a tie with
   `max`. The chosen effort is `exact` only when unchanged, otherwise `translated`; budget is
   `unsupported`/advisory.
6. For a reasoning-capable model with no proven strength control, send only
   `reasoning: { exclude: true }`; configured strength is `unsupported`.

Never send effort and max-token controls together. The public support vocabulary is
`exact | translated | unsupported`, with `mandatory` additionally allowed for the off state. The
effective snapshot records configured intent, chosen content-free wire values, separate effort and
budget statuses, `traceExcluded`, and stable closed reason codes. One aggregate status is not
sufficient because effort may be exact while budget is unsupported.

#### Trace exclusion is an independent privacy gate

- Every reasoning object includes `exclude: true`, regardless of effort or budget support.
- A reasoning-capable model is unavailable if provider-side exclusion cannot be guaranteed across
  every eligible endpoint. Optional control support may disappear without making a model
  unavailable; exclusion support may not.
- The response parser independently discards `reasoning`, `reasoning_content`,
  `reasoning_details`, and equivalent future recognized trace fields in streamed and non-streamed
  responses. It never logs or persists raw provider payloads.
- Normalized reasoning-token counts remain available for billing and administrator usage.

### Decision E — hidden-call behavior

The new tier dials apply only to employee-visible `chat` generations.

- **Compaction:** use the versioned compaction prompt, Fast mapping, existing total output cap,
  ZDR/price/accounting controls, and provider-default reasoning strength. Omit temperature. A
  non-reasoning Fast model omits `reasoning`; a reasoning-capable Fast model sends only
  `{ exclude: true }`.
- **Title:** use the versioned title prompt and omit temperature. A non-reasoning Fast model omits
  `reasoning`. An optional-reasoning Fast model sends
  `{ enabled: false, exclude: true }`.
- **Mandatory-reasoning title:** do not reserve money, create a title generation, or call the
  provider. Atomically set the conversation's `automaticTitlePending` false, retain the existing
  `createInitialTitle(firstUserMessage)` fallback, and return the conversation to its settled
  lifecycle. This is a normal skip, not a user-visible generation error.

Hidden calls never receive workspace rules or the visible-chat temperature/strength controls.

A compaction required by an admitted chat uses the Fast mapping and global policy revision captured
with that parent admission, and records that same policy revision on its own generation row. A
later automatic-title attempt is a separate admission: it reads the then-current policy head and
Fast mapping, then records that revision if it creates a title generation. The mandatory-reasoning
skip evaluates that same current head but creates no generation row.

## Locked base and effective prompt

### Base version

Create `capstone-chat-base-v2` in backend code with this exact text:

```text
REGLAS BASE DE CAPSTONE CHAT — OBLIGATORIAS Y PREVALECEN ANTE CUALQUIER CONFLICTO

- Eres Capstone Chat, el asistente de IA para empleados de Capstone.
- Responde en Markdown compatible con Capstone Chat. No emitas HTML sin procesar.
- Sé útil, preciso y directo, y respeta el formato solicitado.
- No afirmes que realizaste acciones ni que accediste a sistemas, cuentas, archivos, sitios,
  herramientas o información fuera de lo incluido explícitamente en esta conversación.
- No inventes fuentes, citas, cifras ni hechos. Distingue con claridad lo conocido, lo inferido y
  lo incierto; cuando no puedas verificar algo, dilo.
- Responde en el idioma de la solicitud más reciente, salvo que la persona pida explícitamente
  otro idioma.
```

The language rule preserves the locked latest-request behavior. Raw HTML remains independently
disabled in the renderer; prompt compliance is not a security boundary. A future base change still
requires PRD review, deployment, a new version, and exact tests.

### Deterministic composition

Compose exactly one system-role message:

```text
CONTEXTO Y REGLAS DEL ESPACIO DE TRABAJO — EDITABLES

<normalized workspace text, or "Sin reglas adicionales.">

<exact capstone-chat-base-v2 text, including its heading>
```

- The editable block is first; the locked block is last and wins conflicts.
- Delimiters, blank lines, and the empty marker are code-owned and versioned with the base.
- Preview and generation planning call the same pure composition function.
- The browser never constructs the authoritative prompt.
- Workspace text exists only in revision tables, authenticated rules responses, and the in-memory
  ZDR chat request. It is not copied into generation rows, logs, traces, metrics, reports, or
  `effective_parameters`.

## Rule visibility, retention, and incident handling

- Every active workspace member can read the current locked base, current workspace layer, and
  effective composition. Only administrators can read history or actor metadata.
- The administrator save/reset/revert UI states, before mutation, that workspace rules are visible
  to all active members, are sent to the configured ZDR provider on every employee chat request,
  and are retained in immutable revision history.
- Prompt and model-policy revisions are retained indefinitely while the workspace exists. The
  schema may cascade them with a workspace row, but Phase 11 adds no workspace-deletion API or
  operator command; any future workspace deletion requires separate product and operational
  authorization.
- Deleted workspace data may remain inaccessible in encrypted backups for the locked 84-hour
  backup-retention period. There is no per-revision edit or deletion operation.
- If a secret is accidentally saved, the response is to rotate or revoke the secret immediately,
  follow the incident process, and save a sanitized new revision. Revert or a new save does not
  erase the old administrator-only revision. Its removal would require a separately authorized
  future workspace-deletion flow and expiry of the backup window.

## Generation snapshot and context behavior

### Admission boundary

The existing short generation-admission transaction is the authoritative boundary. Inside it:

1. authenticate and authorize with the established workspace-first lock order;
2. lock/read the current policy head plus the selected-chat and Fast hidden-call mappings/catalog
   rows;
3. lock/read the current workspace-prompt head;
4. create an immutable `SystemPromptSnapshot` with base version, workspace revision, and composed
   text;
5. resolve an immutable `EffectiveModelParameters` snapshot;
6. pass both snapshots into context planning and reservation;
7. insert the generation with prompt/policy revision foreign keys, price ceilings, and the exact
   content-free effective parameters; and
8. commit before compaction or provider network work.

Prompt save/reset/revert and policy save/revert also lock workspace first. No transaction or pool
connection is held during preview, catalog refresh, compaction, usage lookup, or provider waits.

This makes races deterministic: admission before a mutation commit uses the earlier head;
admission after it uses the new head; retries/edits/continuations are new admissions; and catalog
refresh after admission cannot alter the captured request.

### Context-planner refactor

`ContextPlannerInput` must require the prompt snapshot. Carry it through full-context,
summary-reuse, minimum-history fallback, pending-compaction, worst-case compacted estimates, and
`materializeCompactedChat`. Remove the later static-prompt overlay.

- The full composition participates in the conservative UTF-8 estimator and
  `input + maximum output <= context length` check.
- It may trigger the existing 80% compaction boundary earlier.
- Worst-case summary reservation and six-turn fallback use the same captured prompt.
- A physically impossible prompt/latest-message combination returns 413 before message or
  generation persistence and leaves the draft intact.
- Workspace text never enters title or compaction requests or their input estimates.

## Administrator prompt estimate

- `approximateInputTokens = ceil(normalized workspace UTF-8 bytes / 4)`.
- Calculate it on the API, label it `≈`, and explain that actual tokenization is model-specific.
- Compare editable-layer input cost with the maximum Balanced response cost using decimal-safe
  backend arithmetic:
  `approximateInputTokens × Balanced prompt-price ceiling /
  (Balanced maximum output tokens × Balanced completion-price ceiling)`.
- Omit the fixed request fee because the rules do not add a request.
- Return a rounded decimal-string percentage or `null` when mapping/prices cannot support the
  estimate. The browser never performs money arithmetic.
- Copy: `≈ X % del costo máximo de una respuesta Balanced` and
  `Estimación orientativa; el uso y costo reales dependen del modelo.`

This display estimate does not replace the existing conservative reservation calculation.

## Persistence design — migration `0009`

`0009_workspace_behavior_controls.sql` is the tenth migration. It contains no data reconstruction.
Update Drizzle schema/snapshot/journal, migration-count assertions, CI image checks, and recovery
integrity manifests.

The `0009` guard requires these pre-existing application tables to contain zero rows:

```text
account
answer_reports
client_error_rate_limit_windows
conversation_compactions
conversations
drafts
employee_approvals
generations
messages
model_catalog
openrouter_privacy_attestations
operational_recovery_markers
production_initialization
rate_limit
session
user
verification
workspace_catalog_approvals
workspace_cost_policies
workspace_memberships
workspace_model_policies
workspaces
```

The only permitted application-database rows are the migration ledger entries for `0000` through
`0008`, with expected hashes/order. PostgreSQL catalogs and installed extension metadata are not
application rows. Any future pre-`0009` table must be added explicitly to this deny-by-default
manifest before the migration can ship.

### Clean initialization

- The migration precondition is a fresh database with no application rows. Its first transactional
  guard checks the reviewed application-table set and aborts before any DDL if a row exists. It
  then adds only schema and constraints; no DML or synthetic default is allowed.
- After all migrations, refactor the idempotent operator initialization so one database transaction
  creates the workspace and administrator invitation/configuration, approved catalog rows, prompt
  head and revision 1, and live model policy plus policy revision 1. Any catalog network reads and
  privacy validation finish before this transaction; it consumes only already validated
  content-free snapshots.
- Both revision-1 actors use `actor_kind = system`; the API renders that closed actor as
  `{ kind: "system", label: "Sistema" }`.
- Bump the production initialization document to schema 2. It requires workspace-rules preset
  `capstone-ecuador-v1` and all three approved dial tuples. One versioned backend defaults module
  owns Decision B's exact text and Decision C's complete policy defaults; document validation,
  initialization, reset, and tests import that module rather than duplicate literals.
- Migration `0009` replaces the empty `production_initialization` schema-version check with exactly
  version 2; the initializer and temporary job reject version 1.
- Policy revision 1 keeps the existing approved model mappings, enables all three tiers, uses
  default tier Balanced, output limits Fast 4,096 / Balanced 8,192 / Pro 16,384, monthly budget
  USD 100, and Decision C's exact dial defaults. Operator-owned concurrency and reservation margin
  retain their locked values but are not copied into the revertible snapshot.
- `bootstrap` is the only system-authored change kind; initialization does not invent overwritten
  revisions or actors.
- Remove the standalone `identity:bootstrap` and `model-policy:bootstrap` package scripts and
  production entrypoint commands. Production uses only the unified `initialize` command; managed
  tests/rehearsals use their unified initializer. No callable operator path may create an identity,
  prompt, or policy head independently.
- Readiness fails when a current head lacks its immutable revision or when any initialized policy
  revision does not contain exactly Fast, Balanced, and Pro.

### Workspace prompt head and revisions

Add `workspace_assistant_prompts`:

- `workspace_id` primary key with workspace cascade;
- positive `revision`.

Add `workspace_assistant_prompt_revisions`:

- `(workspace_id, revision)` primary key;
- full normalized `workspace_text`;
- `actor_kind: system | user` and a user ID present exactly when kind is `user`;
- `actor_display_name`, null for `system` and a non-empty point-in-time snapshot for `user`;
- `change_kind: bootstrap | save | reset | revert`;
- nullable same-workspace `reverted_from_revision`, allowed only for `revert`;
- `created_at`; and
- text, byte, actor, source, revision, and timestamp checks.

The current table is pointer-only. Its composite `(workspace_id, revision)` foreign key targets the
revision ledger, and current/admission reads join that exact revision for text, actor, and time.
Save/reset/revert append the immutable row and advance the pointer in the same transaction, so a
head can never name text different from its revision.

### Live model policy and immutable revisions

Extend each `workspace_model_policies` tier row with:

- `reasoning_effort: off | low | medium | high`;
- `reasoning_budget_tokens`;
- `temperature_preset: precise | balanced | flexible | creative`; and
- checks for budget/effort pairing and at least 1,024 visible tokens when reasoning is enabled.

Add `workspace_model_policy_revisions`:

- `(workspace_id, revision)` primary key;
- `default_tier` and `monthly_budget_usd`;
- `actor_kind: system | user` and constrained user reference;
- `actor_display_name`, null for `system` and a non-empty point-in-time snapshot for `user`;
- `change_kind: bootstrap | update | revert`;
- nullable same-workspace `reverted_from_revision`, allowed only for `revert`;
- `created_at`; and
- revision, currency/value, actor, source, and timestamp checks.

Add `workspace_model_policy_revision_tiers` with exactly one Fast, Balanced, and Pro snapshot per
parent revision: model mapping, enabled state, output limit, effort, budget, and temperature preset.

The live `workspace_cost_policies` head gets a composite `(workspace_id, revision)` foreign key to
`workspace_model_policy_revisions`. In one transaction the service validates the complete policy,
appends and verifies the parent plus all three tier snapshots, updates live tier rows, then advances
the live head. No generic repository or trigger is introduced.

The immutable revision selected by the live head is authoritative for administrator reads and
generation admission. Each such read compares default tier/monthly budget and all three live
mapping/enabled/output/dial rows with that revision; any drift fails readiness and the operation
closed with `MODEL_POLICY_CONFLICT`. Catalog availability, prices, and capabilities are then joined
to that verified intent. This prevents a generation from naming a revision whose snapshot differs
from the values actually used.

Operator-owned concurrency and reservation-margin settings are not administrator-revertible.
Catalog prices/capabilities are also not copied as policy intent: revert re-resolves current
catalog state, while generations keep the exact captured prices and parameters.

### Catalog capabilities

Retain the recognized model/endpoint `supported_parameters` snapshot and add constrained,
content-free columns for the normalized model reasoning metadata: presence/mode, effort-support
kind/list, default effort/enabled state, max-token support, mandatory state, and the time/source
contract used to verify exclusion.

- Do not persist provider descriptions, raw payloads, or documentation text.
- Top-level optional support is the exact-model/every-eligible-endpoint intersection.
- Structured model reasoning metadata may only narrow that intersection.
- Unknown effort strings are ignored as specified above. A malformed recognized field rejects the
  refresh and preserves the prior known-good snapshot.

### Generation references

Every Phase 11 generation has a non-null `model_policy_revision` with a workspace-scoped composite
foreign key.

- `chat` rows use `capstone-chat-base-v2` and require a non-null
  `workspace_prompt_revision` foreign key.
- `compaction` and `title` rows use their internal prompt versions and require
  `workspace_prompt_revision IS NULL`.
- The mandatory-reasoning title skip creates no generation row.
- No prompt text is duplicated in `generations`.
- The exact content-free effective-parameter snapshot remains persisted for audit/accounting.

## Revision semantics

### Save and reset

- Every mutation requires `observedRevision` and the existing 15-minute fresh administrator
  session.
- Lock workspace/head, reject stale observation with stable 409, validate the complete candidate,
  append one immutable snapshot, update live state, and return the canonical new head.
- Routes pass authenticated actor ID into the domain service; access logs are not the audit trail.
- Reads, preview, and history require role but not session freshness.
- Prompt reset is a dedicated mutation with `change_kind = reset` and restores Decision B's exact
  text.

### Revert

- Revert never moves a pointer backward and never deletes history.
- It copies the selected snapshot into revision `current + 1`, records the source revision, and
  uses the same stale-write path as save.
- Policy revert revalidates approvals, availability, output limits, spent budget, and all current
  invariants. An invalid historical state returns `MODEL_POLICY_CONFLICT`; partial revert is
  impossible.
- Capability status displayed for old policy intent is resolved from current catalog metadata.

### History

- List newest first with signed opaque cursors and at most 20 complete snapshots per page.
- Prompt history includes revision, full workspace text, closed actor, time, change kind, and
  revert source.
- Policy history includes the complete administrator-owned policy snapshot and the same metadata.
- Employees receive neither history nor actor information.
- All authenticated history/current responses use `Cache-Control: no-store`.

## Protocol and HTTP contracts

All Phase 11 fields are required. There is one closed contract with `additionalProperties: false`;
unknown fields and partial tier-control groups are rejected.

Use this closed actor union everywhere:

- `{ kind: "system", label: "Sistema" }`; or
- `{ kind: "user", userId, displayName }`.

For a user actor, `displayName` comes from the immutable point-in-time snapshot, not a live identity
join. Later rename or deactivation does not rewrite audit history. Do not store or return actor
email in these ledgers.

Required normalized capability shape:

- `temperatureSupported: boolean`;
- `reasoning.kind: none | optional | mandatory | unverified`; `unverified` always pairs with
  catalog `available: false`;
- `reasoning.effortSupport` as the closed union `{ kind: "none" }`, `{ kind: "all" }`, or
  `{ kind: "listed", values: GatewayEffort[] }`;
- `reasoning.maxTokensAccepted: boolean`;
- nullable `reasoning.defaultEffort` and `reasoning.defaultEnabled`; and
- `reasoning.traceSafety: non_reasoning | provider_excluded | unverified`. `unverified` forces the
  catalog item unavailable and remains visible only to administrators as the reason it cannot be
  mapped or used.

Every tier object requires `tier`, `modelCatalogId`, `enabled`, `maximumOutputTokens`,
`reasoningEffort`, `reasoningBudgetTokens`, and `temperaturePreset`. Responses additionally require
the normalized capability and separate `temperatureStatus`, `effortStatus`, and `budgetStatus`.
Statuses use the approved vocabulary and one closed reason per field from:

- `supported`;
- `temperature_unsupported`;
- `non_reasoning_model`;
- `reasoning_disabled`;
- `mandatory_reasoning`;
- `max_tokens_precision_unverified`;
- `effort_nearest_supported`;
- `effort_control_unavailable`;
- `budget_control_unavailable`; or
- `provider_default_strength`.

Generation snapshots may additionally use `hidden_compaction_default` or
`hidden_title_disabled`. A skipped title has the content-free internal outcome reason
`hidden_title_skipped_mandatory` but no generation snapshot. Protocol schemas represent normalized
text/counts directly; domain normalization enforces code-point and UTF-8-byte limits because JSON
Schema string length is not the product's Unicode contract.

### Member rules

`GET /api/assistant-rules` returns current base version/text, current workspace text, effective
prompt, and updated time. It returns no actor, history, model, cost, or mutation data. Any active
member may read it; no member mutation endpoint exists.

### Administrator rules

- `GET /api/admin/assistant-rules`: current configuration, actor/time, limits, retention/provider
  disclosure, and saved estimate.
- `POST /api/admin/assistant-rules/preview`: normalize/validate an unsaved candidate and return the
  authoritative composition, counts, approximate tokens, and cost-impact percentage.
- `PUT /api/admin/assistant-rules`: `{ observedRevision, workspaceText }`.
- `POST /api/admin/assistant-rules/reset`: `{ observedRevision }`.
- `GET /api/admin/assistant-rules/revisions?cursor=`: signed history.
- `POST /api/admin/assistant-rules/revisions/:revision/revert`:
  `{ observedRevision }`.

Mutations require a fresh session and exact same-origin JSON requests. Add
`ASSISTANT_RULES_CHANGED` for stale CAS and `ASSISTANT_RULES_CONFLICT` for valid candidates that
cannot apply. Reuse established authentication, authorization, size, and malformed-request errors.

### Model policy

The existing full policy request gains required configured effort, budget, and temperature preset
for every tier; it never accepts server-derived capabilities or statuses. The response requires
those configured values plus sanitized capability/status fields. The client always sends one
complete Fast, Balanced, and Pro object.

Add:

- `GET /api/admin/model-policy/revisions?cursor=`; and
- `POST /api/admin/model-policy/revisions/:revision/revert` with `{ observedRevision }`.

Continue using `MODEL_POLICY_CHANGED` and `MODEL_POLICY_CONFLICT`. Unsupported optional intent is a
valid saved value, not a mutation conflict.

## Catalog and effective parameter resolution

### Base eligibility

Keep exact approved identity, healthy ZDR routing, text input/output, bounded safe pricing, positive
context/output limits, and top-level `max_tokens` support. Reasoning and temperature are not base
eligibility requirements.

For optional parameters, intersect the exact model with every otherwise eligible endpoint. One
endpoint lacking temperature makes temperature unsupported without removing the model. In
contrast, a reasoning-capable route lacking verified exclusion makes the model unavailable because
trace privacy is not optional. Keep `provider.require_parameters: true` as a wire guard.

Refresh behavior:

- successful refresh atomically replaces model, price, and sanitized capability metadata;
- failed refresh preserves the prior known-good snapshot under existing rules;
- optional-capability removal/restoration changes only future effective requests and never mutates
  configured policy or creates a policy revision; and
- mapping/history responses resolve current support immediately.

### Resolver and gateway boundary

One pure backend resolver receives stored tier intent, normalized catalog capabilities,
generation purpose, and total output envelope. It returns an immutable
`EffectiveModelParameters`. Admission persists that object and passes it to the gateway. The
gateway serializes it without reinterpreting policy.

Employee chat always sends model, messages, total `max_tokens`, stream, ZDR, data-collection denial,
price ceilings, and `require_parameters`. It adds temperature only when supported and reasoning
only according to Decision D. Unsupported fields are omitted.

Compaction/title use Decision E. The response parser discards all trace content before any message,
checkpoint, log, error, or event construction.

## Cost, output, usage, and hard budget

- Reasoning tokens remain hidden output tokens in the existing generation column, normalization,
  settlement, reconciliation, usage schema, and **Tokens de razonamiento** column.
- `maximumOutputTokens` includes visible completion plus hidden reasoning. The reasoning budget
  partitions it and never increases context allowance or reservation.
- Reservation remains conservative input cost plus the full total-output completion/reasoning price
  ceiling plus request fee and existing margin.
- Actual provider cost remains settlement truth. Reasoning counts are diagnostic; they do not
  recompute the provider's authoritative charge.
- Explicit stop, timeout, provider failure, missing terminal usage, authoritative usage lookup,
  lookup failure, and expiry reconciliation retain existing ambiguity rules and full-envelope
  safety.
- The workspace-local monthly period, USD 100 hard ceiling, transaction locks, employee
  concurrency, cancellation, and expiry behavior remain unchanged.

## User experience

### `/admin/assistant`

Add **Asistente** to the existing administration shell. Reuse current forms and feedback patterns.
The page contains:

1. plain-text **Reglas de Capstone** textarea;
2. immediate advisory and debounced server-confirmed counts;
3. the exact limits and remaining count;
4. approximate token/cost impact with its caveat;
5. read-only plain-text effective preview;
6. the visibility/provider/retention disclosure;
7. **Guardar**;
8. **Restablecer** with confirmation and exact target; and
9. newest-first history with actor, time, full prior text, and **Revertir**.

Debounce preview around 250 ms, cancel superseded requests, and never call a model. Keep local draft
separate from server state. Disable save when unchanged, invalid, preview-stale, or mutating. On
stale conflict, refetch while preserving local text. Reuse the existing sign-in path for stale
sessions. Render text literally with `white-space: pre-wrap`, never Markdown/HTML.

### `/admin/models`

Extend the existing single complete policy form:

- effort: Desactivado, Bajo, Medio, Alto;
- budget choices filtered by output ceiling;
- named temperature scale;
- exact/translated/unsupported/mandatory status and stable explanation;
- current total-output-envelope explanation; and
- newest-first complete policy history with revert.

Changing mapping/output immediately recomputes valid choices and status without silently changing
saved intent. Saving remains one atomic policy replacement.

### `/account/assistant-rules`

Add **Reglas del asistente** to the authenticated account menu. It shows current workspace text,
locked base, effective order, last-updated time, and a clear read-only explanation. It has no actor,
history, model, parameter, or mutation information. Navigation uses the existing draft-flush path.

## Architecture and expected file impact

- `apps/web` owns display and interaction only.
- `apps/api` owns normalization, composition, authorization, revisions, catalog resolution,
  persistence, budgets, and provider shaping.
- `packages/protocol` contains closed schemas and inferred public types only.
- Keep prompt administration and model-policy administration as explicit small services; share
  established primitives, not a generic revision repository.
- Extend the existing catalog/gateway/accounting paths and both hand-written policy projections.

Expected impact:

- add `packages/protocol/src/assistant-rules.ts`; extend admin/error/index contracts and tests;
- add `apps/api/src/database/assistant-rules-schema.ts`; extend policy/generation schemas and central
  export;
- add migration `0009_workspace_behavior_controls.sql`, Drizzle metadata, recovery and CI checks;
- extend unified initialization so prompt/policy revision 1 are created together after migrations,
  and retire the independent identity/model-policy bootstrap commands;
- add exact `cutover-quiesced` and `cutover-initialize` App Platform contracts, validator/tests,
  and a protected one-time cutover workflow operation while preserving the steady live contract;
- add a focused `apps/api/src/assistant-rules/` domain and member/admin routes;
- refactor prompt/context/admission generation code to carry immutable snapshots;
- extend catalog provider contracts, catalog refresh, policy administration, gateway shaping, and
  accounting tests;
- add `apps/web/src/administration/assistant-page.tsx` and
  `apps/web/src/identity/assistant-rules-page.tsx`; extend the existing Models page, shell, account
  menu, centralized Spanish copy, styles, and tests; and
- amend the PRDs and operational/recovery documentation named above.

Keep compaction/title modules purpose-isolated. Update fake/load gateways for the immutable
parameter object without making deterministic test text temperature-dependent.

## Ordered implementation

### 0. Record authority and baseline

- [x] Record Phase 10 user acceptance.
- [x] Amend the PRDs/roadmap and adopt this clean-slate plan from exact commit `0718468`.
- [x] Reconfirm the no-users/no-data/no-active-client premise.
- [x] Obtain separate scoped code authorization.

All four implementation gates were completed on 2026-08-17. External mutations, deployment,
database reset, destructive action, paid provider calls, commit, push, and pull request remain
separately gated.

### 1. Clean-slate storage and protocol foundation

- Add the one required closed protocol, stable errors, migration `0009`, heads, ledgers, current
  controls, normalized catalog reasoning metadata, generation references, and initialization.
- Make all prompt/policy mutations actor-attributed and atomic from their first available write.
- Populate required generation references from the first Phase 11 generation across chat,
  compaction, and title.
- Keep all new UI and provider behavior unavailable during this internal checkpoint.

This is the approved narrow foundation exception to prompt-first sequencing. It exists to avoid
split ledgers and unaudited writes, not to expose tier behavior early.

### 2. Workspace prompt backend

- Implement base v2, default text, normalization, composition, estimates, revision services, and
  member/admin routes.
- Capture prompt revisions at admission and carry the snapshot through every context-plan branch.
- Prove compaction materialization retains the chat prompt and hidden calls never receive workspace
  text.
- Add route, race, retention/disclosure, and content-canary tests.

### 3. Workspace prompt web and acceptance checkpoint

- Add centralized Spanish copy, admin/member pages, navigation, preview, reset, history, revert,
  disclosure, and conflict/session behavior.
- Complete unit, integration, Playwright, responsive, keyboard, zoom, reduced-motion, and
  screen-reader checks.
- Demonstrate save-to-next-answer, in-flight isolation, member read-only access, revert, and
  near-full-context compaction.

Do not begin tier-control provider behavior until this checkpoint has automated and user
acceptance.

### 4. Catalog capabilities

- Extend raw provider parsing only for documented fields.
- Normalize the documented per-model reasoning object and conservative endpoint parameter
  intersection.
- Relax base model eligibility to allow non-reasoning models while enforcing trace-exclusion
  availability.
- Persist recognized intersections and normalized reasoning metadata; preserve configured intent
  through refresh changes.
- Verify the three production mappings and simulated absent/malformed/changed metadata.

### 5. Atomic policy, history, and Models UI

- Activate complete dial validation and approved defaults.
- Append every update/revert snapshot with actor in the same transaction as the live head.
- Add history/revert routes and the existing Models-page controls/status/history.
- Test stale writes, invalid combinations, remaps, consumed-budget conflicts, and workspace
  isolation.

### 6. Resolver, gateway, trace privacy, and accounting

- Resolve and persist the immutable effective object during admission.
- Serialize only supported temperature/reasoning fields and apply hidden-call branches exactly.
- Implement mandatory-reasoning title skip before reservation/generation/provider work.
- Discard trace content while preserving normalized usage.
- Verify the full status matrix, lifecycle failures, reconciliation, concurrent reservation cap,
  and in-flight isolation.

### 7. Complete prelaunch acceptance and synchronized release

- Run every repository, migration, recovery, load, browser, and security gate.
- Build one exact green commit containing protocol, migration, API, web, and operations changes.
- Build and smoke the separate schema-aware forward candidate from that exact commit.
- Execute the source-controlled quiesced → candidate health-only → temporary initialization →
  final-contract choreography below; expose matching API/web artifacts only at the final step.
- Use a real provider only under separate bounded paid-call authorization.
- Record the exact commit, migration count/hash, automated evidence, authorized manual evidence,
  deviations, and remaining production acceptance.

## Verification matrix

### Protocol, routes, and security

- exact closed actor/rules/history/policy/capability shapes and unknown-field rejection;
- required complete Fast/Balanced/Pro tuples and partial-control rejection;
- Unicode normalization; exact code-point, byte, and 20 KiB HTTP boundaries;
- unauthenticated, deactivated, member, stale-admin, and fresh-admin authorization cases;
- missing/wrong Origin, non-JSON, malformed Unicode, and tampered-cursor rejection, plus
  indistinguishable 404 for cross-workspace revision IDs;
- `no-store` on authenticated current/history responses; and
- stable Spanish error/copy mapping without request-body logging.

### Migration, initialization, CI, and recovery

- fresh migrations through `0009` and exactly ten journal entries;
- an empty-schema `0008` restore followed by `0009` and bootstrap, without data transformation;
- a precondition failure if application rows exist before the clean-slate initialization path;
- idempotent prompt revision 1 and complete policy revision 1 with system actor;
- head-to-ledger composite integrity and exactly three canonical policy tiers per revision;
- required generation policy references and purpose-specific prompt references;
- actor/change-kind/revert-source/text/budget/output/database checks;
- cross-workspace foreign-key rejection;
- `.github/workflows/ci.yml` verifies the production image contains
  `0009_workspace_behavior_controls.sql` and can initialize a fresh PostgreSQL database; and
- App contract tests cover `cutover-quiesced`, `cutover-initialize`, and final modes; protected
  workflow tests prove `cutover-stage` rejects the wrong predecessor/candidate/topology, never
  force-pushes, and waits for the exact deployment;
- live validation proves the quiesced service and initialization service have no runtime secrets,
  the temporary job has only its four approved secrets, the steady migration job has only its
  migration URL, and all components report the expected source SHA;
- recovery verifies migration count/hash, table/constraint integrity, heads, tier completeness,
  and generation references without exposing content; and
- the prebuilt forward candidate's production container starts, reads/writes initialized schema
  `0009`, records required chat/compaction/title policy references, settles/reconciles usage, and
  passes readiness without a database downgrade.

### Prompt and context

- exact base v2 bytes/version and one-system-message composition;
- locked block last under empty, ordinary, and contradictory workspace text;
- preview/save share normalization/composition/estimate functions;
- actor/time/history immutability, CAS, reset target, append-only revert, and cursor stability;
- every context-plan branch retains the admitted prompt snapshot;
- just below/at/above compaction threshold includes full prompt bytes;
- impossible input returns 413 before persistence and preserves draft;
- no transaction/connection during external waits; and
- workspace canary appears only in the intended ZDR chat request, never hidden calls, logs,
  telemetry, errors, reports, or effective parameters.

### Catalog, resolver, gateway, and trace privacy

- non-reasoning model eligibility and omitted reasoning object;
- model/every-eligible-endpoint intersection for `temperature`, `reasoning`, and
  `reasoning_effort`;
- both-absent non-reasoning metadata, either one-sided unverified mismatch, null/listed/unknown
  efforts, malformed fields, and removed/restored reasoning metadata;
- unavailable reasoning-capable model when exclusion cannot be guaranteed;
- effort-ratio table, budget formula, minimum visible output, and lower-cost tie-break;
- exact/translated/unsupported/mandatory truth table and no exact claim from either top-level
  `max_tokens` or nested `reasoning.supports_max_tokens` acceptance alone;
- exact wire bodies for temperature, off, max-token, effort-only, default-only, mandatory, title,
  and compaction cases;
- never send effort plus reasoning max tokens together;
- `exclude: true` on every reasoning object and preserved ZDR/data denial/price/parameter guards;
- mandatory-reasoning Fast skips title before reservation/generation/provider work, consumes the
  naming opportunity, and retains deterministic fallback; and
- streamed/non-streamed trace fields are discarded while usage counts survive.

### Policy, accounting, concurrency, and load

- complete atomic policy mutation and snapshot with no partial write;
- stale save/revert winner behavior and current-state validation;
- unsupported intent persists across save, refresh, history, and revert;
- admission before/after prompt/policy commits selects the correct head;
- in-flight prompt/policy/catalog snapshots never change;
- reasoning remains inside the total output envelope and full-envelope reservation;
- exact settlement with nonzero reasoning counts;
- explicit stop, timeout, provider failure, reasoning-only output, missing terminal usage,
  successful authoritative usage lookup, lookup timeout/failure, and expiry reconciliation;
- cancellation/failure releases only the safely unused remainder, while ambiguous outcomes and
  expiry reconciliation retain the conservatively required reservation;
- administrator reasoning totals equal persisted normalized counts; and
- adversarial concurrent Pro/high admissions cannot push committed workspace spend above USD 100.

### Web, accessibility, and privacy

- admin prompt form, counts, preview, disclosure, estimates, save/reset/history/revert;
- stale-save draft preservation and fresh-session sign-in flow;
- named controls, filtered budgets, truthful statuses, and one complete Models policy form;
- protected read-only member page, account-menu draft flush, and absence of edit controls;
- literal text rendering and no model/endpoint/history/actor/parameter leak to employee chat;
- keyboard order, labels, focus, `aria-live`, 200% zoom, reduced motion, mobile/short-height layout,
  and target browsers; and
- prompt/trace canaries absent from browser events, Pino, New Relic, OTLP, and error payloads.

### Required checks

Run after each feature checkpoint and for the full phase:

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Also run `git diff --check`, migration integration tests on a fresh database, production-container
smoke, deterministic load tests, relevant Playwright flows, and recovery verification.

## Manual and external acceptance

This plan authorizes no external mutation or paid call. After separate authorization:

1. Refresh the live catalog and capture content-free capability evidence for Fast,
   Balanced, and Pro.
2. Make one bounded ZDR chat trial per distinct effective reasoning mode and verify accepted fields,
   excluded traces, usage, and cost.
3. Prove prompt and policy before/after-admission isolation while a request is active.
4. Exercise near-full-context compaction with the captured prompt and no late 413.
5. Generate nonzero Pro reasoning usage and reconcile cost to the administrator table.
6. Exercise unsupported temperature and non-reasoning success paths.
7. Exercise the mandatory-reasoning Fast title skip without a provider request or cost.
8. Revert prompt and policy revisions and prove each operation appends an actor-attributed head.
9. Repeat keyboard, screen-reader, mobile, and narrow/short viewport review.

## Rollout and forward recovery

Phase 11 has one synchronized product release, but the no-writer schema cutover uses explicit
health-only infrastructure stages. None of the health-only stages serves an old or partial product.

### One-time App Platform cutover

1. **Prepare the database and evidence.** Reconfirm zero users/sessions/generations and audit every
   application table. Use the current database only if every row count is zero. Otherwise provision
   the separately authorized empty replacement described above, complete egress/role/backup checks,
   and keep both old and replacement URLs component-scoped and undisclosed.
2. **Quiesce the accepted release.** With the release pointer still on the accepted Phase 10 commit,
   use a separately authorized dashboard configuration change to deploy an exact
   `cutover-quiesced.contract.yaml`. It preserves the production domain, edge policy, Dedicated
   Egress, region, size, and source, but runs only `egress-bootstrap`, has no database/auth/email/
   model/telemetry secrets, and has no job. The validator continues to require DigitalOcean
   maintenance disabled. Wait for this deployment to be active, then prove the former application
   database has no remaining sessions, locks, refresh leases, reconciliation activity, or writers.
3. **Stage the Phase 11 source while still health-only.** Add a protected
   `Deploy production` operation named `cutover-stage`. It is permitted only when the active App
   exactly matches the quiesced contract at the recorded predecessor SHA and the requested SHA is
   the exact current green protected-`main` head. It non-force fast-forwards
   `app-platform-production`, requests one deployment, and validates that the active service still
   matches the quiesced contract and now reports the Phase 11 candidate SHA.
4. **Initialize with temporary authority.** Under a separate external-mutation/credential grant,
   stage exact `cutover-initialize.contract.yaml`: the same candidate health-only service plus one
   candidate-source `PRE_DEPLOY` job running
   `node apps/api/dist/entrypoint.js initialize`. Only that job receives
   `CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL`,
   `CAPSTONE_BOOTSTRAP_DATABASE_URL`, `OPENROUTER_API_KEY`, and
   `CAPSTONE_INITIALIZATION_DOCUMENT`; it receives no final application role, Better Auth,
   Resend, or telemetry secret. Its non-secret schema selector is exactly
   `CAPSTONE_INITIALIZATION_SCHEMA_VERSION=2`. The command applies migrations through `0009`, then
   creates the coherent revision-1 state. Verify the document-hash latch, head/ledger integrity, exact
   idempotent repeat, and content-free output.
5. **Remove temporary authority.** Return to the candidate quiesced contract, remove the temporary
   job and variables, revoke both initialization roles and short-lived catalog key, and prove the
   active service still has no runtime secrets or database connections.
6. **Activate the complete product.** Stage exact `app.contract.yaml` with the final application
   role on the service and the distinct migration role on the sole migration job; when a replacement
   database is used, this is the only point that switches those component-scoped URLs. The
   migration job's repeat is idempotent. Validate the provisional active deployment, then run the
   protected normal `deploy` operation at the same candidate SHA and require service/job/runtime
   source identity, readiness, smoke, and live-contract evidence before invitations.

The new cutover contracts, validator modes, workflow operation, and runbook are source-controlled
and covered by contract tests. The steady state remains exactly one service and one migration-only
job. No console, App-level secret, second service, worker, database downgrade, or maintenance-mode
exception is introduced.

Failure handling is boundary-specific:

- Before the quiesced deployment becomes active, the accepted release and schema are unchanged.
- If candidate health-only staging fails, freeze the exact deployment; the accepted health-only
  release remains active and no schema has changed.
- If migration/initialization fails or is ambiguous, keep health-only active, inspect that exact job
  and durable latch, and correct only with a reviewed forward candidate. Do not start final service
  or repeat an ambiguous job blindly.
- After schema `0009` exists, never deploy Phase 10 code. If final activation fails, App Platform
  must leave the candidate health-only service active while a schema-aware forward fix is prepared.
- Once live, recovery is restore plus migrations and reviewed forward source deployment; database
  downgrade and App Platform native rollback remain prohibited.

### Prebuilt schema-aware forward candidate

Before cutover approval, create and CI-test a concrete descendant of the final candidate solely as
forward-recovery evidence. It must retain schema `0009`, the required closed protocol, prompt and
policy ledgers, actor attribution, base v2/workspace prompt behavior, required chat/compaction/title
policy references, trace exclusion, reservation, settlement, and reconciliation. Its narrow change
omits visible-chat temperature/reasoning-strength fields and hides tier-control mutation UI while
preserving configured intent and administrator history; reasoning-capable calls still send
`exclude: true`, and mandatory-reasoning title skip remains intact.

Record its commit/diff hash and reproducible construction steps, build its production container,
and smoke it against an initialized `0009` database. It is not moved to the production pointer.
If needed, land the reviewed diff as a new descendant of current `main`, rerun all CI gates, and
deploy through the normal protected workflow. The Phase 10 binary is never a recovery candidate.

Catalog uncertainty drops optional controls and never widens privacy, endpoint, or price
eligibility. A replacement database must have a post-initialization backup and successful restore
drill before invitations. Retain the former database/backups for 84 hours, then delete them only
under separate destructive authorization. Invitations remain closed until rollout, recovery, and
acceptance gates pass.

## Observability and security

- Add only content-free counters/timings for validation, save conflict, revision append/revert,
  title skip, and support status.
- Revision number, tier, purpose, catalog validation time, and status may be diagnostic metadata.
  Prompt text, rule revisions, raw traces, and provider payloads may not.
- Preserve the logging allowlist and prove content canaries never cross it.
- Mutation bodies and history responses stay out of access logs and use `no-store`.
- Database access remains workspace-scoped; member routes never join history/actor tables.
- Fresh-session enforcement uses durable server session creation time.
- The locked prompt is an instruction, not a sanitizer or authorization boundary. Existing
  Markdown, ownership, identity, privacy, and cost guards remain independently enforced.

## Definition of done

Phase 11 is complete only when:

- Phase 10 user acceptance, PRD amendments, exact starting baseline, and code authorization are
  recorded;
- the clean-slate premise remains true through release;
- both feature checkpoints and the full verification matrix pass;
- every acceptance item maps to a named test or authorized manual artifact;
- migration, initialization, CI-image, production, recovery, and forward-revert documentation is
  current;
- the health-only cutover has been rehearsed, the prebuilt schema-aware forward candidate is green
  against initialized `0009`, and both exact source identities are recorded;
- history begins truthfully at initialization and is immutable for workspace lifetime;
- workspace text appears only in its revision ledger, deliberately authenticated member/admin
  current responses, administrator preview/mutation/history responses, the authenticated browser's
  transient memory/rendering for those surfaces, and the intended in-memory ZDR chat request; raw
  reasoning content appears in none of them;
- no required check is skipped without an exact blocker and unverified-scope statement;
- the implementation record lists actual commit, files, migration/hash, checks, deviations, and
  remaining external acceptance; and
- the user explicitly accepts the completed phase.
