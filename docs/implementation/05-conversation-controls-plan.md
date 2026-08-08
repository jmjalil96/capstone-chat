# Phase 5 — Conversation Controls Implementation Plan

Status: implemented; verification complete; accepted baseline for Phase 6

Code authorization: granted by the user on 2026-08-07

## Planning record

- Planning began on 2026-08-07 after the user accepted Phase 4 and asked to move to Phase 5.
- The cross-phase correction pass was reviewed and frozen before Phase 5 implementation as commit
  `ba88f12` (`Finalize cross-phase correction pass`). Phase 5 builds only on that identified commit.
- The frozen baseline passed 414 protocol, API/PostgreSQL, and web tests: 131 protocol, 161 API,
  and 122 web. Strict TypeScript, production builds, `git diff --check`, the repository-scoped
  Biome check over all 163 applicable files, and all 22 Playwright scenarios passed. The production
  API image ran as non-root UID 1000 and contained all three migrations.
- The literal local `pnpm check` exception remains limited to the globally ignored
  `.claude/settings.local.json`. That unrelated local file is not repository or CI state and remains
  outside Phase 5 scope.
- Phase 5 planning remained documentation-only until the user granted implementation authorization.
  The implementation now proceeds from the frozen baseline under this approved boundary.
- Current primary package documentation and registry metadata were checked for the proposed web
  rendering stack. The compatible direct versions current at planning time are
  `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `remark-math@6.0.0`,
  `rehype-katex@7.0.1`, `rehype-highlight@7.0.2`, and `highlight.js@11.11.1`.
  `rehype-katex@7.0.1` accepts KaTeX `^0.16.0` and therefore resolves `katex@0.16.47`, not the
  unrelated current `0.18.x` line. Implementation must recheck compatibility before installation
  and must not upgrade unrelated packages.

## Implementation record

- Implementation completed on 2026-08-07 against the frozen `ba88f12` Phase 4 baseline. The
  protocol now adds bounded alternative-context metadata, revision-safe Undo, and edit/retry
  response-source variants without changing the accepted response route or stream event catalog.
  A post-push acceptance review then identified one streaming-scroll race and two Phase 5
  correctness/accessibility gaps; the correction described below remains inside the approved
  milestone and adds no dependency or migration.
- Fastify resolves edit, retry, adjacent branches, and Undo from the authenticated employee's
  selected immutable tree. Edit inserts one user sibling and assistant; retry reuses the stored user
  and inserts only an assistant sibling. Both preserve title and ordinary draft, use the existing
  idempotent generation transaction, and keep gateway waits outside PostgreSQL transactions.
- The browser adds revision-scoped alternative queries, inline edit, retry, Undo, exact-source
  message/code copy, branch-aware optimistic presentation, deep search positioning, and one
  conversation-scoped scroll controller. Canonical recovery invalidates all revision-bearing
  conversation views and preserves action focus or search intent across stale races. A focused
  pre-mutation selection fence captures every content-tree update before React replaces selected
  nodes, disengages following before the parent layout effect, and restores the same visible text
  through incremental Markdown, canonical reconciliation, and terminal action insertion. Its
  bounded context exists only in a private commit field cleared before the layout callback; retained
  scroll state contains positions only. Inline-edit validation now has a stable `aria-describedby`
  association, including the unchanged-content state.
- Alternative-context reads now stop at selected-path membership, sibling order, and adjacent
  sibling targets. They do not recursively materialize off-path descendants. The historical
  leaf-named wire fields remain compatible; exact newest-descendant resolution happens only after
  explicit branch activation, outside the short selection transaction, and the locked transaction
  rechecks ownership, active generation, and structural revision before updating selection.
- The renderer uses the exact approved direct dependencies: `react-markdown@10.1.0`,
  `remark-gfm@4.0.1`, `remark-math@6.0.0`, `rehype-katex@7.0.1`,
  `rehype-highlight@7.0.2`, and `highlight.js@11.11.1`; the lockfile resolves transitive
  `katex@0.16.47`. Raw HTML and media are suppressed, destinations are protocol-allowlisted,
  highlighting registers only the ten committed grammars, KaTeX emits MathML only, and renderer
  failure/error metadata contains no employee content. Hidden MathML source annotations are excluded
  from selection coordinates, while visible formula text remains selectable.
- The renderer remains behind one direct lazy boundary. The final corrected production output is
  `865.02 kB` raw / `249.24 kB` gzip for initial JavaScript, `628.70 kB` /
  `191.93 kB` for deferred renderer JavaScript, `30.24 kB` / `5.67 kB` for initial CSS, and
  `4.86 kB` / `1.19 kB` for renderer CSS. Against the accepted Phase 4 initial JavaScript
  (`833.70 kB` / `238.43 kB`), the initial delta is `31.32 kB` raw / `10.81 kB` gzip; the renderer
  payload is not requested before a conversation message is rendered. Vite retains its expected
  advisory for chunks above 500 kB.
- Deferred-render readiness fences initial/search positioning. Active-stream layout growth is
  observed on the message list so font, renderer, and canonical subtree reflow follows only while
  the employee remains engaged; trusted scrolling and selection disengage it, retained selections
  survive explicit Jump re-engagement, and terminal reconciliation cannot force movement. Selection
  indexing is one pruned DOM pass per distinct selected root and never scans or stores a full
  conversation tree.
- Synthetic browser fixtures are inserted through the isolated migrated database before the test
  API listens. Phase 5 uses a seeded signed Better Auth session cookie so parallel coverage does not
  consume the identity sign-in rate limit; no production or test-only HTTP route was added.
- Final corrected automated verification passed 488 tests: 146 protocol, 165 API/PostgreSQL, and
  177 web. Strict TypeScript and all production builds passed. The formerly flaky Chromium
  selection scenario passed 20/20 repetitions with five workers in 40.1 seconds. The configured
  Playwright matrix then passed 25/25 in 26.8 seconds: 15 Chromium scenarios plus five critical
  scenarios each in Firefox and WebKit, including renderer security/overflow, copy/focus,
  edit/retry/Undo/branch persistence, deep search, and smart scroll.
- The adversarial 32 KiB selection benchmark over 4,096 highlighted spans preserves the exact
  range and settles at 9.1–9.6 milliseconds per update after warm-up, below one 60 Hz frame.
- `pnpm install --frozen-lockfile`, the repository-scoped Biome check over all 180 applicable files,
  and `git diff --check` passed. Literal `pnpm check` still reports only the pre-existing globally
  ignored `.claude/settings.local.json`; repository and CI inputs are clean.
- `pnpm audit --prod --audit-level high` passed its high/critical gate and reports one retained
  moderate esbuild development-server advisory through Better Auth's pre-existing Drizzle Kit
  toolchain. The same `esbuild@0.18.20` path exists in `ba88f12`; Phase 5 neither introduced nor
  broadened it, and no unrelated dependency override was added.
- Phase 5 adds no migration. The API/PostgreSQL suite applies all three migrations to clean
  databases and exercises the accepted upgrade/retry paths. The production API image built
  successfully, runs as `node` UID/GID 1000, and contains exactly migrations `0000`–`0002`.
- The 1,667-line `ConversationPage` remains a valid maintainability watchpoint, not an acceptance
  defect. The required renderer, message-action, scroll, and selection-fence boundaries are already
  extracted; a search/selection/controller split would be a broad, timing-sensitive refactor with
  substantial dependency plumbing. It is intentionally left out of this correctness correction and
  should be handled, if chosen, as a dedicated behavior-neutral change with its own verification
  cycle.
- The corrected diff contains no OpenRouter/provider integration, tier policy, cost/budget,
  compaction, administration, telemetry, production platform, content logging, or test-only route.
- The user accepted the final corrected Phase 5 baseline on 2026-08-08 by authorizing Phase 6
  implementation against commit `fc67d41` (`Harden browser scroll race handling`).

## Objective

Complete the employee-facing conversation experience on top of the accepted streaming boundary.
An authenticated employee can edit an earlier user message, try any preserved answer again, undo
the latest selected turn, move between preserved alternatives, read safely rendered Markdown and
mathematics, copy messages and code, and remain in control of scrolling while a response streams.

Phase 5 turns the existing immutable message tree into a complete, navigable chat experience. It
does not connect OpenRouter, expose model mappings or a tier picker, record costs, compact context,
add administration, or claim production hardening.

The plan and code authorization are now granted against the exact corrected Phase 4 baseline. They
authorize only the Phase 5 interpretations and work boundary below.

## Plan approval decisions

Approval of this plan locks the following Phase 5 interpretations. They close the implementation
gaps required by the roadmap without moving Phase 6 or later work forward.

1. Phase 5 continues to generate only through the accepted `FakeModelGateway` and the literal
   `balanced` request tier. Edit and Try again carry the existing `modelTier` field, but its only
   accepted value remains `balanced`. The three-tier picker, preferred-tier persistence, enabled-tier
   policy, mappings, and OpenRouter arrive together in Phase 6.
2. The existing streaming `POST /api/conversations/:conversationId/responses` remains the single
   response-generation route. Its discriminated request union gains `edit` and `retry` sources;
   Phase 5 does not add parallel streaming endpoints or another runtime.
3. Editing targets one user message on the currently selected path. The request includes the target
   user ID, its observed parent, new text, current conversation revision, and fixed Phase 5 tier.
   Fastify verifies all of them, creates a new user sibling plus assistant child atomically, selects
   the new assistant, and starts one generation. The original user message and every descendant
   remain unchanged.
4. Try again targets one assistant message on the currently selected path. Fastify verifies the
   target and its user parent, reuses the stored user message as the model request, creates only a
   new assistant sibling and generation, and selects that assistant. It never duplicates or rewrites
   the user message.
5. Edit and Try again may target an earlier visible message, not only the selected endpoint. The new
   branch replaces the visible suffix after that target while preserving the old suffix as another
   selectable branch.
6. Edit and Try again use the accepted generation idempotency and recovery behavior. Their turn
   creation is one short PostgreSQL transaction; gateway and browser waits remain outside it. An
   ambiguous start is never retried automatically, and explicit recovery reuses the original
   idempotency key.
7. The ordinary conversation draft is independent from edit and retry actions. Editing uses a
   temporary in-memory inline editor, and neither edit nor Try again consumes, replaces, or blocks
   autosaving the employee's next-message draft. Draft typing and autosave continue while a
   generation is active; only submission and conflicting structural actions remain blocked. Phase 5
   adds no second draft table or browser persistence.
8. Editing the first user message does not rename the conversation. Only the accepted initial-send
   path may create the deterministic initial title, and a manually renamed title remains untouched.
9. Undo means moving the selected path endpoint backward by one complete user/assistant turn. From
   a selected assistant response, Fastify selects the nearest earlier assistant ancestor. Undo is
   unavailable for the first turn, deletes nothing, creates no generation, preserves the draft, and
   increments the structural revision exactly once.
10. The historical `selected_leaf_message_id` and selection route names remain for compatibility,
    but Undo may intentionally make that column point to an assistant node that has preserved
    descendants. It remains the endpoint of the selected visible path even when it is not a graph-
    theoretic leaf. No schema rename or migration is needed.
    Search treats that endpoint as the selected visible-path leaf: a match already on its ancestor
    path resolves to the current endpoint even when it has descendants, while a match outside the
    selected path resolves a deterministic descendant graph leaf.
11. Alternative controls appear on user and assistant messages that have siblings. Metadata for the
    loaded messages is fetched in sorted, deduplicated chunks of at most 40 IDs, naturally aligned
    with detail pages—not one request per message, one unbounded aggregate, or a full tree. Each
    entry reports its one-based position, total siblings, and previous and next adjacent sibling
    targets. Automatic metadata reads do not walk either target's descendants.
12. Selecting an adjacent alternative opens a complete concrete branch. Only after explicit
    activation does Fastify resolve a target with descendants to the most recently created
    descendant graph leaf, ordered by `created_at` and then ID for deterministic ties. That
    immutable-tree read occurs outside the short selection transaction; the transaction rechecks
    ownership, active generation, and revision before committing. Selecting the already selected
    endpoint remains a no-op; selecting another branch increments the revision once.
13. Branch selection and Undo are blocked while a generation is active. They remain available in an
    archived conversation because they only select preserved content. Edit and Try again require an
    active, unarchived conversation because they create a generation. Copy remains available for
    stable content regardless of archive state. Composer typing and draft autosave remain available
    throughout generation.
14. `ChatRuntime` remains the only owner of active generation presentation. For edit and retry, it
    records the branch anchor and presents only the canonical prefix through that anchor plus the
    newly committed optimistic messages. It never temporarily appends the new branch after the old
    suffix.
15. Both employee and assistant text use one safe Markdown renderer. Phase 5 adds
    `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, `rehype-highlight`, and
    `highlight.js` as exact direct web dependencies only. The direct `highlight.js` declaration is
    required because application code imports only the approved grammar modules; KaTeX remains the
    pinned transitive renderer owned by `rehype-katex`. Phase 5 does not add MDX, an HTML sanitizer
    pipeline, a second parser, a server renderer, or a generalized component library.
16. Raw HTML is never parsed or mounted. Images and other embedded media are never created or
    fetched from Markdown. Links allow only `http:`, `https:`, and `mailto:`, open separately, and
    receive `noopener noreferrer`; unsafe, relative, fragment-only, `data:`, `file:`, and
    `javascript:` destinations render as non-clickable text.
17. Syntax highlighting is local and deterministic. The initial recognized set is JavaScript,
    TypeScript, JSON, Bash, Python, SQL, CSS, HTML/XML, Markdown, and YAML. Unknown or missing
    language labels remain readable plain monospace code; highlighting uses `detect: false`, and no
    grammar, asset, or content is fetched at runtime. Approved labels and aliases are filtered before
    highlighting, and only those exact grammar modules are registered.
18. KaTeX renders inline and block mathematics as MathML-only output compatible with the intended
    `style-src 'self'` static-host policy without CSS `style` attributes. The API's current CSP stays
    unchanged; production enforcement on the SPA document remains Phase 8. KaTeX uses `trust: false`,
    `strict: "ignore"`, `maxSize: 20`, `maxExpand: 1000`, no shared/custom macros, and non-fatal
    invalid-input handling. Any error-node inline style emitted by the adapter is removed before
    React rendering and replaced by a committed `.katex-error` class rule. Invalid math remains
    readable and must not crash the conversation, issue a content-bearing console warning, or
    weaken CSP.
19. Copy answer writes the complete currently stable assistant source as original Markdown. Copy
    user message writes its stored source. Copy code writes the exact fenced payload without fence
    markers while preserving internal whitespace and normalized line endings. Clipboard failure is
    an explicit localized UI state; no legacy `execCommand` fallback or content logging is added.
20. Smart stream following uses a centralized 96 CSS-pixel near-bottom threshold. Stream batches
    use pre-publication geometry and follow with non-animated scroll only while engaged, so one large
    content-growth frame cannot falsely disengage following. Manual upward scroll or a non-collapsed
    text selection inside the conversation disengages following. Manually returning near the bottom
    or activating the floating Jump to latest control re-engages it.
21. Completion, cancellation, and failure never force a scroll. The Jump to latest control appears
    only when new streamed content arrived while following was disengaged. Its explicit movement may
    be smooth, but reduced-motion mode uses immediate movement and per-token updates never start
    repeated smooth animations.
22. Opening a message search result carries only the matched message ID in route state. The
    conversation page validates and copies that ID into route-scoped controller state, immediately
    consumes the history-entry state, then loads older selected-branch pages until that message is
    present, scrolls it into view, and marks it briefly.
    The marker holds for 1,560 ms and fades with the approved 520 ms brand duration; reduced-motion
    mode keeps the static marker for the same hold and removes the fade.
23. The fixed response-format gallery is deterministic test data rendered through the ordinary
    conversation screen. It is seeded only by the isolated Playwright harness and creates no
    production route, test-only API endpoint, public fixture, or runtime switch.
24. Markdown headings preserve their relative semantic order without competing with the route's
    single page heading: source levels one through five render as HTML levels two through six, and
    source level six remains level six. Styling follows the authored source level through explicit
    renderer components rather than inferred HTML size.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its decision policy.
3. `docs/prd/01-product-scope-and-experience.md` in full, especially Conversations and history,
   Composer behavior, Generation experience, Streaming scroll behavior, Connection loss, Response
   presentation, Model selection, Product language, privacy, and retention.
4. `docs/prd/02-system-architecture-and-data.md` in full, especially API compatibility, browser and
   backend responsibilities, frontend state ownership, immutable conversation storage, optimistic
   revisions, pagination, browser security, privacy, verification, and observability boundaries.
5. `docs/prd/03-conversation-model-and-streaming.md` in full, especially authoritative context,
   user-message validation, edit and try-again behavior, terminal outcomes, concurrency, and the
   Phase 6/7 model-policy and compaction boundaries.
6. `docs/prd/04-cost-control-and-reliability.md` for idempotency, ambiguous failure, partial-answer
   recovery, cancellation, Try again, and the accounting work that must remain Phase 6.
7. `docs/prd/05-brand-system.md` for typography, semantic color, calm presentation, focus,
   keyboard access, reduced motion, status announcements, and WCAG 2.2 AA.
8. `docs/prd/06-development-roadmap.md`, especially the Phase 5 checkpoint and Phase 6–8 order.
9. `docs/implementation/01-foundation-plan.md` through
   `docs/implementation/04-streaming-chat-plan.md`, including every accepted implementation record
   and post-review amendment.
10. Current protocol conversation, generation, response-state, stream, and error schemas; migration
    history; conversation and generation services; routes; actor and ownership predicates; query
    scoping; `ChatRuntime`; stream parser; draft memory; request lifetimes; conversation page;
    search opening; copy module; styles; FakeModelGateway; test harnesses; CI; and container.
11. Current official documentation for each proposed renderer dependency and its security behavior,
    plus the repository's current React, TypeScript, Vite, and Node compatibility.
12. Current `git status`, the exact accepted Phase 4 commit, and its final verification record.

Phase 5 begins only from the frozen Phase 4 baseline. Phase 5 work must not be mixed with an
unidentified Phase 4 correction or unrelated cleanup.

At implementation start, re-confirm and record these Phase 5 presentation values:

- 96 CSS pixels for near-bottom stream following, evaluated from pre-growth geometry;
- 1,560 ms search-match hold and 520 ms fade;
- the recognized syntax-language set approved above;
- the fixed desktop and narrow gallery viewports;
- copy-success status duration, if an automatic reset is needed; and
- maximum alternative-context IDs per request chunk, which must remain aligned with the accepted
  selected-branch page size of 40.

These are presentation and bounded-request values, not model, cost, retention, or security policy.
Keep them named, centralized, and covered. Stop for approval if implementation evidence requires a
change that materially affects product behavior, privacy, security, cost, or later-phase scope.

Phase 5 does not need an OpenRouter model, model price, ZDR validation call, tier mapping, workspace
budget, reservation, accounting field, compaction threshold, administration contract, deployment
venue, observability destination, or load-tested production limit.

## Dependency direction

```text
apps/web ──JSON + NDJSON/fetch──> apps/api ──Drizzle/node-postgres──> PostgreSQL
   │                                  │
   ├─────────────────────────────────> packages/protocol
   └─────────────────────────────────> packages/brand

apps/api ────────────────────────────> packages/protocol
                │
                `──> ModelGateway ──> FakeModelGateway

apps/web message presentation
   `──> react-markdown
         ├── remark-gfm
         ├── remark-math -> rehype-katex -> MathML-only KaTeX output
         `── rehype-highlight -> explicit highlight.js grammar modules
```

- React owns controls, copy, safe rendering, temporary inline-edit state, and scroll interaction.
- `ChatRuntime` continues to own active streams, branch-anchored optimistic output, idempotency keys,
  and generation recovery. Phase 5 does not add a parallel client store.
- TanStack Query owns canonical conversation, alternative-context, response-state, and draft data.
- Fastify owns authorization, selected-path validation, tree mutations, authoritative context,
  revisions, idempotent turn creation, and adjacent-branch resolution.
- PostgreSQL remains authoritative for immutable messages, selection, generations, drafts, search,
  and revisions. The browser never submits conversation history.
- `packages/protocol` contains only public request, response, and inferred transport types. Markdown
  ASTs, renderer props, React state, branch queries, and Drizzle types stay out of it.
- Rendering dependencies exist only in `apps/web`. The API does not parse Markdown or depend on
  presentation packages.
- The backend keeps the direct `route -> service -> explicit queries` pattern. No repository layer,
  command bus, generic tree engine, queue, cache, or worker is introduced.

## Phase 5 checkpoint

The runnable checkpoint supports all four generation sources through one stream:

```text
draft send
  selected assistant/null -> new user -> new assistant

continue
  selected length assistant -> visible backend-owned user -> new assistant

edit
  selected path ... -> target user -> old suffix preserved
                       `-> edited user sibling -> new assistant

retry
  selected path ... -> user -> old assistant preserved
                       `-> new assistant sibling
```

Every generation source commits its selected branch and active generation before the fake gateway
wait, streams through the existing NDJSON coordinator, and reconciles through canonical query data.

The selected path can then move without changing message content:

```text
current selected endpoint
   ├── Undo -> previous assistant ancestor
   └── alternative arrow -> adjacent sibling -> deterministic descendant leaf

no message deletion
no content overwrite
one structural revision per selection change
```

The employee reads the result through one safe presentation path:

```text
stored/or streaming Markdown source
  -> frame-batched React update
  -> GFM + math + local syntax highlighting
  -> safe links, no raw HTML, no media fetches
  -> contained tables/code/math
  -> exact source retained for copy
```

## Public HTTP contract

Phase 5 makes only additive API changes. Every state-changing request remains JSON-only,
authenticated, owner-scoped, exact-Origin protected, body-bounded, and TypeBox-validated.

| Method | Route | Phase 5 purpose |
| --- | --- | --- |
| `POST` | `/api/conversations/:conversationId/responses` | Existing NDJSON route; add atomic edit and retry request variants |
| `POST` | `/api/conversations/:conversationId/alternative-contexts` | Read bounded adjacent-alternative metadata for loaded messages |
| `POST` | `/api/conversations/:conversationId/undo` | Move the selected endpoint back one complete turn |
| `PUT` | `/api/conversations/:conversationId/selection` | Existing route; select the resolved leaf for an adjacent alternative or search result |
| `GET` | `/api/conversations/:conversationId` | Existing response remains unchanged for previous-web compatibility |

### Edit request

```json
{
  "source": "edit",
  "targetMessageId": "00000000-0000-4000-8000-000000000001",
  "parentMessageId": null,
  "content": [{ "type": "text", "text": "Texto editado" }],
  "modelTier": "balanced",
  "observedRevision": 8
}
```

- `targetMessageId` must identify an owned user message on the selected path.
- `parentMessageId` must exactly match that stored user's parent and serves as the browser runtime's
  branch anchor. It is `null` only when editing a root user message.
- Content uses the accepted one-text-block validation, normalization, control-character rejection,
  and 32,768 UTF-8 byte limit.
- Line-ending-normalized content identical to the stored target is rejected as a non-edit rather
  than creating a duplicate branch.
- The request neither reads nor consumes the conversation draft.

### Retry request

```json
{
  "source": "retry",
  "targetMessageId": "00000000-0000-4000-8000-000000000002",
  "parentMessageId": "00000000-0000-4000-8000-000000000001",
  "modelTier": "balanced",
  "observedRevision": 8
}
```

- `targetMessageId` must identify an owned assistant message on the selected path.
- `parentMessageId` must exactly match the stored user parent of that assistant and becomes the
  branch anchor.
- Fastify reads the user parent's stored text. The browser never resubmits or rewrites that text.
- A terminal generation row is not required for imported Phase 3 fixtures, but an active generation
  anywhere in the conversation blocks retry.
- Completed, length, refusal, filtered, cancelled, incomplete, failed, and fixture answers may be
  tried again when selected and inactive.

### Alternative-context request and response

```json
{
  "messageIds": [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ]
}
```

Each request chunk contains 1–40 unique IDs from one or more loaded selected-branch detail pages.
The coherent response is:

```json
{
  "conversationId": "00000000-0000-4000-8000-000000000000",
  "revision": 8,
  "contexts": [
    {
      "messageId": "00000000-0000-4000-8000-000000000002",
      "position": 2,
      "total": 3,
      "previousLeafMessageId": "00000000-0000-4000-8000-000000000010",
      "nextLeafMessageId": "00000000-0000-4000-8000-000000000020"
    }
  ]
}
```

- `position` is one-based in deterministic sibling order by `created_at`, then ID.
- `total` includes the current message and equals the existing `siblingCount + 1`.
- Previous or next targets are `null` at their boundary.
- A target is the adjacent sibling itself. The historical `previousLeafMessageId` and
  `nextLeafMessageId` field names remain for wire compatibility, but Fastify deliberately defers
  deterministic descendant-leaf resolution until the employee activates that target.
- The response contains IDs and positional metadata only—no alternative content, tree, title,
  generation metadata, or draft.
- Fastify verifies every requested message belongs to the currently selected path in the owned
  conversation. Mixed, missing, non-selected, or cross-conversation input fails as one request
  rather than returning partial metadata.
- If the returned revision no longer matches the detail view, the browser discards the metadata and
  refreshes canonical state before enabling branch selection.
- The browser may issue multiple sorted chunks after older pages load. Every chunk is keyed by actor,
  conversation, structural revision, and exact IDs; no chunk result is merged into another revision.

### Undo request

```json
{
  "observedRevision": 8
}
```

- Fastify locks the owned conversation, rejects an active generation or stale revision, and walks
  upward from the selected endpoint.
- The target is the nearest earlier assistant ancestor, which removes one user/assistant turn from
  the visible suffix without deleting it.
- The first assistant response has no Undo target. That case is `BAD_REQUEST`; the browser normally
  hides the action before a request can be made.
- Success reuses `ConversationSelectionResponseSchema`, increments the conversation revision once,
  updates recency, and returns the selected endpoint.

### Compatibility

- The conversation-detail response shape remains unchanged because the immediately preceding web
  build strictly rejects undeclared nested message fields.
- The Phase 5 API accepts all Phase 4 `draft` and `continue` requests unchanged.
- New endpoints and request union members are deployed API-first. The immediately preceding web
  build never calls them and continues to validate existing responses.
- The stream event catalog, terminal meanings, error envelope, response-state contract, and
  cancellation contract do not change.
- Existing stable errors are sufficient: `BAD_REQUEST`, `NOT_FOUND`, `CONVERSATION_CHANGED`,
  `CONVERSATION_ARCHIVED`, `GENERATION_ACTIVE`, `GENERATION_ALREADY_EXISTS`, `MESSAGE_TOO_LARGE`,
  and the accepted streaming failures. Phase 5 adds no code by implication.

## Immutable-tree and revision invariants

- Existing message rows are never updated by edit, retry, Undo, or branch navigation.
- Edit inserts exactly one user sibling, one assistant child, and one generation.
- Retry inserts exactly one assistant sibling and one generation.
- Undo and branch navigation insert no messages or generation.
- Every inserted message remains in the same owned conversation and preserves role alternation.
- Edit and retry targets must be ancestors of the selected endpoint or the endpoint itself. A message
  on a non-selected branch cannot be mutated until that branch is selected.
- The existing per-conversation active-generation unique constraint remains authoritative across
  replicas and tabs.
- Edit and retry turn creation increment the structural revision once; their terminal outcome
  increments it once more through the accepted Phase 4 terminal transaction.
- Undo and a changed alternative selection increment once. Selecting the current endpoint remains
  a successful no-op with no revision or recency change.
- Streaming checkpoints continue not to increment structural revision.
- Rename, archive, search selection, ordinary send, Continue, cancellation, terminalization, and
  deletion retain their accepted revision behavior.
- A stale edit, retry, Undo, or branch request preserves the local composer draft, refetches
  canonical state, and asks for explicit retry. It never silently rebases the mutation.
- Alternative sibling counts derive from immutable tree topology and require no stored counter.
- Search automatically sees newly inserted edit/retry messages through the accepted generated
  vectors. The resolver changes only as required for an Undo-selected internal endpoint: when the
  matched message is on the current endpoint's ancestor path, the result retains that endpoint and
  opening it is a structural no-op; otherwise it resolves the accepted deterministic descendant
  graph leaf. No search schema or indexing behavior changes.
- Conversation deletion still removes all branch content, including Phase 5 alternatives; retained
  generation metadata remains content-detached under the accepted Phase 4 deletion boundary.

## Generation-service behavior

The generation service extends its current direct transaction rather than creating four separate
services or a generic workflow engine.

### Shared preflight

For every source, the transaction:

1. Locks the owned conversation.
2. Checks the scoped idempotency key before active-generation conflict.
3. Rejects an active generation, archive state where generation is requested, and stale revision.
4. Validates the source-specific target and branch anchor against the selected path.
5. Reconstructs only the authoritative prefix required for that source.
6. Enforces message and context byte bounds before persistence.
7. Inserts the required immutable message rows and one active generation.
8. Selects the new assistant and increments the revision once.
9. Commits before returning the model-neutral request to the stream coordinator.

### Edit context

- Reconstruct history through the target user's stored parent, not through the old target or its
  descendants.
- A null stored parent means an empty edit prefix. It does not invoke the ordinary first-send
  assertion that a conversation with null selection contains no messages.
- Use the normalized edited text as the new current user message.
- Insert the edited user under the same parent as the original user.
- Insert an empty assistant under the edited user.
- Never create or replace a title, and never touch the ordinary draft.

### Retry context

- Load the target assistant's user parent and that user's stored content.
- Reconstruct history through the stored user's parent so the user is supplied once as the current
  model message, not duplicated in history.
- Retrying the first answer likewise uses an empty prefix when the stored user has no parent.
- Insert an empty assistant under the existing user.
- Return the existing user ID as `response.started.userMessageId` and the new assistant ID as
  `messageId`.
- Never touch the ordinary draft or title.

### Idempotency and ambiguity

- The existing scoped generation idempotency key covers edit and retry without another table.
- Reusing an accepted key returns `GENERATION_ALREADY_EXISTS`; it never attaches to an old byte
  stream or creates another sibling.
- If the browser loses the pre-header outcome, `ChatRuntime` first resolves canonical state. Only an
  explicit employee Retry may resend with the same key.
- Canonical proof for edit matches a newly selected assistant whose new user parent has the approved
  branch anchor and edited text.
- Canonical proof for retry matches a newly selected assistant sibling under the approved stored
  user and excludes the original assistant target.
- Deterministic pre-commit 4xx rejection releases the local action. Unknown or 5xx outcomes remain
  fenced until canonical recovery establishes whether a branch was committed.

## Branch navigation and Undo

- Message actions are shown with the message they affect and use text plus simple literal arrow
  geometry with accessible names.
- A message with no siblings has no branch navigator.
- A message with alternatives shows previous and next controls plus `position / total`.
- Disabled boundary arrows remain programmatically disabled, not clickable no-ops.
- Alternative metadata is requested in sorted, deduplicated chunks of at most 40 IDs for currently
  loaded messages that report `siblingCount > 0`.
- Loading older selected-branch pages adds stable page-aligned chunks without replacing the current
  detail cache, discarding prior chunks, or creating one request per message.
- Selecting a target uses the existing selection route and current observed revision.
- On success, the browser replaces the detail pagination root, invalidates history, search,
  alternative contexts, and response state, then positions at the new selected endpoint.
- On `CONVERSATION_CHANGED`, it preserves the ordinary draft, reloads canonical detail, and asks the
  employee to repeat the branch action.
- Branch controls do not preload sibling message content or recursively cache alternative trees.
- Undo is presented only on the selected endpoint when the loaded path proves a previous assistant
  ancestor exists. Fastify still validates the authoritative path.
- Undo and branch changes never stop an active stream implicitly; controls are disabled and Fastify
  rejects a race with `GENERATION_ACTIVE`.
- Keyboard focus remains on the invoked control after a no-op/error. After a successful branch or
  Undo navigation, focus moves to the conversation heading or selected message action group with a
  concise status, not into generated content unexpectedly.

## Browser `ChatRuntime` integration

- Keep one runtime entry per active conversation and extend the accepted request union directly.
- Record the request source, target, and branch anchor needed for canonical proof and presentation;
  do not copy an authoritative history into runtime state.
- For an edit, the optimistic presentation is canonical messages through the original user's parent,
  then the newly committed user and assistant.
- For a retry, it is canonical messages through the existing user parent, then the new assistant.
- For draft and Continue, preserve the accepted presentation and recovery behavior.
- Runtime text remains raw Markdown source. TanStack Query is never updated once per delta.
- Markdown rendering consumes the same frame-batched runtime snapshot already published by
  `ChatRuntime`; Phase 5 does not add a second batching loop.
- A terminal event reconciles the complete selected branch, response states, history, search,
  alternatives, and draft scope before removing the runtime entry.
- A failed terminal reconciliation retains the exact accepted Phase 4 recovery alert and explicit
  action. Phase 5 does not turn branch actions into automatic generation retries.
- Navigating away does not stop an edit/retry stream. Returning to the conversation presents the
  branch-anchored accumulated output.
- Authentication disposal aborts every local stream and in-flight recovery, clears only that scoped
  runtime/query state, and prevents late callbacks from entering another employee session.

## Message presentation and Markdown security

Create one narrowly scoped message renderer used by employee and assistant content.

### Supported presentation

- CommonMark paragraphs, headings, thematic breaks, ordered and unordered lists, blockquotes,
  links, emphasis, strong text, and inline code.
- Map source heading levels one through five to HTML `h2` through `h6` and source level six to
  `h6`; the conversation title remains the route's only `h1`.
- GFM tables, task lists, strikethrough, autolinks, and fenced code blocks.
- Stored soft line endings remain visually meaningful through scoped message typography without
  rewriting the Markdown source.
- Inline `$...$` and block `$$...$$` mathematics through `remark-math` and KaTeX.
- Recognized fenced languages receive local syntax highlighting; unknown languages remain plain.
- Wide tables, code, and display math scroll inside their own bounded region and never widen the
  conversation page.
- User messages retain restrained Paper cards; assistant messages use the full-width document
  layout. Repeated avatars, model/provider names, and timestamps remain absent.

### Security rules

- Do not use `dangerouslySetInnerHTML`, `rehype-raw`, MDX, iframe, object, embed, script, style, SVG,
  or arbitrary custom HTML from message content.
- Configure React Markdown to skip raw HTML. HTML-looking source never creates DOM elements.
- Override image rendering so Markdown image syntax creates no `<img>` and triggers no request.
- Validate links against the exact protocol allowlist before producing an anchor. Invalid targets
  render their visible label without a link.
- External anchors use a separate browsing context and `rel="noopener noreferrer"`.
- Do not fetch link previews, images, code grammars, fonts, remote stylesheets, or math assets.
- Highlighting receives only the declared, directly imported grammar modules with `detect: false`
  and never
  auto-detects arbitrary source as a different grammar.
- KaTeX produces MathML only and uses no trusted command, HTML extension, remote asset, CSS `style`
  attribute, shared macro state, or employee-defined macro. Bounded native MathML presentation
  attributes remain permitted. Set `strict: "ignore"` so
  arbitrary response math cannot enter the console through KaTeX warnings.
- Bound KaTeX expansion and authored dimensions with `maxExpand: 1000` and `maxSize: 20`. Remove the
  adapter's error-node `style` property before React rendering and style the stable error class in
  the committed stylesheet.
- Renderer errors show a content-free localized fallback while preserving Copy source. Errors,
  logs, telemetry, and test output never include the Markdown, code, math, prompt, or response.
- The renderer remains compatible with the intended restrictive SPA CSP and never weakens the
  existing API policy. Phase 5 asserts the DOM boundary directly and exercises the gallery under the
  intended CSP; production static-host enforcement remains Phase 8.

### Rendering performance

- Define plugin and component maps once outside render paths.
- Split the current conversation-page message body and actions into narrow components so only the
  streaming assistant reparses when its frame-batched source changes.
- Memoize stable canonical messages by ID and source without introducing a normalized client store.
- Do not parse Markdown on the server, in a worker, or into TanStack Query.
- Do not debounce terminal rendering or delay ordinary text solely for highlighting.
- Long pathological input remains bounded by the accepted message and assistant byte limits.
- Phase 5 verifies representative large tables/code and fast fake chunks; Phase 8 owns full load and
  performance qualification.

## Message actions and inline edit

### Employee messages

- Copy is available for stable stored user text.
- Edit is available when the conversation is unarchived, no generation is active, and lifecycle
  state is coherent.
- Activating Edit replaces that one message body with a plain-text textarea initialized from the
  original Markdown plus explicit Save and Cancel actions.
- Enter inserts a newline. Save is a visible button; IME composition and ordinary Enter never submit
  an edit accidentally. Escape cancels only when not composing.
- Empty, whitespace-only, oversized, invalid, and unchanged content cannot be submitted from the
  browser; Fastify remains authoritative.
- The inline edit is temporary React state. Navigating away or cancelling discards it and never
  changes the ordinary saved composer draft.
- Save becomes non-interactive while the generation start is unresolved. It closes only after
  `response.started` or canonical recovery proves the branch committed. A deterministic rejection
  restores the editor with its text and a localized next step.

### Assistant messages

- Copy answer is available for stable canonical assistant source, including cancelled and
  incomplete partials. It is hidden or disabled for the assistant currently changing in an active
  local or remote generation.
- Try again is available for a selected-path assistant when the conversation is unarchived and no
  generation or incoherent lifecycle is active.
- Continue remains exclusive to a selected completed `length` outcome and retains its Phase 4
  semantics. Try again creates a sibling; Continue creates a visible new user turn.
- Undo appears only for the selected endpoint when a previous complete turn exists.
- Alternative navigation appears for both user and assistant siblings and remains visually separate
  from Try again so movement is not confused with generation.

### Action presentation

- Action groups appear directly below their message and remain in the tab order.
- Hover may increase prominence only on hover-capable devices; `:focus-within`, touch, terminal
  state, and branch position keep actions discoverable without hover.
- Every icon-only geometry has a localized accessible name and visible focus ring. Prefer concise
  text where it is clearer than an icon.
- A mutation locks only the affected action group and conflicting generation/branch actions, not
  unrelated Copy actions or draft typing.
- Failure copy states what happened, confirms preserved work when applicable, and gives one next
  action without blaming the employee.

## Clipboard behavior

- Use `navigator.clipboard.writeText` only in the employee-initiated click path.
- Copy answer/user receives the exact raw source string used by the renderer, not `textContent`,
  generated HTML, a transformed AST, or a reconstructed approximation.
- A fenced code control receives the parsed code payload and removes only fence syntax and a parser-
  introduced terminal newline. It preserves authored indentation, blank lines, Unicode, and
  normalized `\n` line endings.
- Each action owns a small local pending/success/failure state so concurrent copy controls do not
  overwrite one global announcement.
- Success updates the invoking control and one polite status region; failure uses an alert and leaves
  keyboard focus on the control.
- Copy never writes to browser storage, console, analytics, error metadata, or the server.
- There is no hidden textarea, `document.execCommand`, permission preflight, or automatic retry.

## Streaming scroll controller

Keep scrolling as one conversation-scoped presentation concern rather than spreading effects across
message, runtime, and composer components.

### State

The controller tracks only:

- current conversation ID;
- whether following is engaged;
- whether unseen streamed content exists;
- the last observed scroll height needed to detect content growth;
- whether a programmatic position is in progress;
- the sent-user and search-target positioning intents already present; and
- the existing older-page viewport anchor.

It stores no content, message history, or browser-persistent preference.

A sibling pre-mutation fence may hold at most 48 characters of context on each side of a live
selection endpoint for the duration of one React commit. React receives only a content-free boolean
snapshot; the private context field is cleared before the scroll callback and never enters hook
state, storage, logs, diagnostics, or browser persistence. Selection coordinates exclude hidden
MathML annotations and use stable code-content roots so renderer controls cannot shift the range.

### Rules

- Opening a normal conversation positions at its selected endpoint once.
- Sending positions the committed user message near the top with room below for the answer, then
  engages following.
- While engaged and within 96 pixels of the bottom before content growth, each animation-frame
  publication may set the container to its latest scroll height with `behavior: "auto"`. Eligibility
  uses the prior observed scroll height so a single growth frame larger than 96 pixels still follows.
- A trusted upward scroll that moves beyond the threshold disengages following.
- A non-collapsed document selection whose anchor or focus is inside the message container
  disengages following before the next stream batch can move it.
- Programmatic older-page anchoring, search positioning, and initial positioning do not falsely
  count as employee disengagement.
- Scrolling manually back within the threshold re-engages following and clears unseen state.
- New streamed source while disengaged sets unseen state and displays Jump to latest. Lifecycle-only
  changes do not.
- Jump to latest scrolls once, clears unseen state, and re-engages. Use smooth behavior only for this
  explicit action when reduced motion is not requested.
- Completion, cancellation, failure, navigation away, and terminal reconciliation do not call a
  bottom-scroll method.
- Loading older messages preserves the exact viewport delta as in Phase 3 and does not alter follow
  state.
- Switching branch or Undo resets scroll state to the new selected endpoint without leaking the old
  branch's unseen marker.

### Accessibility

- Jump to latest is an ordinary keyboard-focusable button with centralized Spanish copy.
- Its appearance may be announced once as a concise status, never once per token.
- Activating it does not move focus away from the button or composer.
- Text selection remains stable after auto-follow disengages.
- Reduced motion removes smooth scrolling and highlight fades without hiding controls or state.

## Search-result positioning

- Search opening retains the matched message ID from the selected result and passes it through
  React Router location state; it does not place message content or search text in the URL.
- Title-only matches carry no message target and use normal selected-endpoint positioning.
- The conversation page validates and copies the ID into controller-local intent, then immediately
  replaces the route state before asynchronous pagination or the marker timer begins.
- Conversation-page recovery uses the route-scoped request lifetime and sequential opaque cursors
  to fetch older selected-branch pages until the target appears or pagination ends.
- A route change, session change, branch revision change, or unmount aborts the positioning work and
  prevents a late scroll/highlight.
- Once present, the target scrolls into view once and receives a visible Gold-derived background
  plus outline so color is not the only signal.
- The marker does not steal focus. Screen readers receive one concise result-location status.
- After the hold/fade, only controller-local marker state is cleared. Back/forward navigation cannot
  replay consumed route state; an explicit retry creates a new local positioning intent.
- Failure to find the message after canonical pagination presents a retryable content-free error and
  does not select another branch silently.

## Fixed response-format gallery

The gallery is one deterministic owned conversation prepared by the isolated Playwright fixture
server. It includes synthetic, non-sensitive source covering:

1. Paragraphs, all supported heading levels, emphasis, strong text, strikethrough, thematic break,
   safe external link, unsafe link, and raw HTML-looking text.
2. Ordered, unordered, nested, and task lists plus blockquotes.
3. A narrow table and a deliberately wide table with long unbroken cells.
4. Inline code, recognized TypeScript/Python/SQL fences, an unknown-language fence, no-language
   fence, long lines, internal blank lines, and copy-sensitive indentation.
5. Inline and display mathematics, wide mathematics, and invalid mathematics.
6. Markdown image syntax, script/iframe/object/embed source, and `javascript:`, `data:`, relative,
   and fragment destinations that must create no executable or fetched content.
7. Unicode, emoji, combining characters, bidirectional text, very long words, and preserved soft
   line endings.
8. User and assistant messages, terminal labels, alternatives, partial content, and action toolbars.

The gallery must:

- render through the production message component and ordinary conversation route;
- use no provider request and no production seed;
- assert semantic DOM, containment, link safety, no unexpected network request, and clipboard text;
- capture focused Chromium desktop and narrow-viewport component screenshots with vendored fonts;
- run Markdown/table/code overflow and critical interaction assertions in Chromium, Firefox, and
  WebKit; and
- avoid broad page snapshots unrelated to the renderer.

## Dependency policy

Phase 5 is the first milestone that needs dedicated web rendering dependencies. The approved stack
is intentionally narrow:

| Dependency | Purpose |
| --- | --- |
| `react-markdown` | React-native safe Markdown AST rendering without raw HTML |
| `remark-gfm` | Tables, task lists, strikethrough, and GFM autolinks |
| `remark-math` | Parse LaTeX-style inline and block math |
| `rehype-katex` | Convert parsed math to MathML-only KaTeX output; it owns the transitive KaTeX runtime |
| `rehype-highlight` | Apply local lowlight/highlight.js AST classes to fenced code |
| `highlight.js` | Supply only the explicitly imported approved grammar modules to `rehype-highlight` |

- Install exact compatible direct versions and commit the pnpm lockfile, including transitive
  `katex@0.16.47`. Do not add a redundant direct `katex` dependency or import its HTML layout
  stylesheet when the approved output is MathML-only.
- Do not upgrade React, Vite, TypeScript, Biome, Playwright, Fastify, TypeBox, or another dependency
  as part of this work unless an approved Phase 5 package cannot work with the accepted baseline.
- Do not add DOMPurify or `rehype-sanitize` merely to compensate for an HTML pipeline that Phase 5
  does not create. If implementation behavior contradicts the no-HTML boundary, stop and reassess
  instead of layering sanitizers silently.
- Do not add Shiki, Prism, Monaco, MDX, MathJax, a clipboard package, a scroll package, an icon
  library, or a UI component framework.
- Bundle impact must be measured as raw and gzip deltas. Keep the renderer behind one direct lazy
  conversation-component boundary if that materially prevents identity and content-free routes from
  paying the renderer cost; do not introduce a generalized loading or route framework.

## Implementation sequence

### 1. Freeze and reproduce the Phase 4 baseline

- Record commit `ba88f12`, clean Phase 4 correction scope, tool versions, and the accepted verification
  record.
- Re-run repository-scoped Biome, strict type checking, all protocol/API/PostgreSQL/web tests,
  production builds, current Playwright suites, clean/upgrade migrations, and API image checks.
- Confirm the literal `pnpm check` exception, if still present, is only the ignored local Claude
  setting and not a repository file.
- Stop if Phase 4 is not reproducible or if a hidden correction is required.

### 2. Encode additive Phase 5 transport contracts

- Add edit and retry request schemas to the existing response request union.
- Add bounded alternative-context request/response schemas and Undo request/response aliases.
- Reuse existing IDs, revision, text-block, tier, selection response, and stable-error schemas.
- Keep conversation detail and all stream events byte-for-byte compatible in meaning.
- Add exhaustive contract tests for roles-by-source, nullability, byte limits, unique/max alternative
  IDs, extra properties, positions, boundary targets, and old Phase 4 request acceptance.

### 3. Implement branch queries and Undo

- Add explicit selected-path membership validation near current recursive conversation queries.
- Add one coherent bounded alternative-context query that derives sibling ordinal and adjacent
  sibling selection targets without returning content or traversing target descendants. Resolve a
  target's deterministic descendant leaf only after explicit selection and outside the short
  revision-checked mutation transaction.
- Add the short Undo transaction and allow its selected endpoint to have preserved descendants.
- Reuse actor ownership, revision conflict, active-generation, history invalidation, and selection
  patterns.
- Add no migration, stored sibling counter, branch-memory table, generic recursive repository, or
  background work.

### 4. Extend authoritative turn creation for edit and retry

- Extend the discriminated generation transaction directly with source-specific validation and
  insertion.
- Split authoritative prefix reconstruction narrowly: null is an empty prefix for root edit and
  first-answer retry, while ordinary first-send retains its empty-conversation integrity assertion.
- Factor only small repeated validation/context helpers when they make the four source paths clearer.
- Keep draft send and Continue behavior unchanged and covered as regression baselines.
- Preserve title, draft, context, idempotency, active-generation, archive, timing, checkpoint,
  cancellation, and terminal invariants.
- Keep all logs and errors content-free.

### 5. Extend the browser API and `ChatRuntime`

- Add typed fetch functions and actor-scoped query keys for alternative contexts and Undo.
- Extend runtime canonical proof and branch-anchor presentation for edit/retry.
- Reuse the accepted ambiguous-start recovery, authentication fencing, animation-frame publication,
  and terminal reconciliation.
- Prove navigation and simultaneous streams remain isolated.
- Do not put branch mutations, Markdown ASTs, or active stream deltas into another global store.

### 6. Build safe Markdown and copy primitives

- Install only the approved web dependencies after compatibility recheck.
- Implement one focused `MessageContent` path with stable plugin maps, safe link/image overrides,
  table/code/math containment, MathML-only output, removal of the narrow KaTeX error style
  attribute, and metadata-only failure fallback.
- Implement small browser-native clipboard helpers and local accessible result states.
- Define brand-semantic Markdown, code, table, quote, link, task-list, native MathML, and KaTeX-error
  styling through committed CSS only.
- Add focused renderer and clipboard tests before replacing current plain-text presentation.

### 7. Add message action groups and inline edit

- Extract narrowly focused message body/action components from the current conversation page rather
  than adding a component system.
- Add user Copy/Edit, assistant Copy/Try again/Continue, branch controls, and selected-endpoint Undo
  with coherent action gating.
- Preserve the next draft, focus, terminal labels, response-state polling, archive behavior, and
  global recovery alerts.
- Keep all Spanish product copy in the centralized module.

### 8. Implement smart scrolling and search positioning

- Consolidate existing initial, sent-message, pagination, and canonical-recovery scroll effects into
  one conversation-scoped controller.
- Add near-bottom follow, selection/manual disengagement, unseen state, Jump to latest, branch reset,
  and reduced-motion behavior.
- Pass matched-message route state from search and load opaque ancestor pages until found.
- Add deterministic geometry/unit tests before browser timing tests.
- Preserve exact Phase 3 older-page viewport anchoring.

### 9. Add the response-format gallery

- Define one content-safe synthetic gallery fixture in Playwright support code.
- Seed it through the isolated API/Testcontainers setup without credentials in browser code and
  without a test-only HTTP route.
- Keep the gallery itself read-only. Seed distinct mutable conversations per browser project or test
  for revision-changing edit/retry/Undo/branch flows so the fully parallel shared harness cannot
  race one conversation across engines.
- Cover safe Markdown, hostile-looking source, code, math, tables, action groups, alternatives,
  terminal states, and overflow.
- Add targeted screenshots and semantic assertions, not a broad snapshot suite.

### 10. Complete proportional verification

- Use Vitest for contract schemas, tree utilities, runtime branch overlay, Markdown components,
  clipboard states, inline edit, alternative actions, scroll state, selection handling, and reduced
  motion.
- Use Fastify injection for ordinary alternative/Undo errors and generation preflight failures.
- Use Testcontainers and real migrations for edit/retry atomicity, selected-path validation,
  revisions, title/draft preservation, ownership, search visibility, idempotency, concurrency,
  alternative resolution, and Undo.
- Use the real HTTP listener for at least one edit stream and one retry stream through the existing
  NDJSON/cancellation path.
- Use Playwright for complete edit, retry, Undo, branch, Markdown, copy, search targeting, stream
  follow/disengagement, Jump to latest, responsive overflow, and keyboard flows.
- Run critical scrolling, Markdown overflow, copy, and branch interactions in Chromium, Firefox,
  and WebKit; keep the broader suite Chromium-first.
- Perform manual keyboard, focus, screen-reader, reduced-motion, selection, narrow/mobile, and
  no-horizontal-page-overflow checks.

### 11. Update documentation and record acceptance evidence

- Update local-development documentation for edit, Try again, Undo, alternatives, copy, Markdown,
  math, fake-only behavior, and renderer troubleshooting.
- Document why raw HTML/images are not rendered and why only Balanced remains functional.
- Record exact installed dependency versions, bundle sizes, test counts, browser matrix, operational
  values, container result, and any retained non-failing advisory in this implementation record.
- Run `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Playwright, production image,
  migration, and `git diff --check` gates.
- Review the complete diff for Phase 6–8 leakage, content logging, duplicated helpers, and unrelated
  refactors before handoff.

## Required verification cases

The Phase 5 suite must prove at least the following.

### Protocol and compatibility

- Phase 4 draft and Continue request fixtures still validate unchanged.
- Edit accepts exactly one text block, target, observed parent, revision, and Balanced tier.
- Retry accepts target, user parent, revision, and Balanced tier but no browser-supplied content.
- Wrong source fields, unknown properties, invalid UUIDs, Fast/Pro, invalid Unicode, and oversized
  content fail validation.
- Alternative requests reject empty, duplicate, over-40, malformed, and cross-conversation IDs;
  multiple revision-bound chunks cover more than 40 loaded alternative-bearing messages.
- Positions are positive, total is coherent, and boundary target fields are nullable only as
  approved.
- Existing stream events, error codes, response state, and conversation detail remain compatible
  with the immediately preceding web build.

### Edit

- Editing a root user creates a second root user and assistant while preserving the original full
  branch.
- Editing a deep user creates a sibling at the exact parent and excludes the old target/suffix from
  model context.
- The selected branch changes immediately to the new assistant and revisions increment once at
  start and once at terminal completion.
- Editing unchanged, empty, invalid, oversized, wrong-role, wrong-parent, non-selected, foreign,
  archived, stale, or actively generating targets fails without persistence.
- The ordinary conversation draft, manual title, initial title, prior messages, search entries, and
  generation records remain correct.
- Concurrent edits produce one winner and one stable conflict; an idempotency replay produces no
  duplicate branch.
- Ambiguous edit start shows only the selected-prefix optimistic branch, reuses its key on explicit
  retry, and consumes no ordinary draft.

### Try again

- Trying the selected endpoint creates a new assistant sibling under the existing user and no user
  row.
- Trying an earlier selected-path answer truncates only presentation and preserves its old suffix.
- Stored user content—not browser content—becomes the current gateway message, and prior history is
  included exactly once.
- Retrying the first answer supplies an empty prefix plus its stored root user exactly once.
- Ordinary, length, refusal, content-filter, cancelled, incomplete, failed, and fixture answers can
  be retried when inactive.
- Wrong-role, wrong-parent, non-selected, foreign, archived, stale, and active cases fail safely.
- Concurrent retry/edit/send requests preserve one active generation and one structural winner.
- Retry idempotency and ambiguous recovery cannot create a third assistant or attach to an old
  stream.

### Alternatives and Undo

- Sibling order is deterministic under equal timestamps through ID tie-breaking.
- Position/total are exact for root user edits and assistant retries.
- Previous/next metadata identifies adjacent sibling targets without scanning their descendants;
  explicit selection resolves direct graph leaves and newest deterministic descendant leaves.
- The alternative response contains no message content and is coherent with one conversation
  revision.
- Selecting adjacent alternatives persists across reload, loads only that branch, and increments
  revision once; selecting current remains a no-op.
- Undo from a deep selected answer moves to the previous assistant, preserves descendants, draft,
  search, and response metadata, and permits a new user sibling afterward.
- After Undo, searching a message already on the selected ancestor path returns the current endpoint
  and opening it does not increment the revision; a hidden descendant or other-branch match still
  selects its concrete resolved branch.
- Undo is unavailable at the first turn and conflicts safely with active, stale, deleted, foreign,
  and concurrent mutations.
- Branch and Undo actions in archived conversations select content without unarchiving or generating.

### Runtime and lifecycle

- Edit overlay shows canonical prefix + edited user + new assistant, never old suffix + new branch.
- Retry overlay shows canonical prefix through the stored user + new assistant, never both sibling
  answers as one path.
- Terminal reconciliation swaps overlay for canonical Markdown without flicker, duplication, or
  scroll reset.
- Navigation away/back, separate simultaneous conversations, remote active state, auth disposal,
  same-employee session rotation, and direct employee replacement remain isolated.
- A failed cancellation, stream protocol failure, interrupted partial, failed reconciliation, and
  explicit retry retain their accepted honest states.
- No automatic provider/generation retry is introduced.

### Markdown and security

- Paragraphs, headings, emphasis, lists, tasks, quotes, safe links, tables, inline/fenced code,
  supported languages, unknown languages, inline math, and display math render semantically.
- Raw HTML, scripts, iframes, objects, embeds, SVG, styles, event handlers, and Markdown images create
  no executable/embed DOM and no external request.
- Only `http:`, `https:`, and `mailto:` anchors exist; all receive separate-target and safe `rel`.
- Unsafe/relative/fragment destinations remain visible non-clickable text.
- Invalid code language and invalid math remain readable without render failure or content-bearing
  console/error output.
- Wide tables, code, math, long words, and narrow-screen content stay inside the message column with
  local horizontal scrolling and no page overflow.
- Task-list inputs are non-interactive, keyboard order is sensible, and semantic headings do not
  replace the route's one page heading hierarchy accidentally.
- Stream batches render incrementally without token-by-token status announcements.

### Copy and actions

- Copy answer equals original Markdown byte-for-byte after accepted line-ending normalization.
- Copy user equals stored source, not rendered text.
- Code copy excludes fences/language label and preserves payload indentation, blanks, Unicode, and
  internal final lines.
- Success and failure are localized, accessible, control-local, and contain no copied content.
- Clipboard rejection performs no hidden fallback and preserves focus.
- All message actions are keyboard reachable, visible on focus/touch, and correctly gated by active,
  archive, lifecycle, and branch state.
- Inline edit supports multiline input, IME, Escape cancel, visible Save, deterministic failures,
  and temporary state without altering the ordinary draft.

### Scrolling and search

- Initial open starts at selected endpoint; older-page loading preserves viewport exactly.
- Send positions the user once and follows frame-batched content while within 96 pixels.
- One publication that grows the document by more than 96 pixels still follows when pre-growth
  geometry was engaged and the employee did not scroll.
- Upward scroll and text selection disengage before the next delta; later deltas never pull the
  employee down.
- Jump to latest appears only after unseen streamed content, activates once, re-engages following,
  and clears unseen state.
- Manual return to bottom re-engages without requiring the button.
- Completion, cancellation, failure, and terminal reconciliation do not force movement.
- Reduced motion removes smooth following/highlight animation while retaining all information.
- Search opens the persisted exact branch, paginates until the matched message, scrolls once,
  highlights briefly, and does not repeat after state consumption.
- Search positioning is aborted safely by route/session/revision changes and does not publish late.

### Privacy and boundaries

- Logs, errors, metrics, URLs, browser storage, and diagnostics contain no prompt, response, code,
  math, clipboard, or inline-edit content. Browser screenshots and traces may contain only isolated
  synthetic fixture content—never real employee content—and remain ordinary failure artifacts.
- Gallery and other browser fixture content is synthetic, local, and unavailable in production.
- No OpenRouter, provider, price, cost, budget, reservation, compaction, admin, telemetry, deployment,
  or excluded product feature enters the diff.
- No database transaction or pooled connection spans fake-gateway or browser waits.
- Existing ownership prevents members and administrators from reading or mutating another
  employee's alternatives.

## Phase boundary

The following are forbidden in Phase 5, including as disabled controls, empty tables, generic
abstractions, preinstalled dependencies, compatibility shims, or speculative placeholders unless
the approved Phase 5 work directly requires them.

### Accepted Phase 1–4 behavior

- Do not replace pnpm, strict TypeScript, Biome, React Router, TanStack Query, Fastify, TypeBox,
  Drizzle/node-postgres, Better Auth, the error envelope, migration runner, CI, container, or brand
  packaging with a parallel system.
- Do not replace `ChatRuntime`, the stream parser, NDJSON fetch, FakeModelGateway, query scoping,
  draft memory, request lifetimes, actor resolution, or the direct route/service/query flow.
- Do not repurpose stream events, terminal reasons, response-state meanings, or accepted stable
  errors.
- Do not weaken exact-Origin checks, owner scoping, archive rules, revision guards, idempotency,
  active uniqueness, content bounds, cancellation durability, backpressure, or graceful shutdown.
- Do not broadly redesign the Phase 3 conversation service or Phase 4 stream coordinator while
  adding the narrowly required branch/source paths.

### Phase 6 — OpenRouter and cost control

- No OpenRouter dependency, API key, HTTP call, provider event translation, model catalog, ZDR
  validation, routing fallback, tier mapping, enabled/default tier policy, preferred-tier column,
  header picker, raw model/provider identifier, pricing, token accounting, cost, budget,
  reservation, settlement, cancellation accounting, employee concurrency limit, expiry lease, or
  reconciler.
- Do not expose Fast or Pro as functioning choices. Phase 5 edit/retry use only Balanced.
- Do not present fake usage as billing or production AI.

### Phase 7 — Compaction and administration

- No compaction table, prompt, summary, context trigger, fallback truncation, model call, persistence,
  status emission, or search indexing.
- No `/admin` feature, employee administration, session revocation UI, model policy controls, output
  limits, workspace budget form, usage/cost table, or timezone control.

### Phase 8 — Production hardening

- No OpenTelemetry SDK, browser telemetry, frontend-error endpoint, observability destination,
  production host, edge configuration, secret-manager adapter, backup automation, disaster-recovery
  tooling, broad load generator, or production-readiness claim.
- Phase 5 performs targeted renderer/scroll performance, accessibility, security, and cross-browser
  verification only.

### Features outside approved v1 scope

- No sharing, attachments, document retrieval, browsing, tools, skills, agents, image rendering or
  generation, long-term memory, interactive embeds, arbitrary HTML, Mermaid, provider-specific
  renderer, public link, export/import, folder, tag, favorite, presence, collaboration, offline mode,
  service worker, persistent browser cache, or semantic search.
- No Markdown editor toolbar, prompt templates, message reactions, citations system, footnote
  product feature, diagram renderer, file preview, or rich-text authoring by implication.

## Manual verification runbook

After automated checks pass, verify the complete Phase 5 checkpoint with synthetic content:

1. Start migrated PostgreSQL, Fastify, and Vite with the deterministic fake gateway and sign in as
   an owned synthetic employee.
2. Confirm the accepted ordinary Send, Stop, Continue, draft-during-stream, interruption recovery,
   archive, search, and deletion flows still behave exactly as Phase 4.
3. Create a three-turn conversation with a saved next draft. Edit the first user message, confirm
   the old suffix disappears only from the selected path, the new response streams, and the saved
   next draft remains unchanged.
4. Navigate to the original user alternative and back. Confirm ordinal controls, revision changes,
   focus, selected endpoint, and reload persistence.
5. Try an ordinary answer again, then try a cancelled/incomplete answer again. Confirm each creates
   one assistant sibling with no duplicate user message.
6. Trigger ambiguous edit and retry starts. Confirm no automatic generation, explicit recovery with
   the same key, honest alerts, and no duplicate branch.
7. Undo the latest turn, send a different next message from the earlier assistant, and confirm both
   continuations remain selectable.
8. Archive the conversation. Confirm Copy, alternatives, and Undo remain usable while Edit, Try
   again, Continue, and Send cannot generate until unarchived.
9. Open the fixed gallery at desktop and narrow viewports. Inspect headings, lists, task lists,
   quotes, tables, code, syntax colors, math, actions, focus, containment, and typography.
10. Inspect the gallery's hostile-looking Markdown. Confirm no raw element, media request, unsafe
    anchor, executable markup, console content, or CSP weakening.
11. Copy an entire answer, user message, recognized code block, and unknown-language block. Compare
    clipboard text to the exact source and trigger a denied clipboard path.
12. Stream while at the bottom and confirm non-animated following. Scroll upward and select text;
    confirm later chunks do not move the viewport and Jump to latest indicates unseen output.
13. Activate Jump to latest, manually return to bottom, and repeat under reduced motion. Confirm
    completion/cancellation/failure never forces a final scroll.
14. Search for a message older than the first 40-message page. Open it, verify branch selection,
    sequential ancestor loading, one scroll, brief marker, no focus theft, and no repeat after route
    state is consumed.
15. Repeat critical Markdown overflow, branch, copy, and streaming-scroll flows in current Chromium,
    Firefox, and WebKit desktop engines plus current iOS/Android-sized viewports.
16. Navigate away during edit/retry streaming, return, rotate the session, and replace the employee
    in test. Confirm runtime/query/draft/action state never crosses authentication scope.
17. Sign in as another member and an administrator. Confirm neither can read alternative metadata,
    select, Undo, edit, retry, or copy another employee's content through the application.
18. Inspect structured logs and failures for message, Markdown, code, math, clipboard, gallery,
    system-prompt, fake-response, and raw stream-line leakage.
19. Apply all migrations to an empty database and upgrade the exact accepted Phase 4 schema. Confirm
    Phase 5 creates no migration and all prior data remains readable.
20. Run full repository gates, browser tests, production API image checks, bundle review, and
    `git diff --check`; then inspect the complete diff against the Phase 6–8 exclusions.

## Definition of done

Phase 5 is complete only when:

- The accepted Phase 4 baseline remains reproducible and every required Phase 5 gate succeeds.
- Edit creates a preserved user branch and immediate response atomically without rewriting content,
  consuming the ordinary draft, or renaming the conversation.
- Try again creates exactly one assistant sibling from the stored user message and never duplicates
  the user or automatically retries a generation.
- Undo and adjacent alternative navigation preserve the immutable tree, use revision-safe owner-
  scoped backend decisions, load only selected branches, and remain coherent across reloads.
- `ChatRuntime` presents edit/retry branches from the correct anchor, isolates conversations and
  sessions, and reconciles terminal canonical state without duplication or stale suffixes.
- User and assistant content safely render the approved GFM, code, table, and mathematics formats
  with no raw HTML, media fetch, unsafe link, executable embed, or content-bearing diagnostic.
- Whole-message and code copying return exact approved source and expose accessible, localized,
  content-free success/failure states.
- Smart scrolling follows only while the employee remains near the bottom, disengages for upward
  scroll or text selection, exposes Jump to latest for unseen output, and never forces movement on a
  terminal event.
- Search-result opening loads and positions the exact preserved matched message with a brief,
  reduced-motion-safe marker.
- The deterministic gallery and proportional unit, PostgreSQL, real-HTTP, Playwright, accessibility,
  security, responsive, and cross-browser tests cover the complete Phase 5 surface.
- Dependencies remain the smallest approved rendering set, bundle impact is recorded, and no
  duplicate parser, store, tree abstraction, component system, or infrastructure is added.
- Documentation enables another developer to reproduce every control, renderer, copy, branch,
  scroll, and failure state and clearly states that responses remain simulated until Phase 6.
- The final diff contains no OpenRouter/cost/tier-policy, compaction/admin, production-platform, or
  excluded v1 feature work.
- Any failed or unavailable verification is reported exactly rather than treated as complete.

Completion of Phase 5 authorizes no automatic Phase 6 work. Phase 6 begins only after Phase 5 is
reviewed, explicitly accepted, frozen as an exact baseline, planned against that baseline, and
separately authorized.
