# Phase 11 — Workspace behavior controls

Status: implementation complete locally; production, provider, and manual acceptance pending.

## Authority and corrected release boundary

Phase 11 is the approved post-roadmap amendment for workspace assistant rules, immutable prompt and
model-policy history, and bounded reasoning and temperature controls. It preserves every locked
privacy, authorization, deletion, ZDR, logging, hard-budget, tier-abstraction, model-hiding, title,
compaction, transport, recovery, and deployment decision not amended below.

The Phase 10 database is authoritative. Phase 11 uses the ordinary expand/contract release shape:

1. the existing migration-only PRE_DEPLOY job applies additive migration 0009;
2. the Phase 10 service remains schema-compatible during replacement;
3. Phase 11 code writes the new behavior contract explicitly; and
4. a later 0010 contract release may remove predecessor-compatible defaults only after production
   acceptance.

There is no quiesce operation, health-only product stage, database replacement, data copy,
initialization schema 2, temporary initialization credential, or cutover-stage workflow operation.
The protected workflow remains prepare-source or deploy, and the App Platform contract remains
exactly one service plus one migration-only PRE_DEPLOY job.

## Prior failed attempt and revert

Commit 5a9dc41 implemented the approved application behavior but coupled it to a clean-slate 0009,
replacement-database choreography, schema-2 initialization, temporary initialization credentials,
and a custom cutover workflow. Follow-up commits ca2d2d7, 87ef874, and e88553e corrected validator
and doctl checks, but the initialization job did not initialize the intended replacement database.
The attempt never established acceptable production authority.

Commit 8d2c63d truthfully reverted the Phase 11 release to the proven Phase 10 state. This
reimplementation selectively reuses the application behavior from 5a9dc41; it does not reuse its
migration precondition, schema-2 initialization, replacement-database instructions, temporary
credential path, or cutover machinery.

## Decision A — workspace assistant rules

- One administrator-owned plain-text workspace layer is visible to every active member.
- Normalize CRLF and CR to LF, normalize Unicode to NFC, reject disallowed controls and malformed
  Unicode, and trim only outer JavaScript whitespace. An empty layer is valid.
- The normalized limit is 3,200 Unicode code points and 12,800 UTF-8 bytes. The route body limit is
  20 KiB.
- The browser renders rule text literally and never constructs the authoritative system prompt.
- Save, reset, and revert append immutable full-text revisions with actor, change kind, timestamp,
  and optional reverted-from revision. Revert creates a new head and never rewinds history.
- Active members may read the current workspace layer, locked base, effective composition, and
  update time. They receive no history, actor, model, parameter, cost, or editing authority.

The exact initial and reset workspace text is:

> Eres el asistente interno de Capstone en Ecuador. Usa USD como moneda predeterminada y considera,
> cuando corresponda, la normativa del SRI, el IESS y el Código del Trabajo. Cuando no tengas una
> cifra exacta o información suficiente, dilo con claridad; nunca inventes datos financieros.
> Trata a las personas de «usted» salvo que pidan otro tratamiento.

## Decision B — locked prompt composition

- Employee-visible chat uses code-owned base version capstone-chat-base-v2.
- The normalized workspace layer is first and the mandatory base is last; the base prevails on
  conflict.
- Headings, delimiters, empty marker, base text, and composition function are code-owned and
  byte-exact under tests.
- Chat captures the complete prompt before context planning and records its workspace prompt
  revision. Prompt text is not copied into generation rows or effective-parameter diagnostics.
- Title and compaction use their existing internal prompts and receive no workspace text.

## Decision C — tier controls and defaults

The four named temperature presets are fixed:

| Preset | Value |
|---|---:|
| precise | 0.2 |
| balanced | 0.4 |
| flexible | 0.6 |
| creative | 0.8 |

Initial tier behavior is fixed:

| Tier | Reasoning effort | Reasoning budget | Temperature |
|---|---|---:|---|
| Fast | off | 0 | precise |
| Balanced | off | 0 | balanced |
| Pro | high | 8,192 | balanced |

The reasoning budget is a non-additive sub-cap of the existing output allowance. It does not
increase context, reservation, or the output ceiling. New administrator policy writes reserve at
least 1,024 visible-output tokens when reasoning is enabled. The additive migration does not
rewrite an existing Phase 10 output ceiling; effective resolution clamps provider reasoning
parameters inside the stored total-output envelope.

## Decision D — capability and effective-parameter resolution

- Capabilities are normalized from the exact model and every eligible ZDR endpoint.
- Unverified reasoning metadata makes a catalog row unavailable.
- Supported controls are sent exactly; unsupported temperature is omitted; effort may translate to
  the nearest supported provider effort; a reasoning budget becomes max_tokens only when that
  parameter is consistently supported.
- Every reasoning-capable request requires provider-side trace exclusion.
- The response parser independently strips recognized reasoning and analysis fields.
- Raw reasoning content is never persisted, logged, exported, reported, or returned to a browser.
  Normalized reasoning-token counts remain allowed for accounting diagnostics.
- Every generation stores the exact non-secret effective parameter snapshot used at admission.

## Decision E — hidden calls

- Administrator controls apply only to employee-visible chat.
- Compaction uses the captured Fast mapping and policy revision, provider-default reasoning
  strength, no temperature, and its existing total-output cap.
- Title uses Fast, sends no temperature, disables optional reasoning, and skips the provider call
  when reasoning is mandatory.
- Hidden calls retain existing prompts, accounting, deadlines, settlement, reconciliation, and
  privacy rules.

## Additive persistence contract

Migration 0009_workspace_behavior_controls.sql upgrades any valid database through 0008:

- create workspace assistant-prompt revision/head and model-policy revision/tier tables;
- seed each existing workspace prompt at revision 1 with the approved default, system actor, and
  explicit migration change kind;
- snapshot each current model policy at its existing revision, preserving default tier, budget,
  mappings, enabled states, and output limits without manufacturing earlier history;
- retain concurrency, reservation margin, approvals, privacy attestation, initialization authority,
  conversations, generations, accounting, sessions, and reports in their authoritative tables;
- apply the approved tier defaults without changing model selections or output ceilings;
- mark existing OpenRouter capabilities unverified and unavailable until ordinary runtime refresh;
  simulated rows receive deterministic capabilities;
- add nullable generation ledger references and behavior_contract_version;
- default historical rows and predecessor inserts to contract version 1 without false references;
  and
- require every Phase 11 generation to write version 2 with a policy revision, plus a prompt
  revision for chat. Composite foreign keys enforce immutable references.

The migration does not alter production_initialization, its schema-1 checks, its canonical document,
or its content hash. Fresh schema-1 initialization extends the existing transactions to create both
heads and ledgers. The established identity:bootstrap and model-policy:bootstrap commands remain
available under their existing secret boundaries.

## Public interfaces

- Member GET /api/assistant-rules.
- Administrator assistant current, preview, save, reset, history, and revert routes.
- Complete model-policy current/save responses add reasoning effort, reasoning budget, temperature
  preset, normalized capability diagnostics, and separate effective-status fields.
- Model-policy history and revert routes.
- Stable ASSISTANT_RULES_CHANGED and ASSISTANT_RULES_CONFLICT errors.
- Revision actors remain a closed system/user union with Spanish system label Sistema. Migrated
  initial snapshots use change kind migration rather than pretending to be bootstrap events.
- Employee chat events remain unchanged and expose no model, capability, parameter, history, actor,
  prompt text, or reasoning trace.

All routes are registered in telemetry, with coverage derived from actual Fastify registrations.
Telemetry remains content-free.

## Web behavior

- The administrator area adds Asistente with literal-text editing, server preview, exact counts,
  disclosures, compare-and-swap save/reset, immutable history, and append-only revert.
- Modelos adds bounded controls, capability/effective diagnostics, complete compare-and-swap save,
  history, and revert.
- The account menu adds read-only Reglas del asistente for active members.
- Phase 11 is rebased over the reviewed administrator error mapping, 44 px targets, accessible
  search state, short-viewport account containment, long-content wrapping, and report-dialog fixes
  from PRs 11 through 13.

## Acceptance and delivery boundary

Automated acceptance covers fresh migration plus unchanged schema-1 initialization; populated 0008
upgrade; predecessor version-1 writes; version-2 references; prompt normalization/history; policy
history and capability resolution; admission, context, title, compaction, trace exclusion,
settlement, reconciliation, budget concurrency, authorization, telemetry privacy, responsive and
accessibility flows; deployment contracts; and recovery integrity.

Required local verification is pnpm check, pnpm typecheck, pnpm test, pnpm build, git diff --check,
migration integration, production-container smoke, Playwright, deterministic load, bundle,
repository/operations audit, and recovery verification.

## Completion status — 2026-08-19

Implementation and local verification are complete:

- formatting, static analysis, typechecking, repository boundaries, operations contracts, and
  Drizzle schema/snapshot agreement pass;
- protocol, API, and web suites pass, including fresh initialization, populated 0008 migration,
  predecessor compatibility, catalog-refresh recovery, and recovery-preparation integration;
- the actual 8d2c63d Phase 10 service passes a deterministic smoke against the upgraded schema and
  writes 229 readable version-1 generations with no prompt or policy references;
- the production build and bundle route-splitting report pass;
- all 53 Playwright cases pass across the configured Chromium, Firefox, and WebKit projects;
- the exact production image passes the local production-container smoke; and
- the deterministic built-container rehearsal passes all five measured waves at 20 employees and
  40 active streams under the locked 1 CPU and 1 GiB limits.

The operations audit's recovery-evidence validator and rejection self-tests pass. No live recovery
evidence is manufactured by this delivery; production recovery acceptance remains pending with the
other external gates below.

This delivery ends with implementation and complete local verification. It does not create a
commit, push, pull request, production change, replacement database, data copy, or paid/live
provider call. Production deployment, live OpenRouter capability confirmation, and manual product
acceptance remain explicitly pending.
