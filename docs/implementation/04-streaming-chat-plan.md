# Phase 4 — Streaming Chat Implementation Plan

Status: implemented; verification complete; pending user acceptance

Code authorization: granted by the user on 2026-08-07

## Implementation record

- Planning artifact authored on 2026-08-07. The user approved implementation on 2026-08-07.
- Accepted Phase 3 baseline: commit `1f2583f` (`Add Phase 3 conversation core`). The only initial
  working-tree file is this untracked Phase 4 plan; no Phase 4 application, migration, protocol,
  dependency, configuration, test, or runtime code existed at authorization.
- Baseline verification passed all 264 protocol, API, PostgreSQL integration, and web tests, strict
  type checking, production builds, `git diff --check`, the repository-scoped Biome check over all
  130 repository files, and all eight Chromium identity and conversation scenarios. Docker 29.2.0
  was available. The literal `pnpm check` exception remains limited to the globally ignored local
  `.claude/settings.local.json` and that unrelated file remains untouched.
- Phase 4 accepts user messages up to 32,768 UTF-8 bytes and bounds the streaming request body at
  69,632 bytes. The authoritative selected-branch context is bounded at 1,048,576 UTF-8 bytes.
  Browser NDJSON parsing allows a 65,536-byte completed line. Incremental newline processing makes
  that same bound cap retained incomplete input without making arbitrary fetch chunk size part of
  the protocol. One assistant accumulator is limited to 1,048,576 UTF-8 bytes.
- A partial response becomes checkpoint-eligible after 250 ms or 1,024 newly accumulated UTF-8
  bytes. Downstream backpressure waits at most 5 seconds, graceful shutdown drains streams for 10
  seconds, and response state for a generation owned elsewhere is polled every 2 seconds while the
  document is visible.
- The initially approved local fake emitted the clearly simulated sentence `Esta es una respuesta
  simulada de Capstone Chat para desarrollo local.` in three deterministic chunks separated by 120
  ms. The final UX timing audit retained the same content and three-chunk contract but increased the
  local-only delay to 400 ms so incremental output and partial-response Stop are appreciable during
  manual verification. The system prompt version remains `capstone-chat-v1`; the visible Continue
  copy version remains `capstone-continue-v1`.
- Implementation review corrected the internal Stop ordering while preserving the approved visible
  behavior and terminal semantics. The browser enters its non-interactive stopping state
  immediately, waits for the idempotent cancellation request to commit, and only then aborts its
  local stream and reconciles canonical state. This prevents the stream disconnect from winning as
  `incomplete` before explicit employee intent can become `cancelled`; a failed cancellation never
  falsely claims success and leaves the still-owned stream available for honest recovery or retry.
- Same-replica Stop now captures the coordinator's current accumulator and first-token time inside
  the cancellation transition, so text already delivered to the employee cannot disappear before
  the normal checkpoint threshold. Cross-replica Stop deliberately retains the latest durable
  checkpoint because another process cannot safely read the owning coordinator's memory. A
  cancellation fence prevents late deltas, checkpoints, or terminal events from overwriting either
  result.
- Phase 4 implementation completed on 2026-08-07. The protocol now contains the closed v1 event and
  error catalogs; PostgreSQL owns the additive generation lifecycle; Fastify atomically creates,
  streams, checkpoints, cancels, terminalizes, and deletes turns; and the authenticated browser
  runtime renders isolated streams, reconciles canonical state, and preserves draft ownership.
- Ambiguous pre-header outcomes never trigger an automatic generation retry. An explicit Retry
  retains and reuses the original authenticated idempotency key: unchanged reads and transient 5xx
  responses remain fenced, `GENERATION_ALREADY_EXISTS` proves a commit, deterministic 4xx
  rejections release the fence, and draft consumption runs exactly once only after durable proof.
  Session disposal aborts every retained request and prevents late callbacks or query writes from
  crossing into another employee's authenticated scope.
- The final browser runtime keeps the optimistic user/assistant pair in canonical order, rebases
  every loaded history page together after a terminal outcome, and positions a newly sent turn once
  without following later deltas. Pagination and canonical-recovery anchors are route-scoped and
  retryable, authenticated runtimes remain stable across expiry-only session refreshes, and
  recovery is single-flight within each conversation. Continuous smart autoscroll remains Phase 5.
- The terminal presentation now distinguishes expected canonical reconciliation from failed
  recovery. While the normal reconciliation is pending, the composer remains fenced with one
  compact polite status and no transient danger banner; only an actual failed reconciliation shows
  the alert and explicit Retry action. Failed recovery cannot start an automatic retry loop or
  publish after authenticated runtime disposal.
- Final verification passed 395 protocol, API/PostgreSQL, and web tests: 131 protocol, 151 API, and
  113 web. Coverage includes clean-schema migration and exact accepted-Phase-3 upgrade paths,
  transactional and cross-replica races, same-replica sub-threshold Stop persistence, every approved
  terminal outcome, real HTTP backpressure and forced shutdown, privacy/logging, ambiguous recovery,
  failed-Stop/terminal reconciliation, quiet terminal reconciliation, actionable recovery failure,
  route isolation, and authentication-generation fencing.
- Strict TypeScript, production builds, `git diff --check`, and the repository-scoped Biome check
  over all 159 applicable files passed. The build retained only the existing Vite chunk-size
  advisory. The literal `pnpm check` checked 160 files and reported only the pre-existing globally
  ignored local `.claude/settings.local.json`; that unrelated file remains untouched and is absent
  from CI.
- Playwright passed all 22 scenarios: the complete 14-scenario Chromium flow and four critical
  streaming scenarios in each of Firefox and WebKit. The production API image built as the non-root
  `node` user (UID 1000) and contained the complete three-migration history.
- Independent post-fix backend, browser, and cross-boundary read-only audits found no remaining
  P1/P2 defect or unnecessary abstraction across lifecycle recovery, ownership and authorization,
  privacy and logging, migration boundaries, production fake-gateway rejection, or later-phase
  scope. Phase 4 added no dependency, provider integration, Phase 5 continuous-follow behavior,
  Phase 6 accounting, or alternate infrastructure.
- A 2026-08-07 cross-phase correction pass fenced an already-enqueued terminal NDJSON event from
  catch-path replay under backpressure, separated scheduled and durable checkpoint watermarks so a
  failed write remains eligible, and made shutdown interruption wait for durable state rather than
  assuming an in-flight cancellation transaction committed. The browser parser now bounds each
  retained incomplete line while accepting arbitrarily coalesced transport chunks.
- Failed remote Stop requests keep their honest remote-generating state until polling observes a
  terminal result. That observation triggers one canonical reconciliation; a failed reconciliation
  exposes explicit Retry without an automatic loop. Draft validation and late ambiguous-send proof
  use the Phase 3 rules recorded above.
- The same audit narrowed migration configuration to `NODE_ENV` plus `DATABASE_URL`, gave migrations
  a single-connection pool without the request query timeout, and exposed only allowlisted
  configuration or PostgreSQL metadata in process-level operator logs. PostgreSQL Compose exposure
  is loopback-only, local environment variants are ignored, and inert or duplicate tool settings
  were removed without adding a dependency or changing a public contract.
- The search-vector/output-size alignment and gateway CR/split-surrogate normalization remain
  mandatory Phase 6 work before real model output. An overall process-shutdown deadline remains
  Phase 8 deployment hardening. The Phase 2 password-change rate was not changed without a separate
  locked security decision, and the currently aligned search snippet invariant was not replaced by
  speculative fallback behavior.
- Post-correction verification passed all 414 tests: 131 protocol, 161 API and PostgreSQL
  integration, and 122 web. Strict TypeScript, production builds, `git diff --check`, and the
  repository-scoped Biome check over 163 applicable files passed; the build retained only the
  existing Vite chunk-size advisory. The literal `pnpm check` checked 164 files and still reports
  only the globally ignored, unrelated `.claude/settings.local.json` formatting issue.
- Playwright passed all 22 scenarios across the complete Chromium flow and the critical Firefox and
  WebKit streaming flows. The production API image built successfully, runs as non-root `node`,
  and contains the compiled runtime and complete three-migration history. Three independent
  read-only correction audits found no remaining P1/P2 correctness issue or undue abstraction.

## Objective

Add the smallest complete real-time chat boundary on top of the accepted conversation core. An
authenticated employee can send the persisted new-chat or conversation draft, see the user message
and one assistant placeholder committed atomically, receive a deterministic response incrementally
from `FakeModelGateway`, stop it, retain useful partial output, recover canonical state after an
interruption, and understand every terminal outcome.

Phase 4 proves the final browser-to-Fastify streaming architecture without calling OpenRouter or
pretending that fake output is production AI. PostgreSQL remains authoritative, Fastify owns turn
creation and lifecycle state, and the web application only starts, reads, renders, and cancels the
stream.

Approving this plan approves the Phase 4 protocol and implementation choices below, including the
complete v1 NDJSON event and stable error-code catalogs. It does not authorize code. Coding begins
only after Phase 3 is accepted as an exact baseline and the user grants Phase 4 code authorization
explicitly.

## Plan approval decisions

Approval of this plan locks the following Phase 4 interpretations. They close implementation gaps
without moving later roadmap work forward.

1. Phase 4 sends only the `balanced` tier. The request retains a `modelTier` field whose only
   accepted Phase 4 value is `balanced`, so the final request shape is established without a fake
   tier policy. The `fast | balanced | pro` union, preferred-tier persistence, tier picker, workspace
   defaults, availability policy, and model mappings arrive together in Phase 6.
2. The first send uses the existing `POST /api/conversations` route to create the conversation and
   atomically move the confirmed new-chat draft into that conversation. The ordinary response route
   then consumes the conversation draft in its turn-creation transaction. A failure between those
   two requests leaves one visible empty conversation with the employee's intact draft, not an
   orphaned message or lost text.
3. A typed send is allowed only from an active conversation. Archived conversations may retain and
   autosave drafts, but the employee must unarchive before generating. Fastify enforces this with
   `CONVERSATION_ARCHIVED`.
4. The Stop action immediately enters a non-interactive stopping state, sends one idempotent
   authenticated cancellation request, and aborts the local streaming fetch only after that request
   commits. The explicit request records employee intent as `cancelled`; an unexplained transport
   loss is recorded as `incomplete` and presented as interrupted. This ordering resolves the fact
   that an HTTP disconnect alone cannot tell the server whether the employee clicked Stop and keeps
   the two outcomes race-safe. The owning replica persists its current streamed accumulator during
   cancellation; a different replica preserves the latest durable checkpoint.
5. Continue is Phase 4 lifecycle recovery, not a Phase 5 branch control. It is offered only after a
   `length` outcome, preserves any employee draft already in the composer, and creates this ordinary
   visible user message from backend-owned copy:

   > Continúa desde donde te detuviste, manteniendo el idioma y el formato de la respuesta anterior.

6. Assistant content remains safe plain text with preserved line breaks in Phase 4. The browser may
   accumulate Markdown source, but Markdown, mathematics, syntax highlighting, copying, and the
   response-format gallery remain Phase 5 work.
7. Phase 4 introduces the durable lifecycle portion of the `generations` table plus the fixed
   `balanced` request tier, system-prompt version, and empty effective fake-parameter configuration
   required to make a generation reproducible. Token usage, model/provider identifiers, prices,
   costs, reservations, accounting retention details, and reconciliation are added in Phase 6.
   Fake usage appears in the final stream event only to prove the approved event contract; it is not
   presented as billing data.
8. The complete v1 event catalog includes the Phase 7 compaction lifecycle events because the
   roadmap requires the entire NDJSON contract to be approved and encoded now. Phase 4 does not emit
   them or implement any compaction behavior.
9. The browser never automatically retries an ambiguous generation request. The idempotency key
   prevents duplicate persistence, while explicit employee action and canonical refetch provide
   recovery.
10. Phase 4 adds a narrow response-state read contract rather than changing the Phase 3 conversation
    response in place. This keeps the API compatible with the immediately preceding web build and
    lets the new web build degrade safely while an older API is still serving during a rollout.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its decision policy.
3. `docs/prd/01-product-scope-and-experience.md`, especially Product language, Browser support,
   Conversations and history, Composer behavior, Generation experience, Streaming scroll behavior,
   Connection loss, Response presentation, and Model selection.
4. `docs/prd/02-system-architecture-and-data.md`, especially Architecture, Deployment shape,
   Configuration, API contracts, Browser and backend responsibilities, Frontend state ownership,
   Content privacy, Browser security, Database access, Core conversation storage, Optimistic
   revisions, Draft storage, Verification, and Observability.
5. `docs/prd/03-conversation-model-and-streaming.md` in full, with particular attention to
   authoritative turn creation, user-message validation, the gateway boundary, system prompts,
   streaming protocol, stream lifecycle, persistence and backpressure, terminal outcomes,
   concurrency, and compaction as a later boundary.
6. `docs/prd/04-cost-control-and-reliability.md` for cancellation propagation, fallback and retry,
   timeout categories, durable completion, and the exact accounting work that remains Phase 6.
7. `docs/prd/05-brand-system.md` for calm presentation, semantic tokens, focus, reduced motion,
   keyboard access, and concise lifecycle announcements that never announce individual tokens.
8. `docs/prd/06-development-roadmap.md`, especially the Phase 4 checkpoint and Phase 5–8 order.
9. `docs/implementation/01-foundation-plan.md`, `docs/implementation/02-identity-plan.md`,
   `docs/implementation/03-conversation-core-plan.md`, and the accepted implementation records.
10. The current migration, schema, conversation service, actor resolution, error envelope,
    exact-Origin enforcement, application lifecycle, route registration, query scoping, draft
    memory, request-lifetime, React Router, TanStack Query, copy, styling, test harness, CI, and
    container patterns.
11. Current `git status`, the exact accepted Phase 3 commit, and its final verification record.

Phase 4 begins from a frozen, accepted Phase 3 commit. The current Phase 3 work must not remain an
unidentified dirty baseline when streaming implementation begins.

At implementation start, record the initial operational values Phase 4 first needs:

- user-message and streaming-request byte ceilings;
- maximum NDJSON line size, which also bounds retained incomplete decoder input;
- maximum in-memory assistant accumulator size;
- checkpoint elapsed-time and accumulated-byte thresholds;
- downstream backpressure timeout;
- graceful stream-drain timeout;
- response-state polling interval used only for an active stream owned by another tab or process;
- deterministic local fake response chunks and delay; and
- the version identifiers for the system prompt and Continue copy.

These are bounded operational values, not new employee-facing capabilities. Keep them named,
centralized, and tested. Initial values may be conservative for the fake-gateway checkpoint and are
revisited through Phase 6 model policy and Phase 8 load testing. Stop for approval if a value would
materially change retention, privacy, security, cost, or the locked experience.

Phase 4 does not need an OpenRouter model, model price, ZDR endpoint, tier mapping, workspace budget,
reservation amount, compaction threshold, production deployment venue, observability destination,
or final load-tested numeric limit.

## Dependency direction

```text
apps/web ──JSON + NDJSON/fetch──> apps/api ──Drizzle/node-postgres──> PostgreSQL
   │                                  │
   ├─────────────────────────────────> packages/protocol
   └─────────────────────────────────> packages/brand

apps/api ────────────────────────────> packages/protocol
                │
                `──> ModelGateway ──> FakeModelGateway
```

- React owns presentation and browser interaction. It never constructs authoritative history,
  chooses a raw model, finalizes generation state, or treats in-memory deltas as durable content.
- Fastify resolves the actor, validates the selected branch and draft, constructs context from
  PostgreSQL, commits the turn, drives the gateway, normalizes lifecycle events, checkpoints
  content, and owns every terminal transition.
- PostgreSQL is authoritative for conversation revision, branch selection, consumed drafts,
  message content checkpoints, generation status, terminal reason, and idempotency.
- `packages/protocol` contains only public request, response, response-state, stable-error, and
  NDJSON schemas with inferred types. It contains no gateway types, parser implementation, React
  state, Drizzle schema, or persistence logic.
- The backend continues the direct `route -> service -> explicit queries` pattern. Streaming
  coordination is a narrow feature module, not a command bus, repository layer, generic workflow
  engine, or job system.
- The internal gateway boundary contains only the model-neutral request and events the backend
  needs. OpenRouter types do not exist in Phase 4.
- A small process-local registry may hold AbortControllers for requests executing in that replica.
  It is an acceleration path only; PostgreSQL lifecycle state remains authoritative and no sticky
  session is required.
- Phase 4 should require no web rendering or state-management dependency. Use browser streams,
  `TextDecoder`, `requestAnimationFrame`, `AbortController`, React, and TanStack Query already in the
  repository.

## Phase 4 checkpoint

The runnable checkpoint behaves as follows:

```text
confirmed server draft
        |
        | Send
        v
short PostgreSQL turn transaction
  - validate owner, archive state, revision, parent, draft, and active generation
  - create user message
  - create empty assistant placeholder
  - create active generation and bind idempotency key
  - select assistant placeholder
  - set initial title if still null
  - consume matching draft
  - increment structural revision
        |
        | commit before gateway wait
        v
response.started -> content.delta* -> one terminal response event
        |                 |
        |                 `-> coalesced conditional checkpoints
        v
short terminal transaction -> terminal event only after commit
```

The employee sees a clearly simulated response in local development. The checkpoint must not imply
that a production model, live tier differentiation, current information, cost enforcement, or
company-system access exists.

## Public HTTP contract

Phase 4 extends the authenticated Capstone API with the following contracts. Every state-changing
request remains JSON-only and exact-Origin protected. Every ordinary request and response schema,
including headers where Fastify can validate them, lives in `packages/protocol`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/conversations` | Existing creation route; optionally adopt the confirmed new-chat draft |
| `POST` | `/api/conversations/:conversationId/responses` | Atomically create a turn and stream one response as NDJSON |
| `POST` | `/api/conversations/:conversationId/responses/:generationId/cancel` | Idempotently record employee cancellation for an owned generation |
| `POST` | `/api/conversations/:conversationId/response-states` | Read lifecycle state for a bounded set of assistant message IDs |
| `DELETE` | `/api/conversations/:conversationId` | Existing deletion route; now cancels an active generation before deleting content |

### First-send draft adoption

The existing empty request remains valid. Phase 4 adds one optional field:

```json
{
  "adoptNewDraftRevision": 4
}
```

When the field is present, the creation transaction:

1. locks the actor's new-chat draft;
2. verifies that its revision matches and its normalized content is non-empty;
3. creates the empty owned conversation; and
4. changes that draft's scope to the new conversation without changing its content or revision.

If the draft is absent, stale, empty, or concurrently moved, no conversation is created and the
ordinary error is `DRAFT_CHANGED` or `BAD_REQUEST` as appropriate. The server returns the existing
conversation summary response. The browser moves its in-memory record and query entry to the new
scope, navigates to the new conversation, and then begins the streaming request.

### Response request

Every streaming request includes:

```http
POST /api/conversations/:conversationId/responses
Content-Type: application/json
Accept: application/x-ndjson
Idempotency-Key: <crypto.randomUUID()>
```

A typed draft send uses:

```json
{
  "source": "draft",
  "parentMessageId": "msg_123",
  "content": [
    { "type": "text", "text": "My next question" }
  ],
  "modelTier": "balanced",
  "observedRevision": 7,
  "draftRevision": 3
}
```

`parentMessageId` is `null` only for the root user message in an empty conversation. Otherwise it
must equal the conversation's currently selected leaf. Fastify never accepts browser-supplied prior
history.

A Continue request uses:

```json
{
  "source": "continue",
  "parentMessageId": "msg_length_limited_assistant",
  "modelTier": "balanced",
  "observedRevision": 9
}
```

Fastify verifies that the parent is the selected assistant response with terminal reason `length`,
constructs the approved visible Continue message, and leaves the current conversation draft
untouched.

Contract rules:

- `modelTier` is the literal `balanced` in Phase 4. Fast or Pro requests fail schema validation and
  cannot be reached through the UI.
- A draft send requires one valid Unicode text block, line endings normalized to `\n`, no null byte
  or unsupported control character, non-whitespace content, and the selected message-size bound.
- The server draft must contain the same normalized content and revision. A mismatch returns
  `DRAFT_CHANGED`; no message, generation, title, selection, or revision changes.
- The conversation must be owned, active rather than archived, at the observed structural revision,
  and free of another active generation.
- Preflight size and context checks happen before persistence. `MESSAGE_TOO_LARGE` never consumes
  the draft.
- The `Idempotency-Key` is a canonical lowercase UUID generated with `crypto.randomUUID()`. Missing
  and malformed keys use distinct stable errors.
- One key is unique per workspace and employee for retained generation history. A replay returns
  `GENERATION_ALREADY_EXISTS` and never attaches to, resumes, or duplicates the original stream.
- The browser does not retry the request automatically after a network ambiguity, even with the
  same key. It refetches canonical conversation and response state.
- Before the turn transaction commits, failures use an ordinary JSON error envelope and an
  appropriate non-2xx status. No NDJSON body is started.
- After the transaction commits, the response is `200 application/x-ndjson`; every later known
  lifecycle outcome is represented through the event contract unless the transport itself is gone.
- The response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, the existing
  request ID header, and no content compression or buffering controlled by the application.
- No prompt, message, delta, draft, Continue content, or raw gateway event appears in request logs,
  error logs, header logs, or error metadata.

### Cancellation request

The cancellation route accepts an empty JSON object. It is scoped by the authenticated workspace,
employee, conversation, and generation identifiers.

- Cancelling an owned active generation records the explicit employee intent, conditionally marks
  it cancelled, preserves its latest durable partial content, and increments the conversation
  revision once.
- Repeating cancellation for the same owned generation is a successful no-op.
- A completion race is also a successful no-op; Stop must not turn an already durable completion
  into an error.
- Missing, deleted, cross-workspace, and other-employee identifiers use the same scoped `NOT_FOUND`.
- The API signals an in-process AbortController when the stream runs in the same replica. A stream
  in another replica observes the durable terminal state before forwarding its next gateway event,
  checkpointing, or committing completion, and aborts its gateway signal.
- The originating browser publishes its stopping state immediately, waits for a successful
  cancellation response, then aborts its streaming fetch and reconciles through Fastify. It does
  not depend on receiving a terminal NDJSON event. If cancellation fails, it does not abort or claim
  cancellation while the stream remains locally owned; it restores an honest recoverable state and
  permits explicit retry.

### Response-state request

The response-state route is a read expressed as bounded JSON so the web does not create one request
per message or an unbounded identifier query string:

```json
{
  "messageIds": ["msg_assistant_1", "msg_assistant_2"]
}
```

It accepts at most one existing message-page size, returns only owned assistant messages from that
conversation, and never reveals that another identifier exists. The response contains:

```json
{
  "conversationId": "conversation_123",
  "revision": 9,
  "responses": [
    {
      "generationId": "generation_123",
      "messageId": "msg_assistant_2",
      "status": "completed",
      "reason": "length",
      "errorCode": null
    }
  ]
}
```

Assistant fixtures created before Phase 4 may have no generation record and are simply omitted.
The new web treats a 404 from this new route as an older-API rollout fallback, renders the existing
plain-text messages without lifecycle badges, and retries after normal query invalidation. It does
not hide other protocol or authorization failures.

## Complete v1 NDJSON event catalog

The following eight event types are the entire approved v1 stream catalog. Phase 4 encodes all of
them as closed TypeBox schemas and a discriminated known-event union. Adding another known event or
changing a field meaning requires an explicit contract amendment.

| Event | Fields | Meaning | First emitted |
| --- | --- | --- | --- |
| `response.started` | `conversationId`, `generationId`, `userMessageId`, `messageId`, `revision` | The turn transaction is durable and the assistant placeholder is selected | Phase 4 |
| `context.compacting` | no additional fields | Older context is being compacted before generation | Phase 7 |
| `context.compacted` | no additional fields | Compaction completed and ordinary generation is proceeding | Phase 7 |
| `context.warning` | `code: CONTEXT_COMPACTION_FALLBACK` | Compaction failed safely and approved oldest-turn fallback is being used | Phase 7 |
| `content.delta` | `text` | One non-empty ordered text delta for the active assistant response | Phase 4 |
| `response.completed` | `messageId`, `revision`, `reason`, `usage` | A successful terminal response is durable | Phase 4 |
| `response.cancelled` | `messageId`, `revision`, optional `usage` | Explicit employee cancellation is durable | Phase 4 |
| `response.failed` | `messageId`, `revision`, `errorCode`, `partial`, optional `usage` | A normalized failed or incomplete outcome is durable | Phase 4 |

The exact terminal shapes are:

```json
{
  "type": "response.completed",
  "messageId": "msg_123",
  "revision": 8,
  "reason": "stop",
  "usage": { "inputTokens": 200, "outputTokens": 80 }
}
```

```json
{
  "type": "response.cancelled",
  "messageId": "msg_123",
  "revision": 8,
  "usage": { "inputTokens": 200, "outputTokens": 31 }
}
```

```json
{
  "type": "response.failed",
  "messageId": "msg_123",
  "revision": 8,
  "errorCode": "GENERATION_FAILED",
  "partial": true
}
```

Event rules:

- `response.started` is the first known event and appears exactly once.
- Zero or one `context.compacting` may follow it. If emitted, it is followed by exactly one
  `context.compacted` or `context.warning` before the ordinary response continues.
- `content.delta` contains non-empty valid Unicode text. Event order defines text order; v1 has no
  sequence numbers because it does not resume streams.
- Exactly one of `response.completed`, `response.cancelled`, or `response.failed` terminates a
  connected stream. Nothing follows a terminal event.
- `response.completed.reason` is exactly `stop`, `length`, `refusal`, or `content_filter`.
  Cancellation and error have their own terminal events.
- `usage` contains non-negative integer `inputTokens` and `outputTokens`. It is required for a
  completed fake response and optional when cancellation or failure prevents final usage. Phase 6
  supplies authoritative OpenRouter usage and persists accounting.
- `response.failed.errorCode` is one of `EMPTY_RESPONSE`, `GENERATION_FAILED`,
  `GENERATION_TIMEOUT`, or `MODEL_UNAVAILABLE`. `partial` maps the durable generation to
  `incomplete` when true and `failed` when false.
- Every terminal event is written only after its corresponding short PostgreSQL transaction commits.
- A final-persistence failure never emits `response.completed`. The server ends the protocol if it
  cannot durably record a normalized failure, and the browser treats the stream as interrupted and
  refetches canonical state.
- A client-aborted connection normally receives no terminal event. The cancellation endpoint and
  canonical response state are authoritative.
- Each complete non-empty line is one UTF-8 JSON object. The server ends every emitted object with
  `\n` and does not emit comments, SSE fields, array wrappers, or keepalive text.
- Blank lines are ignored. Invalid UTF-8, invalid JSON on a completed line, a non-object value, a
  missing or non-string `type`, an oversized line, or a malformed known event is
  `STREAM_PROTOCOL_ERROR`.
- A non-empty unterminated fragment at connection loss is interruption, not proof of a malformed
  server event. The browser discards it, records `STREAM_INTERRUPTED`, and refetches.
- An object with a well-formed but unknown string `type` is ignored for forward compatibility.
  Unknown events do not satisfy ordering or terminal requirements.
- End-of-stream before a known terminal event is `STREAM_INTERRUPTED`, even if all received known
  events were valid.
- Browser parsing is incremental across arbitrary network chunk boundaries and preserves split
  multi-byte Unicode code points.

## Complete v1 stable error-code catalog

`API_ERROR_CODES` remains the single code registry. Phase 4 makes the ordinary error envelope's
`code` field the TypeBox union inferred from this complete catalog. Existing meanings remain
unchanged. The web selects centralized Spanish copy by code and does not display arbitrary backend
or provider wording.

| Code | Delivery | Stable meaning | Implemented by |
| --- | --- | --- | --- |
| `ADMIN_ACCESS_REQUIRED` | HTTP | The authenticated member lacks administrator authorization | Phase 7 |
| `AUTHENTICATION_REQUIRED` | HTTP | A valid authenticated session is required | Existing |
| `BAD_REQUEST` | HTTP | The request is structurally valid JSON but violates a general input rule without a more specific code | Existing |
| `CONTEXT_COMPACTION_FALLBACK` | stream warning | Compaction failed and approved oldest-complete-turn fallback is in use | Phase 7 |
| `CONVERSATION_ARCHIVED` | HTTP | Generation is blocked until the owned conversation is unarchived | Phase 4 |
| `CONVERSATION_CHANGED` | HTTP | A structural mutation used a stale conversation revision | Existing |
| `DEVELOPMENT_MAILBOX_DENIED` | HTTP | The local mailbox route is unavailable from this request boundary | Existing |
| `DRAFT_CHANGED` | HTTP | The server draft no longer matches the observed revision or content | Existing |
| `EMPTY_RESPONSE` | stream failure | The gateway reported success without useful assistant content | Phase 4 |
| `EMPLOYEE_GENERATION_LIMIT_REACHED` | HTTP | The employee's cross-conversation generation limit is currently reached | Phase 6 |
| `GENERATION_ACTIVE` | HTTP | This conversation already has an active generation | Phase 4 |
| `GENERATION_ALREADY_EXISTS` | HTTP | The scoped idempotency key already owns a generation and cannot be replayed | Phase 4 |
| `GENERATION_FAILED` | stream failure | Generation failed after turn creation without a safer specific employee-facing reason | Phase 4 |
| `GENERATION_TIMEOUT` | stream failure | A configured generation timeout ended the request | Phase 4 contract; Phase 6 provider enforcement |
| `IDEMPOTENCY_KEY_INVALID` | HTTP | The Idempotency-Key is present but not a canonical UUID | Phase 4 |
| `IDEMPOTENCY_KEY_REQUIRED` | HTTP | A generation request omitted the required Idempotency-Key | Phase 4 |
| `INTERNAL_ERROR` | HTTP | An unexpected server failure occurred before streaming or in an ordinary route | Existing |
| `INVALID_CURSOR` | HTTP | An opaque cursor is malformed, mismatched, or unusable | Existing |
| `INVALID_EMAIL_OR_PASSWORD` | HTTP | Sign-in failed without disclosing account state | Existing |
| `JSON_REQUIRED` | HTTP | A protected mutation did not use the required JSON content type | Existing |
| `MEMBERSHIP_ACTIVATION_FAILED` | HTTP | Verification could not activate the approved workspace membership | Existing |
| `MESSAGE_TOO_LARGE` | HTTP | The proposed message cannot fit the enforced message or context boundary and its draft remains | Phase 4 |
| `MODEL_UNAVAILABLE` | HTTP or stream failure | No approved model route can serve the selected tier without weakening policy | Phase 6; schema used in Phase 4 |
| `MODEL_VALIDATION_FAILED` | HTTP | An administrator-supplied OpenRouter model could not be validated for catalog use | Phase 6/7 |
| `NAME_REQUIRED` | HTTP | Identity input omitted the required employee name | Existing |
| `NOT_FOUND` | HTTP | A scoped resource is absent or unavailable to this actor | Existing |
| `ORIGIN_NOT_ALLOWED` | HTTP | The browser request did not match the trusted public origin | Existing |
| `PASSWORD_TOO_LONG` | HTTP | A password exceeds the approved maximum | Existing |
| `PASSWORD_TOO_SHORT` | HTTP | A password is below the approved minimum | Existing |
| `PAYLOAD_TOO_LARGE` | HTTP | The HTTP or non-message payload exceeds its endpoint limit | Existing |
| `SESSION_REFRESH_REQUIRED` | HTTP | A sensitive operation requires a fresher session | Existing |
| `STREAM_INTERRUPTED` | browser recovery and stored generation metadata | The byte stream ended without a durable known terminal outcome | Phase 4 |
| `STREAM_PROTOCOL_ERROR` | browser recovery | A known NDJSON contract or framing rule was violated | Phase 4 |
| `TIER_UNAVAILABLE` | HTTP | The selected employee-facing tier is disabled or lacks an approved mapping | Phase 6 |
| `WORKSPACE_ACCESS_DENIED` | HTTP | The identity lacks active membership in the workspace | Existing |
| `WORKSPACE_BUDGET_EXCEEDED` | HTTP | A safe reservation cannot fit under the hard workspace monthly ceiling | Phase 6 |

Catalog rules:

- Stable codes describe recoverable product states, not every internal exception class.
- HTTP status remains semantically appropriate but is not the employee-facing decision boundary;
  the code is. The web never branches on backend prose.
- `MESSAGE_TOO_LARGE` is distinct from `PAYLOAD_TOO_LARGE`: the former preserves a valid draft that
  cannot fit message or context policy, while the latter rejects an oversized transport payload.
- `GENERATION_ACTIVE` is distinct from `GENERATION_ALREADY_EXISTS`: the former protects one active
  response per conversation, while the latter protects one durable result per idempotency key.
- Provider names, provider status codes, raw response bodies, endpoint metadata, and correlation
  detail never become stable employee codes or stream fields.
- Refusal, content filtering, output length, and cancellation are normalized terminal reasons, not
  error codes.
- A later milestone may implement a code already cataloged here. It may not silently add another
  employee-visible code or repurpose one without amending this artifact.

## Generation lifecycle and persistence

Phase 4 adds a generation lifecycle that is deliberately smaller than Phase 6 accounting:

```text
active
  |-- ordinary completion ----------------------> completed
  |-- explicit employee Stop -------------------> cancelled
  |-- transport/provider failure after content -> incomplete
  `-- failure before useful content ------------> failed
```

Terminal reason mapping is fixed:

| Durable status | Terminal reason | Conditions |
| --- | --- | --- |
| `completed` | `stop` | Ordinary non-empty completion |
| `completed` | `length` | Output allowance reached; Continue is available |
| `completed` | `refusal` | Model refusal is preserved |
| `completed` | `content_filter` | Filtered response is preserved |
| `cancelled` | `cancelled` | Explicit employee cancellation or conversation deletion cancellation |
| `incomplete` | `error` | Useful partial content remains after interruption or failure |
| `failed` | `error` | No useful assistant content was produced |

### Migration

Add one reviewed Phase 4 migration that upgrades the exact accepted Phase 3 schema and applies to an
empty database. It introduces:

- PostgreSQL enums for generation lifecycle status and terminal reason;
- a `generations` table containing only identifier, workspace, employee, nullable conversation,
  nullable assistant message, idempotency key, fixed requested tier, system-prompt version, effective
  non-secret parameter JSON, lifecycle status, terminal reason, safe error code,
  start/first-token/completion timestamps, and ordinary timestamps needed for deterministic tests;
- a scoped unique key on `(workspace_id, user_id, idempotency_key)`;
- a unique non-null assistant-message association;
- a partial unique index allowing at most one `active` generation per non-null conversation;
- foreign keys that preserve the generation row while setting content references to null when a
  conversation is permanently deleted; and
- check constraints tying active versus terminal status, reason, error code, and timestamps into
  valid combinations.

The Phase 4 tier value is always `balanced`, the system-prompt version is always the approved
`capstone-chat-v1`, and the effective parameter object is empty because the fake accepts no sampling
or reasoning controls. Do not add requested model, resolved model, provider, OpenRouter generation
ID, prompt tokens, completion tokens, reasoning tokens, cached tokens, cost, reservation, purpose,
compaction, or reconciliation fields. Phase 6 widens tier policy, supplies real effective parameters,
expands the compatible table, and backfills Phase 4 rows as fake, non-billable chat generations
where required.

Assistant placeholders keep the existing one-text-block message representation with an initially
empty string. Updating that one active assistant message through checkpoints and terminalization is
the sole Phase 4 content-mutation exception: completed messages and tree topology remain immutable.
The generation table, rather than duplicated columns on `messages`, owns lifecycle state.

Pre-Phase 4 assistant fixtures legitimately have no generation row. Migration does not synthesize
fake lifecycle or usage records for them.

### Turn transaction

One short transaction performs a typed draft send:

1. Lock the owned conversation.
2. Reject an archived conversation, stale revision, invalid selected parent, invalid role
   alternation, or existing active generation.
3. Lock and compare the conversation draft by scope, exact revision, and normalized content.
4. Reconstruct and bound the authoritative selected branch needed by `FakeModelGateway`.
5. Insert the user message and empty assistant child.
6. Insert the active generation with the scoped idempotency key.
7. Set the assistant as selected leaf, increment the conversation revision, update recent ordering,
   and set the deterministic initial title only if it is still null.
8. Delete the matching draft row so the next draft reads canonically as empty revision `0`.
9. Return the committed IDs, revision, and in-memory model-neutral context to the stream coordinator.

The Continue transaction follows the same shape but validates a selected length-limited assistant,
inserts the approved backend-owned visible user message, leaves the draft row untouched, and then
creates its assistant child and generation.

No database connection or transaction remains open while the fake gateway waits or the browser
reads the stream.

### Checkpoints and terminal races

- Each stream owns one bounded text accumulator and byte count.
- Gateway deltas append in order, are forwarded immediately, and become eligible for a checkpoint
  after either selected threshold is reached.
- At most one checkpoint write may be in flight. Deltas arriving during it coalesce into the next
  eligible checkpoint.
- A checkpoint updates only the associated assistant content and first-token time while the
  generation is still `active`. It never changes conversation revision or recent ordering.
- The coordinator does not await a checkpoint before forwarding each delta, but it never allows
  unbounded pending database writes or buffers.
- Completion, cancellation, failure, disconnect, deletion, and shutdown compete through one
  conditional terminalization boundary. Exactly one transition wins.
- Same-replica cancellation atomically captures the coordinator's current accumulator and
  first-token time before it wins that boundary. Cross-replica cancellation retains the latest
  durable checkpoint and never guesses at another process's memory.
- The terminal transaction locks the generation and owned conversation, persists the final useful
  content, sets status/reason/error/timestamps, and increments the current conversation revision
  once without assuming no rename or archive happened during streaming.
- A late checkpoint is conditional on `active` and cannot overwrite terminal content.
- A late gateway completion after cancellation or deletion cannot resurrect the message, change the
  terminal reason, or emit a completion event.
- Permanent deletion first conditionally cancels an active generation, then removes content in the
  same user operation. The retained generation loses its content references and cannot be used to
  infer accessible deleted content.
- Phase 4 has no periodic crash reconciler. If a process dies with an active row, the response-state
  route exposes it and the employee can use the idempotent Stop action. Automatic abandoned-record
  reconciliation and reservation settlement arrive together in Phase 6.

## Model-neutral gateway and context

Define one small backend-only interface:

```ts
interface ModelGateway {
  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent>;
}
```

The internal types contain only:

- the versioned system prompt;
- ordered authoritative user and assistant text messages from the selected branch;
- the new user message;
- the fixed Phase 4 `balanced` tier marker; and
- gateway events for text delta, successful terminal reason and usage, or normalized failure.

They contain no browser DTO, Drizzle row, OpenRouter type, raw provider identifier, cost, budget,
HTTP response, or React concern.

The Phase 4 system prompt is versioned as `capstone-chat-v1` and contains exactly:

```text
You are Capstone Chat, an AI assistant for Capstone employees.
Be helpful, accurate, and direct.
Follow the employee's requested format and use Markdown when useful.
Clearly distinguish known facts from uncertainty.
Respond in the language of the employee's latest request unless they request another language.
Use only the conversation content provided. Do not claim access to company systems, documents, or current information you have not received, and do not invent company knowledge.
```

The prompt lives in version-controlled backend code and is never accepted from the browser or a
workspace setting. Turn creation persists its version and the empty effective fake-parameter object
on the generation before gateway execution; tests bind both the durable row and gateway request to
that exact configuration.

`FakeModelGateway` must:

- deterministically emit configurable text chunks, delays, final reasons, and synthetic input/output
  usage;
- support a failure before content, a failure after content, empty success, cancellation, and a
  delayed event suitable for disconnect and backpressure tests;
- honor the supplied AbortSignal promptly;
- expose no HTTP server, test-only application route, global mutable singleton, or production key;
- receive test scripts through application dependency injection rather than environment variables;
  and
- use one clearly simulated, content-free canned response for ordinary local development.

Development and test construct `FakeModelGateway` by default. Production mode must reject fake
gateway configuration. Until Phase 6 supplies `OpenRouterGateway`, the Phase 4 artifact is an honest
development checkpoint rather than a deployable AI service. No OpenRouter package, environment key,
model placeholder, direct provider adapter, or second speculative gateway is added.

## Fastify streaming and lifecycle

Implement a narrowly focused response route and coordinator:

- Ordinary authentication, ownership, Origin, JSON, body, header, and preflight failures occur
  before the raw response is taken over and use the existing error handler.
- After turn commit, set the NDJSON headers, flush them, and emit `response.started` as the first
  line.
- Serialize only values already validated by the known stream-event schemas. Each line is encoded
  once and written as UTF-8 followed by `\n`.
- Respect `write()` backpressure. When it returns false, wait for `drain` with bounded time and race
  that wait against request close, cancellation, and shutdown.
- Pull the next gateway event only when the previous downstream write has cleared, so Fastify does
  not create an unbounded second response buffer.
- Detect request abortion and socket closure once, abort the gateway, checkpoint useful partial
  content, and terminalize as interrupted unless explicit cancellation already won.
- Check durable generation state before forwarding each new gateway event, checkpointing, and
  committing success. This lets a cancellation or deletion handled by another replica stop later
  writes without process-local authority.
- Normalize a gateway success, refusal, filter, length, timeout, empty response, failure, and abort
  into the approved event and durable-state mappings.
- Emit a terminal line only after the terminal transaction succeeds and only while the downstream
  response remains writable.
- Never retry the gateway automatically, restart after a delta, or switch a fake tier/model.
- Keep request completion logs metadata-only: method, route template, status, request ID, duration,
  safe generation lifecycle status, byte count, and timing are allowed; content is not.

Extend application lifecycle with a small active-stream registry:

- Register a controller only after a durable generation exists and unregister it in `finally`.
- Route navigation does not affect the backend request; browser fetch ownership does.
- On application drain, reject new response creation through readiness/route state, let existing
  streams finish for the selected bounded interval, then abort and mark the remainder incomplete
  before closing the pool where possible.
- Cancellation can signal a matching local controller immediately. The registry is never consulted
  to authorize a request or decide whether a generation exists.
- Shutdown contains no worker, queue, scheduled generation, or provider-independent job runner.

## Browser stream parser and `ChatRuntime`

### Parser

Add one plain-TypeScript NDJSON decoder that:

- accepts a `ReadableStream<Uint8Array>` and an AbortSignal;
- uses a fatal streaming `TextDecoder` and preserves split multi-byte Unicode;
- carries only a bounded incomplete line between chunks;
- parses completed lines independently;
- validates every known event with its TypeBox schema;
- ignores well-formed unknown event types;
- enforces event ordering and exactly one terminal event;
- distinguishes protocol violation from transport interruption; and
- never logs or embeds event text in thrown errors.

Do not add an SSE library, WebSocket client, generic observable library, generated client, or NDJSON
dependency for this small parser.

### Runtime ownership

Create one plain-TypeScript `ChatRuntime` per authenticated query scope. Its persistent lifecycle and
AbortControllers justify a small class; React components do not reproduce its state machine.

The runtime owns:

- a map of active stream entries keyed by conversation ID;
- the idempotency key and fetch controller for each locally started response;
- committed IDs received from `response.started`;
- accumulated assistant text and a pending-delta buffer;
- starting, generating, stopping, compacting, terminal, interrupted, and protocol-failure
  presentation state;
- one `requestAnimationFrame` publication schedule per active response; and
- subscriptions exposed through a small `useSyncExternalStore` adapter.

Runtime rules:

- Active streams live above route components inside the authenticated conversation boundary, so
  navigation between conversations does not abort them.
- Separate conversations may stream concurrently. One conversation has one entry.
- Token deltas append immediately in plain TypeScript but notify React at most once per animation
  frame. They never update TanStack Query per token.
- React renders durable query messages plus the matching runtime overlay for the active assistant.
- `response.started` triggers bounded invalidation/refetch for detail, history, draft, and response
  state; it does not replace backend-owned branch logic in memory.
- A terminal event flushes the final animation-frame buffer, invalidates canonical conversation,
  history, search, draft, and response-state queries, and keeps the runtime overlay until canonical
  state has reconciled. It then removes the entry.
- Interruption or protocol failure stops accepting deltas, retains the visible accumulated text only
  as temporary recovery presentation, and refetches canonical detail and response state. Durable
  checkpointed content replaces the temporary overlay when recovery succeeds.
- No replacement generation starts automatically.
- A session change or protected-boundary teardown aborts every locally owned stream before removing
  that authenticated query scope, clears accumulated text, and prevents late continuations from
  publishing into another employee's session.
- Runtime state is memory-only. It never enters localStorage, sessionStorage, IndexedDB, URL state,
  a service worker, analytics, or browser telemetry.

TanStack Query continues to own all persisted state. `ChatRuntime` is not a generalized global store
and must not absorb history, drafts, session data, dialogs, navigation, or ordinary mutations.

## Composer and response experience

Refactor the Phase 3 draft editor into one cohesive composer without duplicating draft state:

- The textarea remains a plain-text controlled input backed by immediate React memory and the
  existing server-draft state machine.
- It grows to the selected CSS maximum height, then scrolls internally without horizontal overflow.
- Empty or whitespace-only content cannot send.
- Desktop Enter sends, Shift+Enter inserts a newline, and IME composition never submits.
- In the mobile shell, Enter inserts a newline and the visible Send button submits. Use the same
  centralized responsive breakpoint as the shell, not user-agent detection.
- Pasted content remains plain text.
- Send first flushes the active draft and requires a confirmed, conflict-free server revision.
  Failed save or draft conflict leaves content in place and does not begin a generation.
- First Send adopts the new draft into one new conversation, updates query and draft memory scope,
  navigates to it, then begins the stream.
- A committed send resets that conversation's composer to the canonical empty draft while focus
  stays in the textarea. The employee may immediately type and autosave the next draft.
- While that conversation has an active local or canonical generation, its primary action is Stop.
  The textarea remains editable, but the next draft cannot submit until terminal state.
- Stop changes the local control to a non-interactive stopping state immediately, awaits a
  successful cancellation request, then aborts the stream and refetches canonical state. Deltas
  arriving while the request is pending may still accumulate but cannot replace the stopping
  presentation. A network failure does not falsely claim cancellation or manufacture an
  interruption; the locally owned stream remains authoritative until canonical recovery or an
  explicit retry resolves it.
- An active generation discovered from response state after reload or in another tab also exposes
  Stop. Poll response state only while that remote generation remains active and the document is
  visible.
- A `length` response shows a persistent output-limit state and Continue action without waiting for
  Phase 5 hover controls. Continue is disabled while another generation is active, but it does not
  overwrite or consume a separately typed draft.
- Cancelled, incomplete, and failed assistant responses remain visible plain-text alternatives.
  Interrupted and failure states show an explicit recoverable message; Phase 5 adds Try again.
- Refusal and content-filter outcomes remain preserved and are not retried or routed elsewhere.
- Sending, generating, stopping, completed, cancelled, interrupted, failed, and output-limit changes
  use concise centralized Spanish copy in one polite status region. Deltas themselves are not live
  announcements.
- Focus never moves to streamed content. A failure may expose an alert without stealing composer
  focus; keyboard users can reach its recovery action normally.
- Reduced motion removes the new-chat-to-docked transition animation while preserving the layout
  and state change.

Phase 4 uses the existing safe text renderer with preserved line breaks. It may make the assistant
layout full-width and the employee message a restrained Paper card as already approved, but it does
not parse Markdown, render HTML, expose copy buttons, add branch controls, or implement the final
scroll-follow controller. The initial user message remains visible through normal route positioning;
Phase 5 owns near-bottom detection, selection disengagement, Jump to latest, and nuanced scroll
restoration during deltas.

## Work plan

### 1. Freeze and verify the Phase 3 baseline

- Record the exact accepted Phase 3 commit and working-tree state.
- Re-run the accepted repository-scoped formatting/lint gate, strict type checking, all unit and
  PostgreSQL tests, production builds, Phase 3 Playwright suite, migration checks, and API image
  verification.
- Confirm the literal local `pnpm check` exception, if still present, is only the globally ignored
  `.claude/settings.local.json` and not a repository file.
- Inspect current dependencies and official documentation only where implementation-sensitive
  Fastify raw streaming, Node abort, browser streams, React external-store, or TypeBox behavior has
  changed. Record any compatibility constraint; do not upgrade unrelated packages.
- Stop if Phase 3 is not reproducible or if current dependency behavior contradicts a locked stream,
  security, privacy, or compatibility requirement.

### 2. Encode the approved protocol and error catalogs

- Add narrowly named protocol modules for generation requests, response state, stream events, and
  parser-facing inferred types.
- Encode the eight known NDJSON event schemas exactly as approved above.
- Centralize the full stable error union without changing the ordinary envelope fields.
- Add schema tests for every event, terminal reason, usage shape, request union, response state,
  idempotency header, extra-property rejection, and all catalog codes.
- Prove unknown event forward compatibility separately from known-event validation.
- Export only public transport schemas and inferred types from `packages/protocol`.

### 3. Add the lifecycle migration

- Generate and review one Phase 4 migration, including manual SQL where Drizzle cannot express a
  partial unique index, nullable retention foreign key, or lifecycle check clearly.
- Extend the Drizzle schema only with the approved enums and lifecycle table.
- Prove clean-database migration and exact Phase 3 upgrade.
- Verify existing messages, search vectors, drafts, conversations, identity data, and pagination
  remain unchanged.
- Verify the migration creates no Phase 6 usage/cost/model or Phase 7 compaction/admin structures.

### 4. Extend draft adoption and authoritative context

- Extend conversation creation with transactional new-draft adoption while preserving the existing
  empty-create contract.
- Add the Phase 4 user-message normalization and bounded selected-branch context builder near the
  conversation feature.
- Keep initial-title behavior exactly as accepted in Phase 3 and invoke it only inside first turn
  creation.
- Add the exact system prompt and Continue copy as versioned backend constants.
- Return model-neutral context from the committed turn boundary without retaining a database
  connection.

### 5. Implement generation persistence and idempotent turn creation

- Add explicit queries for active-generation detection, idempotency insertion, assistant state
  reads, checkpoints, terminalization, cancellation, and deletion integration.
- Reuse the Phase 3 actor and owned-conversation predicates rather than introducing a second
  authorization abstraction.
- Preserve the direct transaction flow and make all unique/check violations map to the approved
  stable errors without leaking database detail.
- Treat draft consumption, title creation, user message, assistant placeholder, generation,
  selection, and start revision as one atomic unit.
- Make cancellation and terminalization idempotent and race-safe.

### 6. Add `ModelGateway`, `FakeModelGateway`, and stream coordination

- Define the minimal backend-only gateway types and interface.
- Implement the deterministic injected fake and safe local default.
- Build the bounded accumulator, coalesced checkpoint writer, terminal arbiter, downstream writer,
  and local active-controller registry as small focused modules.
- Integrate request close, explicit cancellation, deletion, and application shutdown with one abort
  path.
- Keep every log and error metadata-only.
- Do not add an OpenRouter dependency or any provider-shaped field.

### 7. Register streaming, cancellation, and response-state routes

- Keep ordinary errors inside the existing Fastify error boundary until turn commit.
- Use the real HTTP response only for the NDJSON phase and preserve all security/cache headers.
- Validate `Accept`, content type, request body, path, header, and response-state IDs.
- Ensure the route never calls `reply.send` after raw stream takeover and settles every listener and
  promise in `finally`.
- Extend deletion through the same generation service rather than duplicating cancellation logic.
- Add real-listener tests for behavior Fastify injection cannot model.

### 8. Implement the browser parser and authenticated `ChatRuntime`

- Build and exhaustively test the bounded incremental parser first.
- Add the runtime outside route components but inside the current authenticated query scope.
- Expose only small hooks for a conversation's runtime state and lifecycle actions.
- Reuse the accepted authenticated-generation and request-lifetime fencing patterns for session
  teardown, while deliberately not tying streams to route lifetime.
- Integrate terminal invalidation with existing scoped query keys and draft memory.
- Ensure animation-frame publication is deterministic under React Strict Mode and cleanup.

### 9. Complete the composer and lifecycle UI

- Evolve the existing `DraftEditor` and pages rather than creating a parallel composer system.
- Add draft flush, new-scope adoption, Send, Stop, Continue, desktop/mobile keyboard behavior, IME
  guards, textarea growth, active-state disabling, and localized status/error copy.
- Render runtime text over canonical assistant state without writing each delta into query cache.
- Add response-state reads for reload, another tab, and rollout fallback.
- Keep response presentation safe plain text and accessible in the existing branded shell.
- Do not add any Phase 5 action or renderer as a placeholder.

### 10. Add proportional automated and manual verification

- Use Vitest for protocol, parser, runtime, accumulator, checkpoint scheduler, lifecycle mapping,
  keyboard, and deterministic fake logic.
- Use Fastify injection for ordinary pre-stream rejection, cancellation, response-state, security,
  and authorization cases.
- Use Testcontainers with the real migration history for transactional turn creation, idempotency,
  active uniqueness, draft consumption, checkpoints, terminal races, deletion, ownership, and
  revision behavior.
- Use a real local HTTP listener for chunk framing, partial network chunks, disconnect, AbortSignal,
  backpressure, terminal delivery, and graceful drain.
- Use Playwright for complete employee sending, stopping, interruption recovery, Continue, draft
  while streaming, navigation during a stream, reload, and responsive composer flows.
- Run the critical send/Stop/composer stream cases in Chromium, Firefox, and WebKit. The broader
  Phase 4 browser suite may remain Chromium-first.
- Perform manual keyboard, focus, screen-reader status, reduced-motion, mobile, and no-horizontal-
  overflow checks for critical chat lifecycle states.

### 11. Update CI, container verification, and documentation

- Extend existing jobs and scripts without adding a task orchestrator or duplicate workflow.
- Keep CI fully fake and deterministic; it receives no OpenRouter key and makes no external model
  request.
- Ensure the production API image contains the Phase 4 migration and still runs as non-root.
- Document local fake behavior, first-send draft adoption, Send/Stop/Continue, interruption recovery,
  stream troubleshooting, the production-fake prohibition, and the absence of real AI until Phase 6.
- Record selected operational values and final verification in this plan's implementation record
  when coding begins.
- Keep every fixture and example synthetic and content-safe.

## Required verification cases

The Phase 4 test suite must prove at least the following:

### Protocol and parser

- Every approved event and stable code validates, and undeclared fields fail known schemas.
- A known malformed event terminates parsing with `STREAM_PROTOCOL_ERROR`.
- A well-formed unknown event is ignored before, between, and after content events but cannot replace
  `response.started` or a terminal event.
- UTF-8 code points, JSON lines, and delimiters split across arbitrary byte chunks reconstruct
  exactly once and in order.
- Invalid UTF-8, completed invalid JSON, non-object JSON, missing type, oversized lines, duplicate
  start, event before start, duplicate terminal, and event after terminal fail safely.
- EOF without terminal and a trailing partial object become `STREAM_INTERRUPTED` rather than an
  invented completion.
- Parser and runtime errors contain no delta text.

### Persistence and authorization

- The migration applies to empty PostgreSQL and upgrades the accepted Phase 3 schema exactly.
- Draft adoption is atomic, preserves content/revision, and creates no conversation on conflict.
- A send cannot cross workspace, employee, conversation, message parent, draft, or generation scope,
  including for an administrator.
- Archived, stale, empty, invalid-control, oversized, wrong-parent, and wrong-draft requests change
  no persistent state and preserve the draft.
- First send creates the deterministic title, while later sends and edits to fixture history do not
  overwrite it.
- User message, assistant placeholder, active generation, selected leaf, consumed draft, title, and
  revision commit together or not at all.
- Two concurrent sends in one conversation produce one generation and one `GENERATION_ACTIVE`.
- Separate conversations may generate concurrently.
- Two requests using the same scoped idempotency key create one turn and the replay receives
  `GENERATION_ALREADY_EXISTS`, including after terminal completion.
- The same random key may exist for a different employee without crossing authorization scope.
- Checkpoints coalesce, never run per token, never increment revision, and never overwrite a terminal
  row.
- Completion, cancellation, disconnect, failure, deletion, and late gateway events result in one
  terminal transition and at most one terminal revision increment.
- Stop yields cancelled; unexplained disconnect with partial content yields incomplete; failure
  before useful content yields failed; empty success yields `EMPTY_RESPONSE`.
- Completed `stop`, `length`, `refusal`, and `content_filter` outcomes remain durable with exact
  reasons.
- Continue is permitted only from the selected `length` response, inserts the exact visible message,
  uses `balanced`, and leaves an existing draft unchanged.
- Deleting during generation prevents later resurrection and removes content while retaining only
  the approved non-content lifecycle row.
- Phase 3 assistant fixtures without generations still load and search normally.

### HTTP streaming and cancellation

- Pre-stream errors remain ordinary JSON with no partial NDJSON body.
- A successful stream has exact content type and cache/security headers and begins with
  `response.started` only after turn commit.
- Deltas arrive before generation completion and are not buffered into one final response.
- A slow reader exercises `drain`; memory stays within the selected bounds and the stalled reader
  reaches cancellation rather than unbounded buffering.
- Explicit Stop aborts the fake gateway, preserves all locally streamed content on the owning
  replica or the latest durable checkpoint across replicas, and remains idempotent across
  completion races.
- Socket disconnect aborts upstream work and cannot emit or persist false completion.
- A cancellation handled through another application instance prevents later checkpoint or terminal
  overwrite when both instances share PostgreSQL.
- Graceful shutdown rejects new generation work, drains completed streams, and marks timed-out
  remainder incomplete before database shutdown where available.
- Captured application logs contain no request content, draft, system prompt, Continue content,
  delta, accumulated response, raw gateway event, or stream line.

### Browser and experience

- New-chat Send flushes and adopts the server draft, navigates once, preserves focus, and streams a
  clearly simulated answer.
- A failed adoption or preflight leaves the employee's exact local and server draft recoverable.
- Desktop Enter sends, Shift+Enter inserts a newline, mobile Enter inserts a newline, and IME
  composition never sends.
- Repeated click, Enter key repeat, and React Strict Mode do not create duplicate turns.
- The composer resets only after `response.started`; failure before start keeps its text.
- The employee can type and autosave the next draft while the answer streams but cannot send it.
- Navigating to another conversation does not stop the stream; returning shows accumulated output
  and then canonical terminal state.
- Separate conversations display independent simultaneous streams without cross-contamination.
- Stop responds visibly immediately, durably records cancellation before aborting its local reader,
  retains the next draft, and reconciles to cancelled canonical state.
- Reload during an active or abandoned generation reads response state and offers Stop without
  attempting to resume the byte stream.
- Connection loss and malformed protocol refetch canonical state, show interrupted recovery, and do
  not generate a replacement.
- A `length` outcome stays visible and Continue creates the approved ordinary message without
  consuming a typed draft.
- Status announcements cover lifecycle transitions but never individual deltas; streaming does not
  move focus.
- A same-employee session rotation and direct employee replacement abort old streams and prevent
  stale content, callbacks, or query writes from entering the new session.
- No conversation or stream content enters browser storage, URLs, analytics, console output, or
  error strings.
- Desktop and mobile layouts remain keyboard accessible, reduced-motion safe, and free of
  horizontal overflow for long uninterrupted plain text.

## Phase boundary

The following are forbidden in Phase 4, including as disabled controls, empty tables, generic
abstractions, preinstalled dependencies, compatibility shims, or speculative placeholders unless
the approved Phase 4 work above directly requires them.

### Phase 1 — Foundation

- Do not replace pnpm, TypeScript, Biome, Fastify construction, PostgreSQL pool, migration runner,
  TypeBox, error envelope, React Router, TanStack Query, Vitest, Playwright, CI, container, or brand
  packaging with parallel systems.
- Do not introduce a task orchestrator, generated API client, second schema source, second database
  layer, SSE, or WebSockets.

### Phase 2 — Identity

- Reuse Better Auth, the actor resolver, exact-Origin boundary, session query, authorization, and
  authenticated lifecycle fencing.
- Do not change onboarding, email, password, session, membership, administrator, or local mailbox
  behavior except for a narrowly covered integration needed to stop streams during session teardown.

### Phase 3 — Conversation core

- Preserve immutable tree topology, scoped ownership, structural and draft revisions, search,
  pagination, archive, deletion, and draft semantics.
- Do not redesign Phase 3 services broadly or combine streaming into a generic conversation
  repository.
- Do not weaken strict response validation, query scoping, content logging rules, or the route-
  lifetime protections for ordinary requests.

### Phase 5 — Conversation controls and rendering

- No user-message edit, Try again, undo, general branch navigation, answer copy, code-block copy,
  GitHub-flavored Markdown rendering, safe-link renderer, tables, task lists, syntax highlighting,
  mathematics, response-format gallery, or final action toolbars.
- No near-bottom scroll-follow controller, selection disengagement, Jump to latest, streamed smooth-
  scroll batching, search-match highlight animation, or general branch-switching UI.
- Continue and terminal badges are Phase 4 lifecycle requirements and do not authorize other answer
  controls.

### Phase 6 — OpenRouter and cost control

- No OpenRouter dependency, API key, HTTP request, raw provider event, recorded provider fixture,
  model catalog, ZDR validation, fallback routing, tier mapping, preferred-tier column, tier picker,
  provider/model identifier, model-dependent parameter override, persisted usage, price, cost,
  budget, reservation, settlement, employee limit enforcement, cancellation accounting, expiry
  lease, or periodic reconciliation. The only recorded Phase 4 generation configuration is the
  fixed `balanced` marker, approved prompt version, and empty fake-parameter object.
- Do not present fake usage as spend or expose Fast, Balanced, and Pro as functioning alternatives.

### Phase 7 — Compaction and administration

- No compaction query, table, prompt, summary, trigger, fallback, model call, persistence, or search
  behavior. Phase 4 only encodes the approved future event schemas.
- No `/admin` route, administrative navigation, employee HTTP administration, model policy forms,
  tier controls, output limits, workspace budget control, usage view, or cost table.

### Phase 8 — Production hardening

- No OpenTelemetry SDK, browser telemetry, frontend-error ingestion endpoint, observability vendor,
  production platform, edge-proxy configuration, secret-manager adapter, custom backup system,
  disaster-recovery automation, or general load-test infrastructure.
- Phase 4 performs focused cross-browser, accessibility, backpressure, and bounded-memory checks but
  does not claim production capacity or launch readiness.

### Features outside approved v1 scope

- No sharing, attachments, document retrieval, browsing, tools, skills, agents, image generation,
  long-term memory, public links, exports, imports, folders, tags, favorites, presence, collaborative
  editing, offline mode, service worker, browser-persisted query cache, or semantic search.
- No raw HTML, scripts, iframes, embeds, Mermaid, provider-specific renderer, hidden reasoning, or
  content block beyond one text block.

## Acceptance procedure

From the frozen accepted Phase 3 baseline with Docker and the supported browsers available:

1. Run every accepted Phase 3 gate and confirm the baseline is reproducible.
2. Apply the complete migration history to empty PostgreSQL and upgrade an exact Phase 3 database.
3. Inspect generation constraints, indexes, nullable retention references, and absence of Phase 6/7
   columns and tables.
4. Start Fastify and Vite with the deterministic fake gateway and sign in as a synthetic employee.
5. Type a new-chat draft, send it, and verify draft adoption, one navigation, one user message, one
   assistant placeholder, one title, one active generation, and smooth incremental plain-text output.
6. Confirm focus stays in the composer and type a second draft while the first response streams.
7. Attempt to submit the second draft before terminal state and confirm the backend and UI both
   prevent it without losing the draft.
8. Exercise desktop Enter, Shift+Enter, mobile Enter, visible Send, pasted text, whitespace rejection,
   and IME composition.
9. Stop after partial output before the next checkpoint threshold and verify the fake gateway
   aborts, all locally visible partial content remains, `firstTokenAt` is durable, status is
   cancelled, revision increments once, and the next draft remains ready. Repeat through another
   replica and verify it safely retains the latest durable checkpoint.
10. Drop the streaming connection without the cancellation request and verify canonical state is
    incomplete/interrupted rather than falsely cancelled or completed.
11. Reload during an active response, read canonical response state, and stop it without byte-stream
    resume.
12. Navigate away during a local stream, start another conversation stream, return, and verify both
    runtimes and canonical results stay isolated.
13. Trigger fake ordinary completion, length, refusal, content filter, pre-content failure,
    mid-content failure, timeout, empty success, and cancellation; inspect exact events and durable
    mappings.
14. Use Continue after length with a non-empty saved draft and verify the approved visible message is
    added while that draft remains unchanged.
15. Reuse an idempotency key concurrently and after completion; verify one turn exists and every
    replay returns `GENERATION_ALREADY_EXISTS`.
16. Race checkpoint, completion, Stop, archive, rename, and deletion; verify terminal state cannot be
    overwritten and content cannot be resurrected.
17. Sign in as a second employee and an administrator; verify neither can read state, send, cancel,
    or infer the first employee's generation.
18. Simulate a slow downstream reader and confirm backpressure, selected memory bounds, stall timeout,
    and cancellation behavior through a real HTTP listener.
19. Begin graceful shutdown with one completing and one stalled stream; verify drain and forced
    interruption behavior before pool closure.
20. Feed split Unicode, split JSON, unknown events, malformed known events, oversized lines, duplicate
    lifecycle events, and truncated EOF through the browser parser.
21. Inspect captured logs and browser diagnostics for prompt, draft, message, delta, accumulated
    response, system prompt, Continue text, raw gateway event, and stream-line leakage.
22. Manually verify keyboard access, focus, lifecycle announcements, reduced motion, responsive
    layouts, and long-text overflow.
23. Run `pnpm check`.
24. Run `pnpm typecheck`.
25. Run `pnpm test`.
26. Run the Chromium Phase 4 Playwright suite and the critical streaming flows in Firefox and WebKit.
27. Run `pnpm build` and build the production API image.
28. Run `git diff --check` and review dependencies, migration, schema, protocol, backend, web, tests,
    logs, and documentation for forbidden Phase 5–8 work.

## Definition of done

Phase 4 is complete only when:

- The accepted Phase 3 baseline remains reproducible and every required Phase 4 gate succeeds.
- The complete eight-event NDJSON catalog and stable error catalog are encoded once in
  `packages/protocol`, covered, and used consistently by Fastify and the browser.
- PostgreSQL atomically creates one authoritative turn, consumes only the matching draft, enforces
  one active generation per conversation, prevents idempotency duplicates, checkpoints partial
  content, and stores exactly one terminal outcome.
- No transaction or pooled connection is held across fake-gateway or browser network waits.
- `FakeModelGateway` deterministically proves chunks, delays, usage, failures, empty output,
  cancellation, and AbortSignal behavior without any production provider or external request.
- Streaming honors downstream backpressure, bounded buffering, coalesced checkpoints, disconnect,
  Stop, deletion, terminal races, and graceful shutdown.
- The authenticated `ChatRuntime` keeps active streams across route navigation, batches delta
  publication per animation frame, isolates concurrent conversations and sessions, and leaves
  TanStack Query as the owner of canonical data.
- The composer sends correctly on desktop and mobile, respects IME, preserves and synchronizes the
  next draft while streaming, stays focused, and exposes accessible Send, Stop, terminal, failure,
  interruption, and Continue states in centralized Spanish copy.
- A disconnected stream is never resumed or automatically replaced; canonical refetch recovers the
  latest durable checkpoint and explicit employee action is required for another generation.
- Assistant output remains safe plain text. The final diff contains no Phase 5 renderer/control,
  Phase 6 provider/cost/tier policy, Phase 7 compaction/admin behavior, or Phase 8 platform system.
- Tests cover schemas, parser framing, migrations, ownership, atomicity, revisions, draft movement,
  idempotency, concurrency, persistence races, real HTTP streaming, browser lifecycle, accessibility,
  privacy-safe diagnostics, and critical cross-browser behavior.
- Documentation lets another developer reproduce every Phase 4 state and clearly states that local
  responses are simulated and production model access does not yet exist.
- Any failed or unavailable verification is reported exactly rather than treated as complete.

Completion of Phase 4 authorizes no automatic Phase 5 work. Phase 5 begins only after Phase 4 is
reviewed, explicitly accepted, planned against this exact baseline, and separately authorized.
