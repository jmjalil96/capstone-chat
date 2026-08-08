# Phase 3 — Conversation Core Implementation Plan

Status: implemented and accepted

Code authorization: granted by the user on 2026-08-06

## Implementation record

- Accepted Phase 2 baseline: commit `bcc739c` (`Add Phase 2 identity`). The Phase 3 plan is commit
  `1c983b2` (`Add Phase 3 conversation core plan`).
- Preflight verification passed all 142 Phase 2 protocol, API, PostgreSQL integration, and web unit
  tests, strict type checking, production builds, and all five Chromium browser tests. The literal
  `pnpm run ci` wrapper remains affected only by the globally ignored local
  `.claude/settings.local.json`; the repository-scoped Biome check passed all 93 source files, and
  the unrelated local file remains untouched.
- Server-owned page sizes are 20 recent or archived conversations, 40 selected-branch messages,
  and 20 search results.
- Manual titles are limited to 120 Unicode code points. Deterministic initial titles use at most 72
  Unicode code points.
- Search text is limited to 256 UTF-8 bytes and drafts to 32,768 UTF-8 bytes. Draft autosave waits
  600 ms after typing pauses; search waits 250 ms. The only local preference key is
  `capstone-chat.sidebar-collapsed.v1`.
- Search lexemes are derived through a plain-text parser before final-term prefix construction.
  Employee input is never passed directly to `to_tsquery`; quotes, operators, punctuation-only
  input, Unicode accents, and empty-after-tokenization cases are required regression coverage.
- Browser fixtures are seeded by the isolated API/Testcontainers harness after migration and before
  it begins listening. Playwright receives no database credential and the application exposes no
  test-only HTTP route.
- Plan approval accepts that selecting a different branch from a search result is a structural
  mutation: it increments the conversation revision and updates recent-history ordering. Selecting
  the already selected leaf remains a no-op.
- The Phase 3 cascade contains content only. Phase 6 usage and cost-accounting records must survive
  conversation deletion and therefore must not depend on this content cascade when that schema is
  designed.
- PostgreSQL remains authoritative for both search matching and snippet normalization. The final
  whitespace-delimited lexical term applies prefix matching to every lexeme PostgreSQL derives
  from that term, including overlapping hyphenated-word and URL lexemes; earlier terms remain
  exact. Typed plain-text snippet spans are mapped from batched PostgreSQL code-point folds, with
  no HTML or second transliteration table.
- Final verification passed 258 unit and PostgreSQL integration tests: 107 protocol, 107 API, and
  44 web. Strict type checking, production builds, `git diff --check`, and the repository-scoped
  Biome check over all 128 repository files passed. `pnpm test:e2e` passed all eight Chromium
  identity and conversation scenarios.
- The complete migration history passed clean-database and exact Phase 2 upgrade tests. The
  production API image built from the final source, runs as non-root `node` (UID 1000), and contains
  both repository SQL migrations and the compiled runtime.
- Manual browser acceptance used the isolated migrated fixture server. Desktop conversation and
  search views, the 320-pixel modal drawer and focus restoration, and the 844-by-320 new-chat and
  conversation draft layouts had no horizontal overflow or current console error. Temporary test
  servers and browser tabs were closed afterward.
- The literal local `pnpm check` remains blocked only by the globally ignored
  `.claude/settings.local.json`, which is outside the versioned repository and was left untouched.
  Running Biome against every repository file passed; `typecheck`, `test`, `build`, Playwright,
  container, and diff gates all passed independently.
- Post-implementation isolation review found that actor-neutral TanStack Query keys and untracked
  draft promises could outlive an authenticated employee transition. Conversation cache keys now
  include workspace, employee, and session creation time. Workspace or employee changes remount the
  protected conversation tree; a same-employee session rotation replaces the internal generation
  without remounting the account-security page, so password-change confirmation remains visible.
  Ending either lifetime immediately fences stale continuations, aborts direct requests, and removes
  only the ended session's query scope.
- The isolation regression runs under React Strict Mode and directly replaces employee A with
  employee B in the same workspace while A has a delayed draft save and a newer forced save queued.
  It resolves A's response despite cancellation and verifies that A's cache stays absent, no second
  A request or stale navigation occurs, B keeps canonical revision `0`, and B's next save observes
  revision `0` before advancing normally. A companion regression rotates the same employee's
  session while a request is delayed and verifies that the old request is aborted without blocking
  the new generation's save.
- Post-fix verification passed all 261 tests: 107 protocol, 107 API and PostgreSQL integration, and
  47 web. Full strict type checking, production builds, `git diff --check`, the repository-scoped
  Biome check over all 128 repository files, and all eight Chromium scenarios passed. The existing
  Vite chunk-size advisory and the literal `pnpm check` exception above remain unchanged.
- A second read-only review found that direct search opening and canonical recovery were fenced by
  the authenticated session but not by the route or component that started them. A delayed result
  could therefore navigate after `/search` had unmounted, and recovery for one conversation could
  publish presentation state after the route changed to another conversation. Direct page requests
  now use one scoped lifetime that combines the authenticated generation with a local abort signal;
  cleanup or a conversation-identifier change aborts the request and makes every continuation
  ineligible. Rename and archive actions use the same lifecycle rule.
- Focused regressions cover both component unmount under React Strict Mode and a conversation route
  replacement while canonical recovery remains delayed. That remediation's verification passed all
  263 tests: 107 protocol, 107 API and PostgreSQL integration, and 49 web. Full strict type checking,
  production builds, `git diff --check`, the repository-scoped Biome check over all 130 repository
  files, and all eight Chromium scenarios passed. The existing Vite chunk-size advisory and literal
  `pnpm check` exception remain unchanged.
- A final pre-commit review found that search detail prefetch used the destination's shared TanStack
  Query key with a search-lifetime abort signal. Opening the same conversation manually while that
  prefetch was pending could therefore join the doomed request and inherit its `AbortError`. Search
  now performs the scoped canonical read directly and publishes complete infinite-query data only
  after the lifetime remains current, preserving warm navigation without sharing the in-flight
  request with the destination route.
- The regression opens the destination while that scoped read remains pending and requires a
  separate successful canonical read after search cleanup aborts its request. Final verification
  passed all 264 tests: 107 protocol, 107 API and PostgreSQL integration, and 50 web. Full strict
  type checking, production builds, `git diff --check`, the repository-scoped Biome check over all
  130 repository files, and all eight Chromium scenarios passed. No API, protocol, schema, or Phase
  4 behavior changed.
- A 2026-08-07 cross-phase correction reuses the public draft and search request schemas for
  advisory browser validation. Oversized or control-character input remains editable and protected
  from loss, receives specific Spanish guidance, and causes no futile autosave, retry, search, or
  Send request until corrected; Fastify remains authoritative.
- Late proof of an ambiguous committed send now consumes only the exact confirmed draft identity.
  A draft saved after the send remains canonical, local edits retain their CAS base, and a different
  cross-tab revision becomes the existing explicit draft conflict instead of being overwritten.
  Regressions cover stale pre-send cache data, a saved next draft, dirty local text, and a newer
  cross-tab draft.

## Objective

Add the smallest complete persistence and application boundary for employee-owned conversations.
An authenticated employee can enter the real Capstone Chat shell, keep a server-side new-chat or
conversation draft, page through recent and archived history, open the selected immutable branch,
rename, archive, unarchive, and permanently delete a conversation, and search titles and message
text across preserved branches.

Phase 3 makes PostgreSQL the authoritative conversation store and proves the complete non-model
conversation lifecycle. It does not send a message to a model, create a generation, stream content,
or expose temporary controls for later phases.

Approving this plan makes its implementation choices the Phase 3 baseline. It does not authorize
code until code authorization is granted explicitly.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its decision policy.
3. `docs/prd/01-product-scope-and-experience.md`, especially Product language, Browser support,
   Application shell, Conversations and history, Composer behavior, Conversation privacy,
   Retention and deletion, Streaming scroll behavior, Connection loss, and Response presentation.
4. `docs/prd/02-system-architecture-and-data.md`, especially Architecture, API contracts,
   Browser responsibilities, Frontend state ownership, Backend responsibilities, Browser security,
   Database access, Workspace boundary, Core conversation storage, Optimistic revisions,
   Conversation search, History pagination, Draft storage, Verification, and Observability.
5. `docs/prd/03-conversation-model-and-streaming.md` for the immutable-tree, authoritative-history,
   user-message, edit, try-again, and generation boundaries that Phase 3 must prepare without
   implementing.
6. `docs/prd/04-cost-control-and-reliability.md` only for the deletion and generation-accounting
   boundary; Phase 3 creates no usage, cost, reservation, or reconciliation behavior.
7. `docs/prd/05-brand-system.md` for shell presentation, semantic colors, typography, responsive
   behavior, product voice, focus, motion, and WCAG 2.2 AA requirements.
8. `docs/prd/06-development-roadmap.md`, especially Conversation core and the Phase 4–8 sequence.
9. `docs/implementation/01-foundation-plan.md`, `docs/implementation/02-identity-plan.md`, and the
   reviewed Phase 1 and accepted Phase 2 implementation.
10. The current migration, schema, actor, authorization, error, route-registration, protocol,
    React Router, TanStack Query, copy, styling, testing, CI, and documentation patterns.
11. Current `git status`, the exact accepted Phase 2 baseline, and its final verification record.

Phase 3 implementation begins only after the accepted Phase 2 work is frozen as an exact commit or
otherwise recorded reviewable baseline. Phase 3 work must not be mixed into an unidentified Phase 2
diff.

The implementer must select and record the operational values Phase 3 first needs:

- recent and archived conversation page size;
- selected-branch message page size;
- search-result page size;
- maximum manual title length and deterministic initial-title display length;
- search-query and draft storage byte limits;
- draft autosave and search-input debounce intervals; and
- the local key used only for the desktop sidebar-collapse preference.

These are operational and presentation tuning values, not new product behavior. Keep them named,
centralized, and tested. Do not scatter numeric literals through routes or components. If a value
would materially change retention, privacy, security, or the locked employee experience, stop for
approval.

Phase 3 does not need an OpenRouter model, model tier mapping, generation timeout, output limit,
budget, compaction threshold, or streaming checkpoint value. Those remain later-milestone choices.

## Dependency direction

```text
apps/web ──JSON/HTTP──> apps/api ──Drizzle/node-postgres──> PostgreSQL
   │                       │
   ├──────────────────────> packages/protocol
   └──────────────────────> packages/brand

apps/api ────────────────> packages/protocol
```

- The web application renders and requests conversation state; it never reconstructs an
  authoritative history tree or decides ownership.
- Fastify resolves the Phase 2 actor, scopes every query to that actor's workspace and employee,
  validates revisions, and owns all persistence and search behavior.
- PostgreSQL is the source of truth for conversations, messages, selected leaves, drafts,
  revisions, archive state, and search indexes.
- `packages/protocol` contains only public conversation, message, draft, pagination, search, and
  stable error contracts. It contains no Drizzle models or backend query helpers.
- The implementation extends the existing `route -> service -> explicit queries` flow. It does not
  add repositories, an ORM abstraction, a command bus, a dependency-injection container, a generic
  state machine, or a second frontend store.
- Phase 3 requires no new runtime service and should require no new application dependency. Use
  PostgreSQL full-text search, existing React Router and TanStack Query, and browser-native
  interaction primitives.

## Conversation lifecycle and invariants

Phase 3 implements this content lifecycle:

```text
new-chat draft (no conversation)
        |
        | explicit conversation creation
        v
active conversation ──archive──> archived conversation
        ^                              |
        |──────────── unarchive ───────|
        |
        `──── delete confirmation ───> physically deleted content
```

Messages form one immutable parent-linked tree per conversation. A conversation's selected leaf
identifies the one branch returned as its ordinary reading path.

```text
User message
`-- Assistant response A
    `-- Next user message
        |-- Assistant response B
        `-- Assistant response C  <- selected leaf
```

The following invariants apply:

- Every conversation belongs to exactly one workspace and one Better Auth employee.
- Every conversation read and mutation requires both workspace and employee ownership. An
  administrator receives no content-reading exception.
- A message belongs to one conversation, and its optional parent belongs to that same conversation.
- A message's conversation, parent, role, and completed content are not rewritten to implement
  edits, retries, undo, or branch changes. Later phases create alternatives instead.
- The selected message belongs to the conversation and is a leaf when selection is committed.
- A root message is a user message. Along a valid branch, user and assistant roles alternate.
- A conversation may be empty during the pre-generation lifecycle. Its persisted title is `null`,
  while the web renders the centralized Spanish new-chat placeholder. The placeholder is not stored
  or indexed as employee content.
- A conversation without a selected leaf does not produce a search result. Once the first message
  exists, every search result resolves a concrete leaf containing the match.
- The first persisted user message sets the initial title only if the title is still `null`.
  Deterministic title construction normalizes whitespace and truncates safely without a model call.
  A later edit never regenerates it, and a manual title is never overwritten.
- Archive is reversible. Archived conversations leave ordinary history but remain searchable and
  retain the same messages, selected branch, draft, and ownership.
- Deletion is a physical, transactional removal of conversation content and its draft from the
  active database. Phase 3 has no recycle bin, soft-delete column, restore route, or administrator
  recovery path.
- Drafts and structural conversation state use independent monotonic revisions.
- Reading never increments either revision. A branch-selection request that already selects the
  requested leaf is also a no-op and does not increment the conversation revision.
- Draft autosaves never reorder conversation history. Structural conversation mutations update the
  conversation timestamp used by recent-history ordering.
- No query, cursor, identifier, role claim, workspace claim, or search result supplied by the
  browser can widen the actor's ownership scope.

## Public HTTP contract

Phase 3 adds the following authenticated Capstone routes. All state-changing requests use JSON and
the existing exact-Origin boundary. Route schemas live in `packages/protocol` and are registered
through Fastify's TypeBox provider.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/conversations` | Page active or archived conversation summaries |
| `POST` | `/api/conversations` | Create an empty owned conversation |
| `POST` | `/api/conversations/search` | Search owned active and archived content without putting search text in a URL |
| `GET` | `/api/conversations/:conversationId` | Load metadata and a recent page of the selected branch |
| `PATCH` | `/api/conversations/:conversationId/title` | Rename with the observed conversation revision |
| `PUT` | `/api/conversations/:conversationId/selection` | Persist a concrete selected leaf with revision checking |
| `POST` | `/api/conversations/:conversationId/archive` | Archive with revision checking |
| `POST` | `/api/conversations/:conversationId/unarchive` | Unarchive with revision checking |
| `DELETE` | `/api/conversations/:conversationId` | Permanently delete after revision checking |
| `GET` | `/api/drafts/new` | Read the employee's new-chat draft |
| `PUT` | `/api/drafts/new` | Compare-and-swap the employee's new-chat draft |
| `GET` | `/api/conversations/:conversationId/draft` | Read the owned conversation draft |
| `PUT` | `/api/conversations/:conversationId/draft` | Compare-and-swap the owned conversation draft |

Contract rules:

- `GET /api/conversations` accepts only an active-or-archived view and an optional opaque cursor.
  The server owns page size and ordering.
- `POST /api/conversations/search` accepts the search text and optional cursor in a bounded JSON
  body. Search text never appears in a browser navigation URL or API query string.
- Conversation summaries contain only identifier, nullable stored title, archive state, structural
  revision, and UTC creation/update timestamps needed by the UI. They contain no message text,
  employee email, provider metadata, or future model policy.
- `POST /api/conversations` creates revision `0`, a `null` title, no selected leaf, and no messages.
  Merely opening or typing in the new-chat route does not call it. Phase 4 may invoke this operation
  as part of first-send orchestration; Phase 3 adds no temporary browser action solely to exercise
  it.
- Conversation detail returns metadata plus whole messages from the selected branch in reading
  order. An opaque cursor loads older ancestors. It never returns the complete tree by default.
- Each visible message includes its identifier, parent identifier, role, typed text content,
  creation time, and sibling-alternative count. It does not load complete sibling branches.
- A message-history cursor is bound to its conversation, selected leaf, and observed conversation
  revision. Reusing it after structural change returns `CONVERSATION_CHANGED` instead of mixing two
  branches.
- Rename accepts one normalized, non-empty single-line title and the observed revision. The API
  applies the selected maximum length and returns the canonical updated summary.
- Selection accepts a concrete leaf identifier and the observed revision. Fastify verifies
  ownership, conversation membership, and leaf status in the same short transaction. It increments
  the revision only when the selected leaf changes.
- For rename, selection, archive, and unarchive, a request whose target state already equals
  canonical state is an idempotent no-op even when its observed revision is old. If the target state
  would change, the observed revision must match or the API returns `CONVERSATION_CHANGED`.
- Delete accepts the observed revision in its JSON body, requires confirmation in the web UI, and
  returns no deleted content. A retry after successful deletion receives the same scoped not-found
  response as any absent or unowned conversation.
- Draft responses contain only scope, content, revision, and UTC update time. An absent draft is
  represented canonically as empty content at revision `0`; a read does not create a row.
- Draft saves provide the last observed draft revision. The first successful write inserts revision
  `1`; later writes increment it once. A stale save returns `DRAFT_CHANGED` and does not modify the
  row.
- Deliberately replacing a stale local draft is not a revision bypass. The browser first adopts the
  latest server revision, then sends the employee-confirmed local text against that revision. A
  second concurrent change can conflict again.
- Ordinary missing, cross-workspace, and other-employee conversations use the same scoped 404
  response. The API does not reveal that another employee's identifier exists.
- Malformed or cross-route cursors fail with a stable client error. Cursors are versioned,
  base64url-encoded server values and are never decoded or constructed by React.
- Phase 3 adds and centralizes only the stable ordinary errors it implements, including
  `CONVERSATION_CHANGED` and `DRAFT_CHANGED`. The complete v1 streaming-event and error catalog is
  still authored and approved after Phase 3 and before Phase 4, as required by the roadmap.

## Work plan

Work proceeds in this order. Each step must leave the application coherent and independently
verified before the next begins.

### 1. Preflight and Phase 2 gate

- Confirm Phase 2 is accepted, frozen, and reproducible from an exact commit or recorded baseline.
- Run the accepted Phase 2 root gates and browser suite before adding the Phase 3 migration.
- Confirm Docker and the isolated PostgreSQL test path are available.
- Inspect the existing schema, actor resolver, mutation security hook, error envelope, protocol
  exports, route registration, Query Client, routing tree, Spanish copy, and brand styles.
- Select and document the operational Phase 3 values listed under Required context.
- Confirm PostgreSQL in every supported development, CI, and future managed environment can install
  the standard `unaccent` extension required by the locked accent-insensitive search behavior.
- Confirm that no model, tier, stream, generation, usage, budget, compaction, administrator, or
  production-deployment choice is being pulled into this phase.
- Stop for direction if the accepted Phase 2 baseline is not reproducible or accent normalization
  would require a database capability outside the approved PostgreSQL boundary.

Deliverable: a short implementation record naming the exact Phase 2 baseline, selected operational
values, migration assumptions, and verification environment.

### 2. Conversation, message, and draft schema

- Add one committed expand-only migration for the Phase 3 schema. Never migrate during API startup.
- Add a `conversations` table with a UUID identifier, workspace identifier, owning Better Auth user
  identifier, nullable title, nullable selected-leaf identifier, nonnegative structural revision,
  nullable archive timestamp, and ordinary UTC creation/update timestamps.
- Add a `messages` table with a UUID identifier, conversation identifier, optional parent-message
  identifier, `user` or `assistant` role, typed JSON-block content, and a UTC creation timestamp.
- Enforce parent membership with a same-conversation composite foreign key rather than accepting
  any message identifier from another conversation.
- Add the selected-leaf foreign key after both tables exist and retain service-level validation that
  the selected message is an actual leaf. Do not add a process-local tree lock.
- Add a `drafts` table with workspace, employee, nullable conversation, text content, nonnegative
  revision, and UTC update timestamp.
- Enforce one draft per employee and conversation plus one null-conversation new-chat draft per
  employee and workspace using explicit PostgreSQL unique indexes. Do not rely on ordinary nullable
  uniqueness semantics.
- Cascade conversation deletion to messages and its conversation draft. Preserve the new-chat
  draft because it does not belong to the deleted conversation.
- Use database checks for nonnegative revisions, valid roles, JSON-array content shape, and
  non-empty stored titles. TypeBox and service validation remain authoritative for the complete
  one-text-block message shape.
- Add ownership and keyset indexes for active/archived conversation history, parent traversal,
  selected-branch reconstruction, sibling counts, and draft lookup.
- Do not add generation status, model tier, provider, token, cost, reservation, compaction,
  idempotency, soft-delete, sharing, or audit-event columns.
- Verify the complete migration history against an empty database and upgrade from the accepted
  Phase 2 schema. Do not rewrite Phase 2 migration files after acceptance.

### 3. PostgreSQL search representation

- Enable PostgreSQL's standard `unaccent` extension in the committed migration.
- Derive indexed `tsvector` values for stored conversation titles and the text block of each message
  using the `simple` text-search configuration, Unicode-preserving lowercase behavior, and accent
  normalization. Stored titles and content remain untouched.
- Keep any SQL normalization or JSON-text extraction function narrowly named, schema-qualified,
  deterministic for indexing, and committed with the migration. Do not introduce a general SQL
  utility layer.
- Add GIN indexes for title and message vectors. Derived placeholder titles and future compaction
  summaries are not indexed.
- Build search queries with bound parameters. Never interpolate employee search text into SQL or a
  raw `tsquery` expression.
- Support prefix matching on the final normalized search term while treating earlier terms as
  complete terms. Case and accents do not affect matching; Spanish stemming, fuzzy correction,
  trigrams, embeddings, and external search services remain absent.
- Rank title matches above message matches. Within equal match class and relevance, use conversation
  recency and stable identifiers as deterministic tie-breakers.
- Search every preserved message branch, including non-selected alternatives, and include archived
  conversations with an explicit archived flag.
- Resolve each message hit to a deterministic leaf containing it. Prefer the currently selected
  leaf when it descends from the match; otherwise choose the most recently created descendant leaf
  with the identifier as the final tie-breaker. A matching leaf resolves to itself.
- Return short snippets as typed plain-text segments with a highlight boolean. Never send HTML from
  `ts_headline` or render database-produced markup in React.
- Bind each opaque search cursor to the normalized query and ranking tuple so a cursor cannot be
  reused with another search.
- Verify query plans use the intended GIN and ownership indexes on representative non-sensitive test
  data. This is index verification, not Phase 8 load testing.

### 4. Conversation service and explicit queries

- Add one narrowly focused conversation feature area inside `apps/api` with plain service functions
  and explicit Drizzle or raw SQL queries.
- Resolve `RequestActor` at the route boundary and pass the immutable actor into every service
  operation. Never accept workspace or owner identifiers from request bodies or query strings.
- Create conversations with server-generated identifiers and canonical initial state. Do not create
  a conversation merely because the employee viewed the new-chat page or autosaved its null-scope
  draft.
- Reconstruct a selected branch through one bounded recursive PostgreSQL query beginning at the
  selected leaf and following parents. Return whole messages in reading order.
- Use opaque keyset cursors for active history, archived history, selected-branch ancestors, and
  search. Do not use offsets or fetch an employee's entire history.
- Use short transactions and row-level locking for structural mutations. Compare the observed
  revision in the mutation predicate, increment once on success, and distinguish scoped not-found
  from stale state without leaking another employee's record.
- Validate branch selection inside the same transaction that updates `selected_leaf_message_id`.
  An exact repeated selection returns canonical state without a write.
- Keep deterministic title construction as a pure, tested backend function. It collapses first-user
  message whitespace to a single display space, trims the result, and truncates by Unicode code
  point without splitting a surrogate pair. Phase 4 calls it in the first-message transaction.
- Rename only the stored title. It never modifies messages and never schedules title generation.
- Archive and unarchive preserve all content. Each successful state change advances revision and
  history update time; an exact no-op does neither.
- Delete the conversation, messages, derived search data, and conversation draft in one short
  transaction. No deleted content is returned or logged.
- Add no message-write HTTP route. Phase 3 database tests create valid immutable trees through
  isolated fixtures so selected-branch reads and search are real. Phase 4 owns authoritative user
  message, assistant placeholder, and generation creation.
- Keep queries feature-local. Do not create generic CRUD repositories, generic filter builders, or
  a recursive-tree abstraction beyond the concrete selected-branch and search queries.

### 5. Draft service and conflict behavior

- Implement canonical read and compare-and-swap save operations for both new-chat and owned
  conversation drafts.
- Normalize line endings to `\n`, reject null bytes and unsupported control characters, and enforce
  the selected storage byte limit without interpreting Markdown or fetching URLs.
- Preserve all other whitespace. Empty text is a valid saved draft and does not mean delete.
- Use one short insert-or-update transaction. Concurrent first writes from revision `0` result in
  one success and one `DRAFT_CHANGED`, not duplicate rows or last-write-wins behavior.
- Never hold a transaction while waiting for browser input. A deliberate replacement is a new CAS
  write against the latest observed server revision.
- Return `DRAFT_CHANGED` with the ordinary stable error envelope. React refetches the canonical
  draft; approval of local replacement remains an explicit employee action.
- Draft writes do not change conversation revision, selected leaf, title, archive state, or history
  ordering.
- Never place drafts in logs, error metadata, browser storage, analytics, URL parameters, or test
  snapshots.

### 6. Fastify routes and protocol contracts

- Add TypeBox schemas and inferred public types for text content blocks, conversation summaries,
  selected-branch pages, draft state and mutations, search snippets and results, opaque paginated
  responses, revision-bearing mutations, and the route requests listed above.
- Reuse schemas deliberately; do not create a second DTO type beside a TypeBox transport schema.
- Keep content schemas extensible as a discriminated block array while implementing exactly one text
  block for v1.
- Add a centralized stable-error constant/type home without narrowing the error envelope so tightly
  that immediately preceding web builds cannot receive additive codes. Move currently implemented
  stable foundation and identity codes into that same home as a small mechanical consistency change.
- Register the explicit search route without allowing `search` to be interpreted as a conversation
  identifier.
- Apply the Phase 2 member actor and mutation security boundary to every new route. Do not duplicate
  session parsing or membership queries inside the conversation feature.
- Apply route-specific body and query limits. Search queries, titles, drafts, identifiers, cursors,
  and revision numbers are validated before service execution.
- Return `Cache-Control: no-store` for employee conversation, search, and draft responses.
- Preserve every `Set-Cookie` header returned while resolving a sliding Better Auth session, using
  the existing session-forwarding pattern.
- Keep errors and request logs metadata-only. Route templates, status, request ID, timing, actor-free
  operational identifiers, and safe error codes may be logged; titles, search terms, snippets,
  drafts, and message content may not.
- Do not add NDJSON, server-sent events, WebSockets, provider schemas, generation events, or stream
  parsing to `packages/protocol`.

### 7. Branded conversation shell

- Replace the Phase 2 protected checkpoint with the real authenticated application shell while
  preserving all public identity and account-security routes.
- Use React Router for these Phase 3 product URLs:
  - `/` for the new-chat draft;
  - `/c/:conversationId` for an owned conversation;
  - `/search` with search text held only in memory; and
  - `/archived` for archived access.
- Keep `/account/security` protected and reachable through the employee menu. Do not add `/admin`.
- Desktop uses a collapsible left sidebar and one main content area. The sidebar contains the
  Capstone identity, **Nuevo chat**, search, incrementally loaded recent history, archived access,
  and the employee/account menu.
- Mobile uses a compact header and a modal sidebar drawer. Use browser-native dialog behavior where
  practical, restore focus to the opener, close on Escape, prevent background interaction, and keep
  every action keyboard accessible.
- Persist only the desktop collapsed preference locally. Mobile drawer state remains component
  state. Never put conversation identifiers, titles, drafts, messages, session data, or query cache
  in browser storage.
- The conversation header contains the current title and only Phase 3 actions: rename, archive or
  unarchive, and delete. Do not show a model picker, edit, retry, undo, branch, copy, or disabled
  future control.
- The new-chat route displays the approved restrained Capstone symbol, **¿En qué puedo ayudarte?**,
  and a plain-text draft editor with primary focus. Phase 3 saves the draft but renders no Send or
  Stop action; Phase 4 adds sending as a complete behavior rather than a disabled placeholder.
- An empty conversation renders the same calm draft-focused state with the localized new-chat title.
- Existing selected-branch messages render as safe plain text with preserved line breaks and
  programmatic user/assistant labels. Phase 3 does not render Markdown, mathematics, syntax
  highlighting, raw HTML, copy actions, or the final response layout.
- Use TanStack infinite queries for recent, archived, selected-branch, and search pagination. Merge
  pages by stable identifier so an item moved by a concurrent update is not duplicated visually.
- Opening a conversation loads only the recent selected-branch page. Loading older ancestors at the
  top preserves the current viewport. Do not add message-list virtualization.
- Search requests debounce by the selected interval and abort obsolete fetches. The input lives in
  component and TanStack Query memory and is sent in the JSON request body, never the browser URL.
  Results identify
  title or message matches, render typed highlight segments, and visibly label archived results.
- Opening a search result first persists its resolved branch leaf when needed, refetches canonical
  state, then navigates to the conversation. It never unarchives the conversation. Phase 5 adds the
  final scroll-and-highlight treatment and general branch controls.
- Rename, archive, unarchive, and delete use server-returned canonical state instead of duplicating
  business rules in React. A stale mutation preserves the current local draft, refetches the
  conversation, and asks the employee to retry.
- Deletion uses an accessible confirmation that clearly states active deletion is irreversible and
  that inaccessible encrypted backups may retain content until finite retention expires. On success,
  remove cached content and navigate to the new-chat route.
- Keep all interface copy in the centralized Spanish TypeScript module. Use brand semantic
  variables, established typography, visible focus, restrained motion, and reduced-motion behavior.
- Preserve the Phase 1 availability indicator without allowing per-token or conversation content to
  enter status announcements. Production cadence remains a later load-tuning concern.

### 8. Draft browser behavior

- TanStack Query owns canonical server draft state. The active editor keeps immediate text in React
  memory and never waits for a network response before reflecting a keystroke.
- Autosave only after typing pauses for the selected debounce interval. One draft save per scope may
  be in flight; newer edits coalesce into the next save.
- A successful save adopts the returned revision only if it corresponds to the content submitted.
  It must not mark newer local text as saved.
- A failed save leaves typing uninterrupted, shows a small programmatic unsaved state, and retries
  only after another edit or an explicit retry. Do not build a background retry scheduler.
- On reconnection, an in-memory dirty draft becomes eligible to save again.
- On `DRAFT_CHANGED`, stop automatic saves for that scope and present the two approved choices:
  accept the server draft, or deliberately replace it with the local draft against the newest server
  revision.
- Conversation actions and navigation do not silently discard a dirty local draft. Attempt a final
  ordinary save where safe; if it cannot be confirmed, preserve the text in the current in-memory
  session and make the unsaved state visible.
- Reloading or closing the tab may lose text that never reached Fastify. Do not add localStorage,
  IndexedDB, a service worker, `sendBeacon`, or persistent query caching to conceal that boundary.
- Respect desktop and mobile keyboard behavior structurally, but do not implement Enter-to-send,
  Shift+Enter sending logic, IME submission guards, or active-generation composer behavior until
  Phase 4.

### 9. Automated verification

- Use Vitest for title normalization, cursor encoding/validation, revision helpers, draft state,
  protocol contracts, search-snippet parsing, query utilities, and deterministic shell behavior.
- Use Fastify injection for ordinary route authorization, schemas, errors, headers, pagination, and
  mutation behavior.
- Use Testcontainers PostgreSQL and the real migration history for ownership, recursive branches,
  concurrent revisions, nullable-draft uniqueness, full-text search, deletion, and index behavior.
  Do not mock the database boundary.
- Use Playwright for the authenticated shell, responsive drawer, history, archive, search, draft,
  conflict, and deletion flows. The browser suite may prepare deterministic immutable message trees
  directly through its isolated test database; no test-only HTTP route exists in the application.
- Keep all fixtures synthetic and specifically written to detect accidental content logging.

Required Phase 3 cases:

- Every migration applies to an empty database and upgrades the accepted Phase 2 schema.
- Conversations and drafts cannot cross workspace or employee ownership, including when the actor
  is an administrator.
- A parent message from another conversation is rejected by database constraints.
- Root and alternating-role invariants are enforced by the conversation write boundary used by
  fixtures and future turn creation.
- A selected leaf from another conversation, a non-leaf selection, and an unowned leaf are rejected.
- Empty conversations return no messages and no search results.
- The selected branch reconstructs correctly through deep histories and returns whole messages in
  reading order.
- Message cursors cannot be reused after the selected leaf or structural revision changes.
- Recent and archived history use stable keyset pagination, deterministic ordering, and no offset.
- Equal timestamps do not produce missing or duplicate records within a canonical page sequence.
- Rename, selection, archive, unarchive, and delete reject stale revisions with
  `CONVERSATION_CHANGED`.
- Selecting the already selected leaf and requesting an already-current archive state are no-ops
  that do not increment revision.
- The deterministic initial title collapses whitespace, truncates safely, never calls a model, and
  does not overwrite a manual title.
- New-chat and conversation drafts are unique, survive API restarts, preserve whitespace, and use
  independent compare-and-swap revisions.
- Concurrent first draft writes create one row, return one success and one `DRAFT_CHANGED`, and lose
  no acknowledged write.
- A stale draft stops autosaving and both employee choices behave exactly as documented.
- Draft saves do not alter conversation revision or recent-history order.
- Search is case- and accent-insensitive, uses `simple` configuration, prefix-matches only the final
  term, and does not apply Spanish stemming or fuzzy matching.
- Title matches rank above message matches; relevance precedes recency; cursor pagination is stable.
- Search covers alternative branches and archived conversations, labels archived results, returns
  safe highlighted segments, and never includes full message bodies as snippets.
- A search hit resolves to the selected descendant when possible and otherwise to the deterministic
  most-recent descendant leaf.
- Opening an already-selected search branch leaves revision unchanged; selecting another result
  branch increments it once and persists across reload.
- Opening an archived result does not unarchive it.
- Conversation deletion removes messages, title, branch selection, conversation draft, and derived
  search visibility immediately while preserving the unrelated new-chat draft.
- Scoped not-found responses do not reveal another employee's conversation, message, or draft.
- Search text, titles, snippets, drafts, and message content do not appear in captured request or
  error logs.
- The desktop shell, mobile drawer, menus, dialogs, draft conflict, error states, loading states,
  focus behavior, keyboard behavior, and reduced-motion behavior pass Phase 3 accessibility checks.
- No browser storage contains conversation content or identity data; only the approved sidebar
  presentation preference may persist locally.

### 10. CI, container, and documentation

- Extend the existing root scripts and GitHub Actions jobs. Do not introduce another workflow or
  task runner.
- Keep format/lint, strict type checking, protocol and unit tests, PostgreSQL integration tests,
  clean migrations, production builds, the API image, and separate Playwright execution visible.
- Verify the production API image contains the new committed migration and still runs as the
  non-root `node` user.
- Document the Phase 3 migration, authenticated application URLs, draft behavior, conflict recovery,
  archive/unarchive, permanent deletion, search behavior, pagination, and troubleshooting steps.
- Document that the product cannot send or generate an answer until Phase 4. Do not make the
  draft-only checkpoint look launch-capable.
- Record the selected operational values and the exact Phase 2 baseline in this plan's
  implementation record when coding begins.
- Keep examples synthetic. Documentation never includes real employee prompts, conversation text,
  identifiers, or credentials.

## Phase boundary

The following are explicitly forbidden in Phase 3, including as placeholders, disabled controls,
empty tables, generic abstractions, preinstalled dependencies, or speculative compatibility layers
unless the Conversation core work above itself requires them.

### Phase 1 — Foundation

- Do not replace pnpm, TypeScript, Biome, Fastify construction, PostgreSQL pool, migration runner,
  error envelope, React Router, TanStack Query, brand packaging, test strategy, CI, or container
  patterns with parallel systems.
- Do not move migrations into API startup or add a second database-access layer.

### Phase 2 — Identity

- Reuse the accepted Better Auth instance, actor resolver, member authorization, exact-Origin
  boundary, session query, and identity routes.
- Do not redesign authentication, add an identity provider, modify approval or membership lifecycle,
  create an administrator bypass for conversation ownership, or revisit the approved local-email
  amendment.
- Identity refactoring is allowed only when directly required to forward session headers or
  centralize stable errors for conversation routes, and must remain small and covered.

### Phase 4 — Streaming chat

- No `ModelGateway`, `FakeModelGateway`, assistant placeholder creation, generation table, active
  generation rule, idempotency record, NDJSON catalog or parser, streaming route, `ChatRuntime`,
  delta accumulator, abort controller, cancellation, checkpoint, backpressure, terminal outcome,
  interruption recovery, reconciler, Send behavior, Stop behavior, or Continue behavior.
- Do not consume a draft or persist a user message through a temporary non-streaming send endpoint.
- The complete v1 stream-event and stable error catalog is a separate approval artifact immediately
  before Phase 4; Phase 3 does not silently decide it.

### Phase 5 — Conversation controls and rendering

- No user-message editing, try again, undo, general branch navigation controls, answer copying, code
  copying, Markdown rendering, mathematics, syntax highlighting, streaming scroll-follow controller,
  jump-to-latest behavior, response-format gallery, or visual branch switcher.
- Phase 3 may persist a leaf selected by an exact search result because search correctness requires
  it. That narrow action does not authorize general branch navigation UI.

### Phase 6 — OpenRouter and cost control

- No OpenRouter dependency or key, model gateway, model catalog, tier enum or picker, provider or
  model identifier, ZDR call, generation accounting, usage table, pricing, budget, reservation,
  settlement, cancellation accounting, or reconciliation.
- Conversation schema does not add a preferred tier until the milestone that can enforce tier
  availability and generation behavior.

### Phase 7 — Compaction and administration

- No compaction table, summary, prompt, fallback, or search indexing.
- No `/admin` route, administrative navigation, employee HTTP administration, model policy, tier
  controls, budget controls, usage view, or session-management dashboard.
- Administrators remain unable to read another employee's conversation content.

### Phase 8 — Production hardening

- No OpenTelemetry SDK, browser telemetry, frontend-error ingestion endpoint, observability vendor,
  load-test system, deployment platform, static-host or edge configuration, secret-manager adapter,
  backup automation, or disaster-recovery automation.
- Phase 3 uses indexed and bounded queries and records future tuning needs; it does not claim
  production-scale validation.

### Conversation features outside approved v1 scope

- No sharing, public links, exports, imports, folders, tags, favorites, pinning, bulk actions,
  recycle bin, administrator restore, administrator content search, collaborative editing, presence,
  comments, attachments, document retrieval, browser storage, offline mode, or semantic search.
- No raw HTML, scripts, iframes, embeds, provider-specific content, or content type beyond one text
  block.

## Acceptance procedure

From the frozen, accepted Phase 2 baseline with Docker available:

1. Install dependencies with the repository-pinned pnpm version and run the accepted Phase 2 gates.
2. Start isolated PostgreSQL and apply the complete migration history to an empty database and to a
   Phase 2-shaped database.
3. Inspect constraints and indexes for conversation ownership, same-conversation parents,
   selected leaves, drafts, history ordering, and full-text search.
4. Start Fastify and Vite, sign in as a synthetic approved employee, and confirm the protected root
   is the responsive Capstone conversation shell rather than the Phase 2 checkpoint.
5. Type in the new-chat draft, wait for autosave, reload the browser and API, and confirm the text and
   revision survive without appearing in browser storage.
6. Open the same draft in two browser contexts, create a stale write, and confirm autosave stops with
   the explicit server-draft and local-draft choices.
7. Create deterministic owned conversation and branch fixtures through the isolated test setup;
   confirm recent history pages incrementally in stable most-recent order.
8. Open a conversation, confirm only the recent selected branch loads, and load older ancestors
   without moving the current viewport.
9. Rename a conversation and verify stale rename, archive, selection, and deletion attempts preserve
   canonical state and return `CONVERSATION_CHANGED`.
10. Archive and unarchive a conversation; confirm it moves between normal and archived history
    without losing its branch or draft.
11. Search mixed-case and accented synthetic titles and messages, type a prefix, and confirm title
    ranking, short highlighted segments, archived labels, and stable cursor pagination.
12. Search a non-selected alternative, open it, and confirm the resolved leaf becomes selected and
    increments revision exactly once. Reopen it and confirm revision does not change.
13. Open an archived search result and confirm the exact branch opens without unarchiving it.
14. Sign in as a second member and an administrator; confirm neither can list, read, search, mutate,
    draft against, or infer the first employee's conversations.
15. Permanently delete a conversation through the accessible confirmation and verify its messages,
    draft, title, branch, and search visibility are gone while accounting tables remain absent.
16. Inspect captured logs while listing, drafting, searching, renaming, and deleting; confirm no
    title, query, snippet, draft, or message content appears.
17. Verify desktop collapse, mobile modal drawer, focus restoration, keyboard navigation, loading,
    empty, conflict, error, and reduced-motion behavior.
18. Run `pnpm check`.
19. Run `pnpm typecheck`.
20. Run `pnpm test`.
21. Run the separate Playwright Phase 3 browser suite.
22. Run `pnpm build` and build the production API image.
23. Run `git diff --check` and review the migration, dependencies, routes, protocol, UI, tests, and
    documentation for forbidden Phase 4–8 work.

## Definition of done

Phase 3 is complete only when:

- The accepted Phase 2 baseline remains reproducible and every required Phase 3 gate succeeds.
- The committed migration history adds only conversation, message, draft, and required PostgreSQL
  search structures, and upgrades cleanly from Phase 2.
- Every conversation and draft query is scoped to the authenticated employee and workspace;
  administrator status grants no content access.
- PostgreSQL represents a valid parent-linked message tree, canonical selected leaf, structural
  revision, archive state, and independent draft revision without process-local authority.
- Active and archived history, selected-branch messages, and search use bounded opaque cursor
  pagination and appropriate indexes rather than offsets or full-history reads.
- Search is case- and accent-insensitive, language-neutral, prefix-aware, branch-complete,
  archive-aware, deterministically ranked, and safe to render without HTML.
- Rename, branch selection, archive, unarchive, and deletion reject stale structural state rather
  than silently changing an outdated conversation.
- New-chat and conversation drafts autosave through Fastify, detect stale writers, recover through
  explicit employee choice, and never use persistent browser storage.
- The branded responsive shell provides new chat, search, recent history, archived access,
  account access, conversation management, and permanent-deletion confirmation in centralized
  Spanish copy.
- The draft-only Phase 3 checkpoint is honest: it contains no fake answer, fake stream, temporary
  send path, disabled model picker, or placeholder control from a later milestone.
- Tests cover migrations, ownership, branches, revisions, pagination, drafts, search, deletion,
  privacy-safe logging, browser behavior, and accessibility against real PostgreSQL where required.
- Documentation lets another developer reproduce the Phase 3 shell and every conversation-core
  operation without unstated database or browser steps.
- The final diff contains no Phase 4–8 schema, dependency, route, UI, background process, provider,
  or placeholder architecture.
- Any failed or unavailable verification is reported explicitly rather than treated as complete.

Completion of Phase 3 authorizes no automatic work on Phase 4. The complete NDJSON event and stable
error-code catalog is authored and approved after Phase 3 acceptance, and Phase 4 begins only after
its own plan and code authorization are explicitly approved.
