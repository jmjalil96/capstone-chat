# System Architecture and Data Boundaries

Status: locked for v1

## Architecture

**Locked**

Capstone Chat is a modular monolith with a thin browser application, a single authoritative API, and PostgreSQL.

```text
Vite + React SPA
        |
        | HTTPS and streaming fetch
        v
Fastify + TypeScript API
        |
        v
PostgreSQL
```

The API is stateless at the process level so replicas can be added horizontally. Interactive model generations are handled directly through their HTTP request; they are not placed on a job queue.

The initial system does not introduce microservices, Redis, or a separate queue.

## Deployment shape

**Locked**

- Fastify is built as one OCI container.
- Vite is built as static assets.
- Both are exposed through one public origin, with `/api/*` routed to Fastify.
- PostgreSQL is provided as a managed service.
- Migrations run as a one-off deployment job before new API replicas receive traffic.
- API replicas are stateless and do not require sticky sessions.
- The edge proxy disables buffering and response transformation for NDJSON streams.
- Liveness checks confirm that the process is functioning without depending on external services.
- Readiness rejects new traffic while a replica is starting, unhealthy, or draining.
- During deployment, a replica stops accepting new requests and drains active streams for a configured period.
- Streams remaining after the drain period settle by lifecycle: ordinary active chat/compaction work
  retains useful partial content as incomplete, while an answer-durable `finalizing` chat completes
  and its hidden title work is cancelled. A stream whose browser disconnected keeps producing until
  it completes, is stopped, or the drain period ends (Phase 10).
- Production credentials are delivered as component-scoped DigitalOcean App Platform encrypted
  environment variables; recoverable source copies remain in the approved company-controlled
  password manager and never enter the image, repository, process arguments, or application logs.
- The OCI artifact, application contracts, and PostgreSQL boundary remain portable. The production
  ingress, secret, deployment, and operations adapter is intentionally specific to DigitalOcean
  App Platform under the approved Phase 8 amendment.

The approved production launch candidate is one DigitalOcean App Platform
`apps-s-1vcpu-1gb-fixed` dynamic service with one instance in the managed `ric` region, one 512 MiB
`PRE_DEPLOY` migration job built from the same verified Git source commit and Dockerfile, paid
Dedicated Egress, and one
USD 5 PlanetScale Postgres PS-5 ARM Single Node cluster in AWS `us-east-1`. App Platform's
Cloudflare-backed edge serves the one public origin and terminates TLS. PlanetScale accepts direct
PostgreSQL `verify-full` connections only from both exclusive Dedicated Egress IPv4 `/32`s, with
separate application, migration, and recovery credentials. Launch has no autoscaling,
scale-to-zero, second service, worker, application high availability, database high availability,
read replica, or automatic failover.

The database starts with 10 GB included storage, may grow once to an enforced 15 GB ceiling, and
uses backups every 12 hours retained for 84 hours. App Platform's filesystem is ephemeral and
contains no authoritative application data. Recovery uses protected Git history, an exact source
commit, the source-controlled App contracts and Dockerfile, an offline repository bundle,
Bitwarden source credentials, managed PostgreSQL recovery, and provider ownership. The owner
accepted the App Platform/Cloudflare plaintext-processing
boundary and its documented residual logging/access uncertainty on August 12, 2026. Controlled App
recreation must meet the four-hour RTO. As an explicit exception approved the same day, accidental
App deletion while a custom domain remains attached is best-effort with a maximum 24-hour domain-
binding recovery objective; that exception does not weaken any controlled recovery target.

## Reconciliation

**Locked**

- Each Fastify replica runs a small periodic reconciler for database state left behind by a crashed process.
- PostgreSQL is the source of truth for due reconciliation work.
- Replicas claim short batches transactionally with row locking and `SKIP LOCKED`.
- Reconciliation operations are small, idempotent, and recoverable.
- V1 reconciliation retains abandoned active chat/compaction work as incomplete, fails abandoned
  title work with `GENERATION_TIMEOUT`, completes answer-durable `finalizing` parents, and settles
  expired budget reservations.
- A replica stopping mid-pass leaves records eligible for another replica.
- Failures contain metadata only and are retried on a later pass.
- Context compaction and employee generations do not become background jobs.
- V1 does not add a queue, worker deployment, scheduler service, or in-memory work store.
- Polling intervals and batch sizes remain operational tuning values.

## Backup and disaster recovery

**Locked**

- Managed PostgreSQL provides encrypted automated backups and point-in-time recovery.
- PlanetScale creates backups every 12 hours and retains each for 84 hours, preserving at least 72
  continuously accessible hours of point-in-time recovery after the schedule has aged fully.
- V1 does not build a custom backup service.
- Database restoration is an operational disaster-recovery procedure, not an employee or administrator conversation-restore feature.
- A documented restore procedure must be successfully exercised before production acceptance and
  the first employee invitation. The owner-authorized August 13, 2026 direct-production path may
  provision the closed production infrastructure while the backup history ages; that state is not
  an accepted launch and receives no real employee data.
- Conversation deletion is immediate and irreversible in the active application. Deleted content
  may remain inaccessible in encrypted database backups until the approved 84-hour retention
  window expires; that operating window does not assert an undocumented physical-media schedule.
- The production recovery-point objective is at most 15 minutes and the recovery-time objective is
  at most four hours.
- The restore procedure is rehearsed against an isolated restored database before production
  acceptance and the first employee invitation. The original production database remains
  untouched during the rehearsal.

## Repository shape

**Locked**

```text
apps/
  api/       Fastify and TypeScript
  web/       Vite and React

packages/
  protocol/  Shared API and streaming contracts
  brand/     Static brand assets, tokens, fonts, and CSS adapters
```

Shared executable TypeScript is limited to transport contracts. The brand package contains static identity assets and thin CSS adapters. Backend business rules remain in the API.

## Repository tooling

**Locked**

- pnpm workspaces manage `apps/*` and `packages/*`.
- V1 does not use Turborepo, Nx, or another task orchestrator.
- All packages use ECMAScript modules and strict TypeScript.
- Biome owns formatting, linting, and import organization.
- `tsc --noEmit` runs as a separate required type check.
- The pnpm lockfile is committed.
- The repository pins its package-manager and Node runtime policy.
- Root scripts expose `dev`, `build`, `test`, `typecheck`, `check`, and `ci` workflows.
- V1 does not install Git hooks; CI is the authoritative gate.
- GitHub Actions is the v1 CI provider.
- Pull requests and the default branch run formatting and lint checks, TypeScript checks, unit tests, PostgreSQL integration tests, migrations against an empty database, and production builds.
- Playwright runs in a separate CI job so browser failures and artifacts remain easy to inspect.
- CI does not receive an OpenRouter key and never calls real models.
- Dependency caching may improve CI speed, but generated build output is not committed.
- GitHub Actions remains the authoritative validation gate for production deployment. It builds
  and smokes the production Dockerfile but does not publish a registry artifact. A protected
  named-operator workflow advances a non-force release-pointer branch to the exact green
  protected-main commit, asks App Platform to build that source with automatic deploys disabled,
  and accepts the release only when the service and migration job report that same source commit.
- A task orchestrator is added only if measured build time or dependency ordering requires it.

## Local development

**Locked**

- Developers run Fastify and Vite directly through pnpm.
- Docker Compose runs PostgreSQL only.
- `pnpm dev` starts the API and web workspace scripts in parallel.
- Vite proxies `/api` to the local Fastify process.
- Migrations and the idempotent workspace/administrator bootstrap are explicit scripts.
- A committed `.env.example` documents required variables without containing secrets.
- `FakeModelGateway` is the default local model implementation.
- Real OpenRouter calls require an explicit development key and opt-in setting.
- Tests use isolated Testcontainers PostgreSQL instances and never the developer database.
- The API container build is production-focused and is not part of the ordinary edit-refresh loop.
- Seed data contains only one workspace, an approved administrator email, and curated model placeholders.

## Configuration boundary

**Locked**

- One backend configuration module reads and validates environment variables once at startup.
- Application code receives a frozen typed configuration object and does not read `process.env` directly.
- Missing or invalid production configuration prevents the API from becoming ready.
- Environment variables hold infrastructure configuration: database connection, public origin, Better Auth secrets, OpenRouter key, email credentials, OTLP destination, ports, and deployment metadata.
- Workspace behavior such as budgets, enabled tiers, output limits, model mappings, and defaults lives in PostgreSQL.
- Secrets are not returned through APIs or written to logs.
- Startup may log a redacted summary of non-secret configuration.
- Fake providers are prohibited in production mode.
- Development and test defaults live in code; production has no insecure fallback values.
- Frontend build configuration contains only same-origin application identity and non-secret build metadata.

## API contracts and validation

**Locked**

- TypeBox is the single schema source for API requests, responses, errors, and NDJSON events.
- Fastify uses its TypeBox type provider for runtime validation, response serialization, and inferred TypeScript types.
- `packages/protocol` contains only public transport schemas and their inferred types.
- The React client may import protocol contracts but not database models or backend services.
- Stream events are validated as they are decoded.
- Unknown event types are ignored for forward compatibility.
- A malformed known event terminates the stream as a protocol error.
- Ordinary API errors share a stable envelope containing `code`, `message`, and `requestId`.
- V1 uses a small typed `fetch` wrapper instead of a generated API client or separate DTO hierarchy.

## API and deployment compatibility

**Locked**

- The private API uses `/api/*` without a public version prefix in v1.
- Contract changes are additive whenever possible.
- Existing field and event meanings are not silently repurposed.
- A breaking operation receives a new endpoint or event type.
- Fingerprinted JavaScript and CSS assets are cached immutably.
- The SPA HTML shell is not cached long-term, so a reload obtains the newest build.
- An API deployment remains compatible with the immediately preceding web build.
- Database changes follow an expand/contract sequence: add compatible schema, deploy compatible code, and remove obsolete schema only in a later deployment.
- A destructive migration is not combined with the application release that stops using the old schema.

## Browser responsibilities

**Locked**

The web application is a UI client. It is responsible for:

- Rendering history and streamed content
- Managing drafts and immediate interaction state
- Starting and aborting API requests
- Reading normalized stream events
- Rendering Markdown and providing copy interactions

The browser does not hold provider credentials, construct authoritative model prompts, calculate billing, enforce permissions, or resend conversation history to the model.

## Frontend state ownership

**Locked**

- React Router owns URLs and navigation.
- TanStack Query owns persisted server state, including conversations, history, drafts, session data, and administrative data.
- A small plain-TypeScript `ChatRuntime` owns active streams, accumulated deltas, abort controllers, and (Phase 10) durable reattachment through the updates endpoint, including the `reattaching` and `naming` phases.
- Component-local React state owns temporary presentation state.
- Active streams live outside route components and continue when navigating between conversations.
- Token deltas do not update the TanStack Query cache one chunk at a time.
- At a terminal stream event, canonical query data is updated or invalidated and reconciled with Fastify.
- Query caching is memory-only and is not persisted into browser storage.
- V1 does not use Redux, Zustand, TanStack Router, or another generalized global-state store.

## Backend responsibilities

**Locked**

Fastify owns:

- Authentication and authorization
- Workspace and employee boundaries
- Conversation state and branch selection
- Model-tier resolution and policy
- Prompt and context construction
- OpenRouter communication
- Stream normalization and cancellation
- Validation, idempotency, timeouts, and stable errors
- Usage accounting, reservations, and budgets
- Persistence and recovery of partial generations
- Authorization for every administrative operation

## Public routing and sessions

**Locked**

The SPA and API share one public origin:

```text
<chat-origin>/           -> Vite static application
<chat-origin>/api/*      -> Fastify
<chat-origin>/api/auth/* -> Better Auth through Fastify
```

Local development uses the Vite proxy for `/api`.

Better Auth uses database-backed cookie sessions. Better Auth owns users, credentials and connected accounts, sessions, verification, and password recovery. Capstone-owned tables reference the Better Auth user identifier.

The initial design does not use custom password handling, stateless JWT sessions, or Redis-backed sessions.

Fastify checks the Capstone-owned pending employee approval before forwarding an email registration to Better Auth. Successful Better Auth email verification activates the corresponding workspace membership. React does not enforce the allowlist. Deactivation blocks workspace authorization and revokes Better Auth sessions.

An explicit idempotent bootstrap command creates the initial workspace and approved administrator email without default credentials. Transactional email uses a small provider-neutral backend interface. Better Auth's organization model is not used because Capstone owns the workspace and membership boundary.

Authentication hardening uses 12–128 character passwords without composition rules, mandatory email verification, and an explicitly configured seven-day sliding session lifetime with daily refresh. Cookie session caching is disabled so revocation takes effect immediately. Password reset revokes all sessions, password change revokes other sessions, and sensitive administrative operations require a fresh session.

Better Auth rate limiting uses PostgreSQL storage so it applies across replicas. Sign-in, verification, and password-reset routes use stricter rules than ordinary authentication routes. Client IP information is accepted only from the trusted edge proxy's sanitized header. Exact rate limits and fresh-session duration remain security tuning values. MFA is outside v1.

## Content privacy outside PostgreSQL

**Locked**

- Application logs never contain prompts, responses, compaction summaries, title text, report notes
  or reasons, cursors, report/message identifiers, or raw provider/report payloads.
- Logs contain only approved content-free correlation metadata, lifecycle status, timing, token
  counts, cost, and sanitized error information.
- External observability systems receive the same bounded metadata only.
- OpenRouter input/output logging and data-discount logging remain disabled.
- Every OpenRouter request denies provider data collection and requires Zero Data Retention.
- If no eligible endpoint satisfies the privacy policy, the request fails instead of weakening the policy.

## Browser security boundary

**Locked**

- Production accepts browser requests only from the configured chat origin.
- Authentication cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`.
- State-changing Capstone endpoints accept JSON only and require an exact trusted `Origin` match.
- Credentialed CORS never permits a wildcard origin.
- Requests that bypass the configured same-origin boundary are rejected.
- Fastify applies strict request-body size limits.
- Security headers include a restrictive Content Security Policy, `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'self'`.
- The edge enables HTTP Strict Transport Security.
- Model-produced HTML is not executable.
- V1 does not add a separate CSRF-token lifecycle; same-origin cookies, strict Origin validation, JSON-only mutations, and CORS enforcement protect Capstone endpoints.
- Better Auth remains responsible for CSRF protection on its authentication routes.

## Database access and migrations

**Locked**

- PostgreSQL is the source of truth.
- Drizzle with `node-postgres` is the application database layer.
- Each API instance owns a bounded PostgreSQL connection pool.
- Auth and application schemas share one committed migration history.
- Migrations run as a deployment step, not when an API replica starts.
- Raw SQL is allowed where it is clearer than a query-builder expression.
- Transactions are used where consistency requires them, including atomic turn creation and budget reservation.

Backend modules follow the direct flow:

```text
route -> service -> explicit queries
```

Queries stay near their feature. The codebase does not introduce generic base repositories.

Long-lived streams never hold a PostgreSQL transaction or pooled connection open. Turn creation uses one short transaction to verify branch state, enforce generation concurrency, create the user message and assistant placeholder, create the generation, reserve budget, and consume the saved draft. It commits before contacting OpenRouter. Checkpoints use short independent updates, and completion uses one short transaction for final content, lifecycle state, usage, cost, and reservation settlement. Provider and browser network waits never occur inside a database transaction.

## Workspace boundary

**Locked**

The database contains a minimal workspace boundary even though v1 initially serves one company.

```text
users                    Better Auth identity
workspaces               company boundary
workspace_memberships    user, workspace, role
conversations            workspace and owning user
usage                    workspace and user
model_policies           workspace model configuration
```

Only two roles exist initially:

- `admin`
- `member`

Every business query is scoped to a workspace. Teams, groups, custom roles, and complex permission systems are not part of v1.

Each workspace stores an IANA timezone initialized to `America/Guayaquil`. Database timestamps remain UTC. V1 does not expose workspace-timezone changes in the administration interface.

Conversation reads and mutations are additionally scoped to the owning employee. Administrative authorization alone does not bypass conversation ownership.

## Core conversation storage

**Locked**

Messages form an immutable tree. Each message has one optional `parent_message_id`, and a conversation records its selected leaf.

```text
User message
`-- Assistant response A
    `-- Next user message
        |-- Assistant response B
        `-- Assistant response C
```

- Editing creates a new user-message branch.
- Trying again creates an assistant sibling.
- Undo moves the selected leaf backward.
- Selecting another answer changes the visible branch.
- Existing messages are not overwritten.

Message content is stored as typed JSON blocks. V1 supports a text block whose contents may contain Markdown:

```json
[
  { "type": "text", "text": "Here is the answer..." }
]
```

## Optimistic revisions

**Locked**

- Each conversation has a monotonic structural revision.
- Each server-side draft has its own revision.
- Conversation mutations include the revision last observed by the browser.
- A stale mutation returns `CONVERSATION_CHANGED` instead of silently mutating outdated state.
- The browser preserves its local draft, refetches canonical state, and asks the employee to retry.
- Draft autosaves use compare-and-swap against their revision.
- A stale draft stops autosaving and lets the employee choose the server draft or deliberately replace it with the local draft.
- Streaming checkpoints do not increment the structural conversation revision.
- Structural branch selection, edit, try again, send, terminal completion, archive, and deletion increment the revision where applicable.
- Idempotency keys prevent duplicate submission, while revisions protect against distinct stale requests.

## Conversation search

**Locked**

- Fastify performs PostgreSQL full-text search over conversation titles and message text.
- Search behavior is independent of the Spanish product-interface language.
- PostgreSQL indexes a derived language-neutral representation using the `simple` text-search configuration with case and accent normalization; stored titles and messages are not rewritten for search.
- The final query term supports prefix matching so results can appear naturally while the employee types.
- Title matches rank above message matches. Relevance determines result order before recency is used as a tie-breaker.
- Every search is scoped to the owning employee and workspace.
- Search includes archived conversations and identifies them as archived in each result.
- All preserved branches, including alternative answers, are searchable.
- A result identifies the matching message and resolves a concrete preserved branch leaf containing it.
- Opening a result persistently selects that branch leaf. It increments the structural conversation revision only when the selected branch changes.
- Derived compaction summaries are not indexed.
- Deleted content is removed from the search index.
- Results contain short highlighted snippets rather than complete messages.
- V1 does not add language-specific stemming or fuzzy typo correction.
- V1 does not use embeddings, semantic search, Elasticsearch, or another external search service.

## History pagination

**Locked**

- Conversation lists, conversation branches, and search results use opaque cursor pagination.
- The sidebar orders conversations by most recently updated first.
- Opening a conversation loads the recent portion of its selected branch.
- Scrolling upward loads older ancestors while preserving viewport position.
- Messages are returned whole rather than split across pages.
- Visible messages include alternative-branch counts, while full sibling branches load only when selected.
- The browser never requests an employee's complete history in one call.
- V1 does not use offset pagination or message-list virtualization.
- Exact page sizes remain an operational tuning decision.

## Draft storage

**Locked**

- Fastify persists one draft per employee and conversation.
- A draft with no conversation represents the new-chat composer.
- The browser holds the immediate typing state in memory and autosaves it through a debounced API request.
- Sending a message atomically consumes the matching draft.
- Deleting a conversation also deletes its draft.
- Draft content follows message ownership, logging, and privacy rules.
- Persistent browser storage is not used for draft content.

## Verification strategy

**Locked**

- Vitest covers domain logic, protocol parsing, services, and deterministic frontend utilities.
- Testcontainers PostgreSQL runs database integration tests against the real schema and migrations.
- Playwright covers complete browser flows and response rendering.
- `FakeModelGateway` can deterministically emit chunks, delays, usage, failures, and cancellations.
- Normal CI never calls OpenRouter; content-free recorded fixtures verify OpenRouter event translation.
- Fastify's in-process injection covers ordinary HTTP routes.
- Streaming, disconnect, cancellation, and backpressure tests use a real local HTTP listener.
- Database tests cover branching, workspace isolation, idempotency, concurrent budget reservations, search, deletion, and reconciliation.
- Browser tests cover sending, stopping, editing, trying again, branch switching, Markdown, copying, scrolling, connection recovery, and admin authorization.
- Critical streaming, cancellation, composer-keyboard, scrolling, and Markdown-overflow flows run across Chromium, Firefox, and WebKit. The broader browser suite may run primarily in Chromium to keep CI practical.
- A fixed response-format gallery supports Playwright visual checks.
- V1 avoids broad snapshot tests and mocked database behavior.
- Applying every migration to an empty PostgreSQL database is a required CI check.

## Observability

**Locked**

- Fastify/Pino emits structured JSON logs.
- New Relic Free is the single external v1 application/log telemetry destination.
- Fastify sends application traces and metrics directly by OTLP. One bounded in-process adapter
  mirrors an explicit content-free Pino field allowlist to New Relic's HTTPS Log API; it has bounded
  memory, time, retries, and shutdown, no disk buffer, and drops telemetry rather than blocking the
  product.
- DigitalOcean App Platform Insights and alerts own deployment, domain, job, CPU, memory, restart,
  request, and latency signals. One DigitalOcean Uptime check independently owns public
  readiness/TLS/latency. PlanetScale's protected dashboard owns database performance, storage,
  connections, backups, WAL, and Query Insights. V1 does not copy those provider-native signals
  into New Relic with an infrastructure agent, collector, sidecar, scraper, or second backend.
- Fastify emits backend traces and application metrics through vendor-neutral OpenTelemetry OTLP.
- V1 does not use OpenTelemetry browser instrumentation.
- A sanitized frontend-error endpoint captures UI failures without conversation content.
- Requests and generations carry correlation identifiers.
- A generation uses one span with lifecycle events rather than a span per streamed chunk.
- Launch traces every meaningful successful application request and every failure. Successful
  liveness/readiness probes retain aggregate metrics but do not create traces; failed probes do.
- V1 does not install a proprietary New Relic backend agent, browser agent, collector service,
  separate log stack, or application-performance sidecar.
- Browser failures are reduced to a small content-free metadata event and reported through Fastify;
  arbitrary browser error messages, stack traces, URLs, prompts, and responses are not exported.
- Metrics cover active streams, request duration and errors, time to first token, total generation duration, throughput, tokens and cost by tier, compaction, PostgreSQL pool health, budget reservation failures, and reconciler lag.
- Conversation IDs, user IDs, and raw OpenRouter model IDs are not used as metric labels.
- Access-controlled logs and traces may contain identifiers and operational metadata, but never prompts, responses, or compaction summaries.
