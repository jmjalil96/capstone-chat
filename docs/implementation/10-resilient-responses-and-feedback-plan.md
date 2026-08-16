# Phase 10 — Resilient Responses and Employee Feedback Plan

Status: implemented and automated verification complete on 2026-08-15; user acceptance pending

Code authorization: granted by the user on 2026-08-15 ("proceed"). It covers repository code,
tests, and documentation only. It does not authorize a commit, push, pull request, production
deployment, external service mutation, or paid action.

## Planning record

- Phase 10 starts from commit `8871b9a` (`Simplify chat shell and composer`) with a clean working
  tree.
- The user authored the plan below and accepted a read-only review on 2026-08-15. The review
  verified against the tree that the checkpoint scheduler already persists partial content every
  250 ms or 1 KiB, that the HMAC cursor codec is reusable, that the web NDJSON parser skips unknown
  event types (so `conversation.naming` is additive for older clients), and that eight migrations
  exist so `0008` is the ninth.
- The user accepted these review outcomes and guardrails, which this plan treats as locked:
  1. Naming stays coupled to the parent chat lifecycle through the internal `finalizing` status.
     Generation actions are fenced for at most eight seconds. Decoupling was rejected because it
     would split lifecycle authority, revisions, Stop behavior, reattachment, and concurrency
     accounting and could permit overlapping title and chat provider calls. During `finalizing`,
     Stop cancels only naming; the completed answer remains completed.
  2. The pre-sign-out cancellation hook is kept. Once socket loss no longer cancels work, dropping
     it could leave model calls spending for up to five minutes with no authenticated UI able to
     stop them. The hook performs only durable database cancellation, then aborts local registry
     IDs; it never awaits the provider. It intentionally cancels that user's work across all tabs
     and devices.
  3. A same-title rename remains a no-op for `revision` and `updatedAt` and only clears the hidden
     `automatic_title_pending` flag, matching the existing same-title behavior in
     `apps/api/src/conversations/service.ts`. A genuinely different title retains the revision-CAS
     behavior.
  4. Backpressure detach: after the five-second backpressure timeout, mark the writer detached,
     settle and remove its pending listeners, stop heartbeats, and call `reply.raw.destroy()`
     (`end()` can remain stuck behind buffered data). Socket detachment never enters the gateway
     abort signal and never produces `STREAM_INTERRUPTED`; checkpointing and generation completion
     continue. Ordinary close and error paths only mark the writer detached because the socket is
     already closing.
  5. One exhaustive lifecycle predicate replaces negative terminal tests: nonterminal workflow
     statuses are `preparing | active | finalizing`; terminal statuses are
     `completed | cancelled | incomplete | failed`. Provider-active checks are not widened blindly:
     `finalizing` blocks conversation workflow and admission but is not itself an active provider
     row; the title child is. Cancellation is phase-aware: active or preparing chat becomes
     cancelled, while finalizing cancels the title child and completes the already-finished parent
     answer.
- Rollout caveat accepted by the user: `finalizing` is emitted only once every serving API
  understands it (production is one App Platform instance, so the deploy itself satisfies this),
  and web/protocol acceptance of admin usage purpose `title` is staged before the API returns
  that closed-enum value. This plan records the two-release boundary below.
- Read-only review coverage before implementation: `response-stream.ts`, `generations/service.ts`,
  `durable-authority.ts`, `active-streams.ts`, `compaction-service.ts`, `admission.ts`,
  `budget-service.ts`, `generation-schema.ts`, `conversation-schema.ts`, migration `0007` and the
  journal, `routes/responses.ts`, `routes/conversations.ts`, `routes/admin.ts`,
  `auth/authentication.ts`, `usage-service.ts`, `generations/administration.ts`, the web
  `ChatRuntime`, stream parser, response-state hook, conversation page, draft editor, message
  actions, admin shell and usage page, the protocol package, and the locked PRDs.

## Authority and amendment semantics

Read this plan with `AGENTS.md`, `docs/prd/README.md`, all six locked PRDs, and the accepted Phase
3 through Phase 9 implementation records.

Phase 10 is a post-roadmap reliability and feedback amendment. It does not reorder or reopen the
eight accepted delivery milestones or the Phase 9 presentation amendment. It explicitly amends:

| Earlier requirement | Approved Phase 10 replacement |
|---|---|
| The initial title is created deterministically from the first user message without a separate model call. | The deterministic first-message title is a provisional fallback. A new conversation receives one bounded Fast title attempt after its first completed root answer, inside an eight-second naming phase. Existing, manually renamed, and failed-naming conversations retain their title permanently. |
| Every OpenRouter request has purpose `chat` or `compaction`. | `title` is a third accounted model-call purpose, visible to administrators as `Título`. |
| On browser cancellation or disconnection, Fastify aborts upstream processing; an interrupted downstream stream is not resumed. | Downstream disconnection detaches presentation instead of cancelling generation. Browsers reattach to the same generation through a durable updates endpoint. Explicit Stop, logout, deletion, deactivation, provider limits/errors, the five-minute total timeout, and shutdown still cancel work. |
| The admin UI does not expose message content. | Administrators receive one narrowly consented exception: an employee may explicitly report one answer, sharing that answer and its direct prompt. Administrators see only that pair, the reporter, reason, and optional note, and gain no conversation access. |
| Deletion removes conversation content. | Reports disappear with their source content: deleting the source answer or conversation cascades the report and its note. |

Every product, privacy, security, data, model-policy, cost, transport, API, protocol, database,
retention, and operational decision not named above remains locked. Historical implementation
plans remain unchanged.

## Summary

Deliver one post-v1 slice in this order:

1. Amend the locked PRDs and transport contracts.
2. Add the shared migration and generation lifecycle.
3. Implement automatic titles.
4. Implement durable stream reattachment.
5. Add employee reporting and the read-only admin inbox.
6. Complete compatibility, privacy, accessibility, and load verification.

Acceptance requires:

- New conversations retain the immediate deterministic title, then receive a Fast-generated title
  within an eight-second naming phase after the first completed answer. Existing and manually
  renamed conversations are never overwritten.
- Reloads, tab changes, and network interruptions reattach to the same generation without
  duplicating it. Stop, logout, deletion, deactivation, timeout, and shutdown still cancel work.
- Employees can explicitly report one answer and its direct prompt. Administrators see only that
  pair, the reporter, reason, and optional note. Deleting the source removes the report.

No queue, worker, WebSocket, chunk table, sticky session, new dependency, or administrator
conversation browser is introduced.

## Contracts and persistence

### Public protocol additions

- Additive NDJSON event `{ "type": "conversation.naming" }`. It may appear once after answer
  deltas and before the terminal event; no content deltas may follow it. Older clients continue
  ignoring it.
- Durable response updates:

  `POST /api/conversations/:conversationId/responses/:generationId/updates`

  Request `{ "cursor": null | "<signed cursor>" }`. POST keeps cursors out of URLs and request
  logs, matching the existing `answer-report-states` and `response-states` shape.

  Response:

  ```json
  {
    "conversationId": "<uuid>",
    "revision": 4,
    "phase": "responding",
    "response": { "...existing ResponseState": "shape" },
    "content": { "mode": "replace", "text": "durable assistant content" },
    "nextCursor": "<signed cursor or null>"
  }
  ```

  `phase` is `responding` or `naming`. A null cursor returns an immediate full `replace`. A
  non-null cursor long-polls and returns an `append`, a phase/lifecycle change, or an empty
  heartbeat response. `nextCursor` is null only when the parent response is terminal.

- Administrator usage purpose becomes `chat | compaction | title`; the possible tier/purpose
  groups grow from six to nine (title rows are always Fast, so at most seven appear in practice);
  `title` displays as `Título`. Existing response completion usage continues to describe the
  visible chat call only.
- Report reason values: `incorrect | outdated | incomplete | instructions_not_followed | unsafe |
  other`.
- Employee report endpoints:
  - `POST /api/conversations/:conversationId/messages/:messageId/report` with body
    `{ reason, note?, sharePromptAndAnswer: true }` → `{ id, messageId, createdAt, repeated }`.
  - `POST /api/conversations/:conversationId/answer-report-states` with body `{ messageIds }`
    (unique, maximum 40) → `{ conversationId, reportedMessageIds }`.
- Administrator report endpoints:
  - `GET /api/admin/answer-reports?cursor` → `{ items, nextCursor }`, maximum 50 newest-first
    items; list item `{ id, reporter: { name, email }, reason, note, createdAt }`.
  - `GET /api/admin/answer-reports/:reportId` → detail adds `exchange: { prompt, answer }`.

  Admin responses expose no conversation, message, or generation identifiers, titles, model
  metadata, surrounding messages, or conversation links.

### Migration `0008`

- `conversations.automatic_title_pending boolean NOT NULL`. Existing rows are backfilled to
  `false`; the final default is `true` for conversations created after migration. Manual rename
  always changes it to `false`, even when the submitted title equals the current title (without
  changing `revision` or `updated_at` in that case).
- Internal generation status `finalizing` and purpose `title`. Title rows have a conversation, no
  assistant message, Fast tier, and prompt version `capstone-title-v1`. A partial unique index
  allows one lifetime title generation per conversation. Lifecycle, accounting, admission,
  cancellation, deletion, and active-workflow constraints are expanded for `finalizing` and
  `title`. An index over finalizing generations by completion time bounds reconciliation. The
  public response-state enum is unchanged: internal `preparing` and `finalizing` both serialize as
  `active`.
- `answer_report_reason` enum and `answer_reports` table with `id`, `workspace_id`, `user_id`,
  `conversation_id`, `generation_id`, `assistant_message_id`, `reason`, nullable `note`,
  `created_at`; owned-conversation and assistant-message foreign keys with cascade deletion; a
  generation foreign key with cascade deletion; unique generation and assistant-message
  constraints; a workspace keyset index on `(workspace_id, created_at DESC, id DESC)`; and a check
  requiring any note to be nonblank and at most 1,000 characters.
- Drizzle schemas, migration snapshot/journal, recovery manifests, and migration-count assertions
  move from eight to nine.

## Ordered implementation

### 1. Record the Phase 10 amendment

Update the PRD index, product/privacy document, architecture document, streaming document,
cost/reliability document, and roadmap as recorded in the amendment table above. Historical
implementation plans remain unchanged.

### 2. Implement automatic-title finalization

- Keep the current atomic first-send fallback title, normalized and limited to 72 Unicode code
  points.
- Only the initial root response of a post-migration conversation is eligible. Every terminal
  outcome consumes that one opportunity; only a nonblank successful `stop | length` answer starts
  naming. Cancelled, incomplete, failed, empty, refused, or filtered first responses permanently
  retain the fallback; edits, retries, continuations, and later turns never retitle.
- On an eligible completed answer, one short transaction with the existing lock order persists the
  final assistant content and authoritative chat accounting, stores the chat terminal reason and
  completion time, moves the parent chat from `active` to `finalizing`, resolves and reserves the
  configured Fast model, and inserts the sole active `title` generation when policy, privacy,
  context, and budget allow. The transaction commits before any title network call.
- The existing stream-registry lease keyed by the parent chat is kept throughout naming. The title
  generation ID remains internal.
- After the handoff commit, `conversation.naming` is emitted. The title request is built from
  UTF-8-safe leading excerpts of the persisted first prompt and answer, capped at 4 KiB each, using
  the Fast mapping with the same hidden-call enabled-tier behavior as compaction, ZDR and
  data-collection denial, hidden reasoning disabled and excluded (`reasoning.enabled=false`; the
  first real OpenRouter trial on 2026-08-15 showed reasoning models spending the whole 32-token cap
  on hidden reasoning and finishing with `length`, so titles never applied), `capstone-title-v1`, a
  maximum of 32 output tokens, and a 512-byte accumulator. Chat and compaction keep provider-default
  reasoning with output excluded.
- Successful output is normalized to NFC, whitespace collapsed to one line; malformed Unicode,
  controls, blank output, and refusal/filter/error/length outcomes are rejected; the result is
  truncated to 72 code points. Any failure retains the deterministic fallback without a chat error.
- An absolute deadline of `parent.completedAt + 8 seconds` covers title admission and persistence
  and is never extended for an authoritative usage lookup.
- Finalization runs under conversation → parent → title-row locks: title accounting settles when
  authoritative usage exists; a conservative reservation is preserved for ordinary expiry
  reconciliation when spend is ambiguous; the title updates only if `automatic_title_pending` is
  still true; the pending flag clears, the title child terminalizes, the parent moves to
  `completed`, and the conversation revision increments exactly once. The ordinary
  `response.completed` carries the parent message, chat reason, chat usage, and final revision;
  canonical refetch updates header, history, and search.
- A manual rename during naming wins permanently. A same-title rename records manual intent
  without a revision bump.
- Stop during naming means "stop naming": cancel the title call, retain the completed answer and
  fallback/manual title, and complete the parent normally, resolved with lock/CAS winner
  semantics.
- The PostgreSQL reconciler finalizes parents still in `finalizing` after the eight-second
  deadline, in every runtime mode, without restarting a model call. Deletion, deactivation,
  logout, timeout, and shutdown handle the parent/title pair together and retain non-content
  accounting.

### 3. Implement durable reattachment

- Downstream socket closure and backpressure leave the provider abort signal (guardrail 4).
- Cancellation is retained for explicit Stop, durable cross-replica cancellation, logout,
  deletion, deactivation, provider limits/errors, the existing five-minute chat timeout, and
  shutdown.
- The updates endpoint reads from PostgreSQL: it authenticates and enforces the same
  conversation/generation ownership as cancellation (mismatches return 404); reads generation
  lifecycle, assistant content, naming phase, and conversation revision in one snapshot; polls
  with fresh queries every 500 ms for at most ten seconds without holding a transaction or
  connection while waiting; installs disconnect listeners before authorization; emits no payload
  after socket loss; and stops polling when the request closes or the API drains.
- The signed cursor codec is reused. The payload encodes kind/version, conversation, parent
  generation, assistant message, UTF-8 byte offset, and phase. Invalid signature, kind, or
  identity, including a message ID that disagrees with the durable snapshot, returns
  `400 INVALID_CURSOR`. An offset ahead of durable content or an impossible phase transition
  returns a safe full replacement with a fresh cursor. Text is sliced only at server-issued UTF-8
  boundaries, and the protocol, server, and client each enforce the exported 1 MiB limit before
  mutation.
- `ChatRuntime` gains `reattaching` and `naming` phases with centralized copy
  `Reconectando respuesta…` and `Nombrando conversación…`. On transport failure after
  `response.started`, it immediately attaches with a null cursor, replaces the volatile overlay
  with the first durable snapshot, then appends later updates in animation-frame batches. Token
  text stays out of TanStack Query caches. Active remote responses are discovered after reload or
  in a new tab through existing response-state loading and attached automatically. Editable and
  autosaved drafts are preserved while generation actions remain fenced; Stop remains available.
- Transport failures, 408, 429, and 5xx retry at 0.5, 1, 2, 4, then 8 seconds with ±20% jitter.
  Before the first request and every continuation, an attempt gate waits for both the backoff
  deadline and online/visible browser state without aborting a request already in flight. Each
  request aborts after 15 seconds and retries have no total cap.
- One invalid cursor resets to null; repeated cursor, schema, Unicode, or protocol failures use
  the existing protocol-failure reconciliation. A 401 clears private state as anonymous; only
  `403 WORKSPACE_ACCESS_DENIED` clears it into the denied gate; other 403s remain local failures.
- If the updates endpoint returns 404, the runtime marks the generation polling-only, refetches the
  exact conversation detail and response state, seeds both caches, and only then removes the
  overlay. Active work continues through the existing two-second state poll; terminal or deleted
  resources converge immediately. Failed canonical recovery retains an interrupted recoverable
  overlay. No replacement generation is ever created automatically.
- Multiple tabs may attach read-only to the same response. Stop from any tab remains global.
- A Better Auth pre-sign-out hook (after its existing origin/rate-limit checks) reads the signed
  session cookie directly. One transaction locks that exact session, then affected workspaces,
  memberships, conversations, and generations in deterministic order; settles the user's work;
  and deletes the session. Only after commit are returned parent workflow IDs aborted locally.
  Cleanup failure returns 503 and preserves the session and cookie so cancellation can be retried.
  Missing cookies or session rows remain idempotent, including expired rows that still identify
  cancellable work.

### 4. Add answer reporting

- Reports are created only for an owned assistant message backed by a chat generation, with a
  direct user parent, terminal response state, and nonblank stored answer. Archived
  conversations, preserved alternatives, partial terminal answers, refusals, filters, and
  reporting while an unrelated response is active are allowed. Preparing/finalizing answers are
  rejected with `409 GENERATION_ACTIVE`; structurally ineligible targets with `400 BAD_REQUEST`;
  ownership/workspace mismatches are hidden as 404.
- Generation/message uniqueness is the idempotency: no `Idempotency-Key`; the first submission is
  immutable; concurrent or later duplicates return the existing report with `repeated: true` and
  never update its reason or note.
- The optional note is normalized to NFC and `\n`, trimmed, rejected for unsupported controls or
  blank supplied notes, and limited to 1,000 Unicode code points.
- Prompt and answer are not copied into the report row. Admin detail joins the immutable assistant
  message and its immediate user parent. Source answer or conversation deletion cascades the report
  and note.
- Employee UI: reported state loads alongside each bounded message page; `Reportar` shows only
  after response/report state is known and terminal; an accessible dialog with required Spanish
  reason radios, an optional note, and the disclosure "Tu mensaje directo y esta respuesta se
  compartirán con los administradores de Capstone. El reporte se eliminará si eliminas la
  conversación." confirms with `Compartir y enviar`; the action becomes disabled `Reportado` after
  success and restores that state after reload; reporting state stays independent of copy, retry,
  branch, draft, and generation controls.
- Administrator UI: lazy `/admin/reports` navigation labeled `Reportes`; a newest-first read-only
  inbox with reporter, reason, timestamp, and note; the prompt/answer pair is fetched only when
  opening an accessible, scrollable detail dialog; a 404 after deletion closes the dialog,
  refreshes the list, and announces that it is no longer available; no reviewed/resolved status,
  filters, counts, edits, deletion controls, exports, notifications, or conversation navigation.
- `Cache-Control: no-store`, session/workspace-scoped query keys, an 8 KiB creation limit, a 4 KiB
  state-request limit, and no dedicated rate limiter.

### 5. Privacy, observability, and rollout

- Telemetry may record route templates, durations, title outcome categories, update return
  categories, and generation accounting metadata.
- Never log or externally emit prompts, answers, partial content, title text, report notes or
  reasons, report or message IDs, cursors, or raw provider/report payloads.
- Deployment: production is one App Platform container serving both API and web assets, so there
  is no staged asset rollout inside one release. The compatibility matrix that matters is a
  cached older SPA against the new API (covered: the parser skips `conversation.naming`, NDJSON and
  response-state shapes are unchanged, older clients cannot see reports) and the new SPA against
  an older API only after a forward `git revert` (covered by the 404 → two-second polling
  fallback).
- Two-release boundary for the `title` usage purpose:
  - **Release A** ships protocol and web acceptance: `AdminUsagePurposeSchema` includes `title`,
    the usage page renders `Título`, and the parser tolerates the additive naming event. The API
    usage query still filters `purpose IN ('chat', 'compaction')`, so no `title` value reaches a
    browser.
  - **Release B** ships the migration, `finalizing`, title generation, reattachment, reporting,
  and the widened usage query. Because the same tree implements both, the release boundary is
  an operator commit/deploy decision recorded here, not a runtime flag: cut release A from the
  protocol/web files listed in the implementation record, then release B from the full tree.
- Pre-launch no-user exception approved on 2026-08-16: while production has no employee or
  administrator clients, the complete tree and migration may ship in one deployment because no
  cached pre-release admin bundle can receive the new closed-enum `title` value. Once any user
  traffic exists, the two-release boundary applies again unless another explicit rollout decision
  replaces it.
- Process death cannot migrate an OpenRouter connection to another replica. Reattachment
  guarantees continuity across browser/network loss while the producing API process survives;
  existing reconciliation converts crashed chat work to retained partial/interrupted state.

## Test plan

- Protocol and migration: closed-schema validation, event ordering, signed cursors, report
  normalization, fresh/upgrade/retry migration tests, legacy-title backfill, constraints, indexes,
  and migration count.
- Automatic titles: successful first response, every fallback path, Fast unavailable/disabled,
  budget rejection, provider timeout, malformed output, manual-rename race, Stop race, deletion,
  shutdown, stale-finalizing reconciliation, search refresh, one-attempt enforcement, and
  actual/estimated accounting.
- Reattachment: disconnect without provider abort, backpressure detach, reload/new tab,
  cross-replica producer/reader, Unicode byte offsets, replace/append/phase changes, multiple
  tabs, offline/visibility retries, endpoint compatibility fallback, global Stop, logout failure
  semantics, and no held database connection.
- Reporting: consent literal, ownership isolation, eligibility, archived/partial answers,
  concurrent duplicates, pagination, source deletion cascades, admin 404 behavior, and privacy
  canaries proving surrounding content and identifiers never escape.
- Web and accessibility: naming/reconnecting copy, draft preservation, focus restoration,
  keyboard navigation, scroll behavior, reduced motion, dialog accessibility, and
  Chrome/Edge/Firefox/Safari plus mobile browser paths.
- Capacity: 40 mixed direct and reattached streams at the 500 ms polling cadence with zero
  malformed responses, pool exhaustion, cross-user leakage, or sustained memory growth; the run
  records pool wait time, not only "no exhaustion".
- Final gates: `pnpm check`, `pnpm verify:repository`, `pnpm verify:operations`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm test:load`, `pnpm build`,
  `pnpm report:bundle`, and `pnpm smoke:container` (recovery manifests and the migration count
  change).

## Assumptions and exclusions

- Automatic titles run only for new conversations' first root response; failures retain the
  deterministic title permanently.
- Report consent grants administrators access only to the reported prompt/answer pair and
  reporter metadata.
- Reports follow existing active-database deletion and encrypted-backup retention rules.
- Reporting is a feedback inbox, not a moderation or ticket-management system.
- No provider-stream recovery after API-process death, full conversation sharing, title
  regeneration/backfill, report resolution workflow, notification system, or new infrastructure is
  included.

## Implementation record

### Delivered boundary (2026-08-15, uncommitted on `8871b9a`)

Protocol (`packages/protocol`):

- `stream.ts`: additive `conversation.naming` event in the closed union.
- `response-updates.ts` (new): updates params/request/phase/content/response schemas.
- `answer-report.ts` (new): reasons, note bounds, employee create/state contracts, administrator
  list/detail contracts (no conversation, message, or generation identity).
- `admin.ts`: usage purpose `chat | compaction | title`. `error.ts`: `SIGN_OUT_CANCELLATION_FAILED`
  (the one code added beyond the plan text; it names the pre-sign-out 503).

API (`apps/api`):

- Migration `0008_resilient_responses_feedback.sql` + snapshot/journal: `answer_report_reason`,
  `answer_reports`, `conversations.automatic_title_pending` (backfilled `false`, default `true`),
  and the internal nullable `conversations.automatic_title_settled_revision` marker that lets a
  manual rename queued behind naming finalization win without weakening unrelated revision CAS,
  `generation_status` recreated with `finalizing` (rename/create/alter/drop pattern from `0004`
  because a partial index and check reference the new value in the same transaction), widened
  chat-workflow unique index, `generations_title_conversation_unique`,
  `generations_finalizing_completed_idx`, and the four expanded generation checks.
- `database/generation-schema.ts`: enum, indexes, checks, and the exhaustive lifecycle predicate
  (`nonterminalGenerationStatuses`, `terminalGenerationStatuses`, `isNonterminalGenerationStatus`,
  `isTerminalGenerationStatus`) that replaced the negative tests in `durable-authority.ts`,
  `response-stream.ts`, `service.ts`, `admission.ts`, `budget-service.ts`,
  `conversations/service.ts`, and `administration.ts`. `database/answer-report-schema.ts` (new).
- `generations/title-candidate.ts` (new) owns the structural oldest-root/oldest-assistant/pending
  test. `generations/title-service.ts` (new) owns `capstone-title-v1`, UTF-8-safe excerpts and
  normalization, the seven-second provider cutoff plus eight-second persistence deadline, explicit
  title budget options, incremental provider metadata/first-token persistence, authoritative late
  accounting, and discriminated `finalized | lost-cas` settlement. Incremental observation writes
  are best-effort without discarding metadata retained by the terminal provider outcome, and stale
  reconciliation isolates each candidate so one failed row cannot block later due work. Finalization
  locks conversation → parent → title, rechecks the provider cutoff after the title lock, bounds
  statements and locks by the absolute persistence deadline, applies at most one title/revision,
  and reconciles stale parents without another model call.
- `generations/lifecycle.ts` (new): `settleNonterminalGeneration`, the phase-aware settlement used
  by Stop, deletion, deactivation, and sign-out (preparing/active → cancelled; finalizing →
  completed; compaction rows mirrored; only preparing chat releases its reservation).
- `generations/service.ts`: `terminalize` separates structural initial candidacy from useful
  `stop | length` naming eligibility, while every terminal initial answer consumes the pending
  flag. The optional naming handoff runs in a nested savepoint, so title-local lock, admission, or
  insert failure cannot roll back an otherwise completed answer; an unusable outer transaction is
  still surfaced. Response admission locks and revalidates the actor's exact session before
  workspace admission. `cancel` is phase-aware; `removeConversation` nulls hidden rows; naming
  settlement and reconciliation are exposed; and `responseStates` reports every nonterminal row as
  plain `active`.
- `generations/response-stream.ts`: `NdjsonWriter` detach semantics (guardrail 4), no downstream
  signal in the provider abort, and a forced durable state read after stream registration and
  before compaction or provider work. Heartbeats cannot restart after writer detachment, and an
  intentional workflow abort cannot turn a lease heartbeat rejection into transport detachment.
  `runNaming` emits `conversation.naming`, races provider and fallback finalization, bounds even pool
  acquisition by the eight-second composer fence, and emits ordinary `response.completed` only
  after committed finalization or a forced read proves the parent terminal. Provider outcomes that
  lose their lifecycle CAS settle authoritative accounting by retained title generation ID,
  including after deletion clears the conversation link. The stream registry retains shutdown
  ownership of that deferred settlement after the HTTP response ends, without extending the
  eight-second response fence. `finalizing` remains "answer durable, reconciler owns completion" on
  failure.
- `generations/response-updates.ts` (new) + route `POST …/responses/:generationId/updates`
  (4 KiB body): pre-authorization abort/close listeners, no disconnected payload, graceful drain,
  500 ms fresh snapshots for ≤10 s, signed identity including the durable message ID, safe UTF-8
  replacement recovery, and server-side enforcement of the exported 1 MiB content limit.
- `generations/administration.ts` batches up to 100 whole conversations, expands all nonterminal
  parent/hidden children, locks deterministic conversation/parent/child order, settles hidden rows
  without their own revision, applies one parent-owned revision, and returns parent chat IDs only.
  The generation lifecycle constraint makes nonterminal conversation-less rows impossible.
  `auth/authentication.ts` reads the signed Better Auth cookie,
  transactionally locks/deletes the exact session with its work, returns 503 on rollback, and aborts
  parents only after commit. `maintenance.ts` runs independent immediate, non-overlapping 500 ms
  naming reconciliation, awaits it on shutdown, and orders naming before reservation expiry.
- `model-policy/budget-service.ts` uses explicit `{ purpose, enforceEmployeeLimit }` reservation
  options and expires active title rows without revising conversations; `usage-service.ts` validates
  and filters `title` in stable `chat → compaction → title` order. Title rejection, real settlement
  duration, and all four report routes plus durable updates use content-free telemetry templates.
- `conversations/service.ts`: rename clears `automatic_title_pending` (same-title stays a
  revision/`updatedAt` no-op); `selectLeaf`, `undo`, and `setArchived` now block on every
  nonterminal workflow status (they previously checked only `active`; `preparing` was reachable
  only during compaction).
- `conversations/answer-reports.ts` (new) + `routes/answer-reports.ts` (new): normalize before one
  transaction, lock the owned conversation `FOR SHARE`, evaluate eligibility, insert with
  conflict-do-nothing, and return the immutable first report for concurrent duplicates. The same
  lock gives deterministic report-vs-deletion ordering; inbox/detail join content and never copy it.
- `model-gateway.ts`/`fake-model-gateway.ts`: `TitleGenerationRequest` and a deterministic local
  title script. `load/load-gateway.ts` and `tests/load-harness.ts`: mixed seeded/true-first-answer
  fixtures, reattachment through real socket abort, strict naming ordering, 50 ms durable-state
  sampling, title/finalizing/reservation peaks, per-stream poll bounds, active update requests, and
  post-idle zero-work/hot-poll gates. `load/harness-safety.ts` accepts the naming event.

Web (`apps/web`):

- `chat-runtime.ts`: `reattaching`/`naming` phases, `attach` (null-cursor first snapshot,
  frame-batched appends, immediate flush on phase change, terminal → reconcile), `attachRemote`,
  retry policy (0.5/1/2/4/8 s ±20 %, online/visible gate before every attempt, no cap, 15 s per
  request), one cursor reset, the 1 MiB accumulator, and protocol-failure escalation. Status-bearing
  HTTP failures preserve retry semantics even when a proxy returns a non-JSON or malformed 5xx
  body. A 404 marks polling-only, refetches and seeds exact conversation/response caches, then
  removes the overlay; failed recovery retains an interrupted recoverable overlay. A failed Stop
  cannot restore `generating` after concurrent durable attachment already ended. The global
  boundary distinguishes anonymous 401 from only `WORKSPACE_ACCESS_DENIED` 403.
  `response-state.ts` pauses polling for an attached entry; `conversation-page.tsx` auto-attaches
  discovered work and preserves drafts.
- `answer-reports.ts` (hook), `answer-report-dialog.tsx` (consent dialog), `message-actions.tsx`
  (`Reportar`/`Reportado`), and `administration/reports-page.tsx`: per-message known report state,
  explicit error/retry, cache seeding after undefined or errored state, focus refetch, one
  close-first dialog flow with focus restoration, stale-detail removal on 404, and contextual
  administrator button labels. The route boundary clears an open report target and aborts an
  in-flight submission before rendering a different conversation; successful submission resets its
  disabled state before close so an immediate reopen is interactive and correctly focused.
  `/admin/reports` remains lazy; `copy.ts` centralizes Spanish copy.

Docs: PRD README/01/02/03/04/06, README, `docs/operations/domain-and-tls.md`, this plan; CI image
check advanced to `0008`.

### Decisions made during implementation

- Every terminal initial answer consumes automatic naming eligibility. Only a successful, useful
  `stop | length` answer with nonblank canonical content starts the title call; all other outcomes
  retain the fallback.
- The two-release boundary is realized as documentation, not a flag: release A is the protocol
  package plus `apps/web` (usage purpose acceptance, naming-event tolerance); release B is the full
  tree. In this repository state the API usage query already returns `title` rows, so a stale admin
  tab against a single-release deploy would fail closed until reload.
- The 2026-08-16 pre-launch deployment has no users or existing admin tabs, so the user explicitly
  approved one full-tree deployment. This exception does not change the compatibility sequence for
  later releases with active clients.
- `cancelEmployeeWork` returns only settled parent chat IDs for local registry aborts; hidden title
  and compaction IDs remain internal.
- The Playwright chat-shell assertion counts `.action-dialog:not(.answer-report-dialog)`; the report
  dialog is a separate message-scoped surface, not a second conversation-action controller.

### Verification evidence (2026-08-15, local, Docker running)

- `pnpm check`: 370 files clean. `pnpm verify:repository`: 483 files. `pnpm verify:operations` and
  `pnpm typecheck`: passed.
- `pnpm test`: protocol 209 (7 files), API 646 (55 files), web 305 (36 files) — 1,160 total, all
  green. Coverage includes session admission/sign-out barriers, conversation-batched cancellation,
  title-local savepoint rollback, stale-candidate isolation, lock/pool deadline fences, and
  shutdown-tracked deletion-orphan accounting; heartbeat lifecycle and durable update
  disconnect/cursor/size handling; report transaction races; HTTP-status-aware canonical web
  recovery; and report/admin focus, cache, request-abort, reopen, and route-boundary behavior.
- `pnpm test:e2e`: 50 passed across Chromium plus the critical Firefox and WebKit projects,
  including durable reattachment, canonical recovery, title/report flows, focus restoration, and
  administration accessibility.
- `pnpm build` passed. `pnpm report:bundle`: 860,041 raw / 324,454 gzip bytes, 16 assets and 4
  initial chunks; administration remains deferred as 9 chunks / 10 modules.
- `pnpm test:load` against the local load server and an isolated PostgreSQL 18 container, 20
  employees / 40 streams, 10 warm-up + 2 measured waves: each wave produced 35 completed, 4
  cancelled, and 1 intentionally failed stream; 19 real-socket reattachments made 418 durable
  polls (22 each, below the 33 bound). Active title/finalizing/reserved-title peaks were 27 in
  wave 1 and 28 in wave 2; active update requests peaked at 19. Both waves returned every active,
  finalizing, reservation, update-request, and stream counter to zero, passed the hot-poll and
  memory gates, and observed API p95 15.60/16.14 ms, cancellation p95 50.39/44.74 ms,
  response-start p95 233.92/182.29 ms, and event-loop p99 12.78/12.63 ms.
- A current `apps/api/Dockerfile` image was rebuilt, then `pnpm smoke:container` passed for
  `capstone-chat:phase10-remediation-review` at
  `8871b9a5094115400dbe0cb3e0854d7a29afd075` against a fresh loopback PostgreSQL 18 database.

### Explicitly unverified locally

- A real paid OpenRouter title call and live provider-latency/accounting behavior; deterministic
  and integration tests cover metadata, accounting, provider cutoff, title-lock crossing, pool
  starvation, and persistence fencing.
- The containerized 1 vCPU/1 GiB load repetition and the App Platform edge behavior for the new
  long-poll route.
- Manual VoiceOver/zoom passes over the report dialog and inbox.
