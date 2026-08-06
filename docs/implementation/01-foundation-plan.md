# Phase 1 — Foundation Implementation Plan

Status: implemented; awaiting review  
Code authorization: granted

## Objective

Create the smallest production-shaped foundation that proves the repository, API, web application, PostgreSQL integration, shared contracts, tests, CI, and API container work together.

Phase 1 establishes conventions that later phases extend. It does not implement a partial version of authentication, conversations, chat, model access, cost control, or administration.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its decision policy.
3. `docs/prd/02-system-architecture-and-data.md`, especially architecture, deployment shape, repository shape, tooling, local development, configuration, API contracts, testing, and observability boundaries.
4. `docs/prd/05-brand-system.md` for the light theme, typography, color, logo, accessibility, and product-voice rules used by the foundation shell.
5. `docs/prd/06-development-roadmap.md`, especially the approved Foundation scope and exclusions.
6. The Product language, browser support, and application-shell sections of `docs/prd/01-product-scope-and-experience.md`.
7. `packages/brand/README.md`, `packages/brand/package.json`, and its exported CSS and assets.
8. Current `git status`, existing files, configured remotes, and available Node, pnpm, Docker, and Git tooling.

At implementation time, dependency and configuration details must be checked against current official documentation for pnpm, Node.js, TypeScript, Biome, Fastify, TypeBox, Vite, React, React Router, TanStack Query, Drizzle, `node-postgres`, Vitest, Testcontainers, Playwright, Docker, and GitHub Actions. The repository pins the selected supported versions in its manifest and lockfile; this plan does not freeze versions before implementation begins.

Phase 1 does not need the detailed implementation sections for authentication, conversations, streaming, OpenRouter, budgets, compaction, or administration. Those PRDs remain authoritative boundaries, but loading their full implementation detail must not encourage premature code.

## Dependency direction

```text
apps/api  ───────> packages/protocol
apps/web  ───────> packages/protocol
apps/web  ───────> packages/brand

packages/protocol ──> TypeBox only
packages/brand    ──> no runtime TypeScript dependency
```

- `apps/api` never imports from `apps/web`.
- `apps/web` never imports API internals, database types, or backend services.
- `packages/protocol` contains transport schemas and inferred types, not services or business rules.
- Phase 1 introduces no additional shared package.

## Work plan

Work proceeds in this order. Each step must leave the repository coherent before the next begins.

### 1. Preflight and version selection

- Confirm the worktree state and preserve every existing brand and PRD file.
- Confirm the locally available Node, pnpm, and Docker environment.
- Review current official documentation and select mutually supported stable versions.
- Record the Node policy and exact pnpm version in normal repository metadata.
- Stop for direction only if a current dependency requirement would materially contradict a locked decision.

Deliverable: a short implementation note in the final handoff listing the selected runtime and major dependency versions and any compatibility constraint that influenced them.

### 2. Root workspace and tooling

- Create the pnpm workspace for `apps/*` and `packages/*`.
- Add the root package manifest and committed pnpm lockfile.
- Add one strict shared TypeScript configuration with small package-specific extensions.
- Configure Biome as the only formatter, linter, and import organizer.
- Add root `dev`, `build`, `test`, `typecheck`, `check`, and `ci` commands using pnpm workspace execution; do not add an orchestrator.
- Add only the repository ignore rules required by the approved tools and generated output.

Deliverable: every workspace is discoverable from the root, and one command exists for each approved lifecycle operation.

### 3. Shared protocol foundation

- Create `packages/protocol` as a private strict TypeScript ESM package.
- Use TypeBox as its only schema system.
- Define only the schemas and inferred types needed by Phase 1: liveness, readiness, and the common API error envelope.
- Export public contracts through a small explicit entrypoint.
- Test successful and rejected validation cases.

Boundary: do not define conversation DTOs, authentication contracts, model tiers, generation records, stable feature-error codes, or NDJSON events. The complete stream and error catalog remains a required artifact before Phase 4.

### 4. Fastify API foundation

- Separate construction of the Fastify application from the process entrypoint so routes can be tested without opening a port.
- Add one frozen typed configuration module that reads environment variables once.
- Phase 1 configuration contains only values Phase 1 consumes, such as runtime mode, host, port, database URL, public origin, and log level.
- Configure structured Pino logging, request IDs, and secret-safe startup metadata.
- Add `GET /api/health/live`. It reports process liveness without contacting PostgreSQL or another dependency.
- Add `GET /api/health/ready`. It reports ready only after startup succeeds and PostgreSQL responds; it returns an unavailable status while starting, unhealthy, or draining.
- Validate and serialize health and error responses with the shared TypeBox contracts.
- Add graceful process shutdown: mark the instance draining, reject readiness, close Fastify, and close the PostgreSQL pool.
- Keep route registration, configuration, database construction, and process lifecycle explicit; do not introduce a dependency-injection container or application framework around Fastify.

Boundary: graceful shutdown covers HTTP and the database pool only. There is no stream registry, reconciler, job runner, authentication hook, or authorization layer in Phase 1.

### 5. PostgreSQL and migrations

- Create one bounded `node-postgres` pool owned by the API process.
- Configure Drizzle and an explicit migration command.
- Prove that migrations run successfully against a clean PostgreSQL database.
- Do not create a domain table merely to make the migration directory non-empty. If tooling requires a baseline artifact, it must contain no product schema.
- Add an integration test that starts isolated PostgreSQL with Testcontainers, applies all migrations, and verifies API readiness.
- Verify that database unavailability makes readiness fail while liveness remains healthy.
- Add Docker Compose containing PostgreSQL only for local development.

Boundary: do not enable search extensions or create users, workspaces, sessions, approvals, conversations, drafts, messages, generations, models, budgets, usage, compactions, idempotency, or reconciliation tables.

### 6. Vite and React foundation

- Create the strict TypeScript Vite and React application.
- Install React Router and TanStack Query and establish their root providers without adding feature routes or server-state abstractions.
- Import `@capstone/brand/styles.css` once at the application root.
- Add a minimal app-level semantic CSS layer derived from brand variables; do not create a component library or second token system.
- Centralize the few Phase 1 Spanish strings in one TypeScript copy module.
- Add a tiny typed fetch function for API readiness that validates the response against `packages/protocol`.
- Configure the development proxy so `/api` reaches Fastify.
- Render a restrained branded foundation screen that shows loading, ready, and unavailable states and uses an approved logo asset.
- Preserve visible focus, semantic status output, reduced-motion behavior, and responsive layout.

Boundary: the foundation screen is not the product chat shell. Do not add the conversation sidebar, new-chat flow, composer, messages, Markdown rendering, model picker, search, authentication screens, admin screens, or placeholder controls for later features.

### 7. Automated verification

- Use Vitest for protocol, configuration, API, and deterministic web utility tests.
- Use Fastify injection for ordinary health-route behavior.
- Use Testcontainers PostgreSQL for migration and readiness integration tests.
- Add a minimal Playwright smoke test for the branded foundation screen in a separate test command and CI job.
- Keep fixtures content-free and deterministic.
- Do not set arbitrary coverage percentages; test the Phase 1 contracts and failure paths directly.

Required Phase 1 cases:

- Valid development configuration starts successfully.
- Invalid production configuration prevents readiness.
- Liveness succeeds without a database query.
- Readiness succeeds with PostgreSQL and fails without it.
- Health responses conform to the shared schemas.
- The web client handles ready, loading, malformed, and unavailable health results.
- Every migration applies to an empty Testcontainers database.
- Graceful shutdown closes the HTTP server and database pool without hanging.
- The branded page renders and exposes its status accessibly.

### 8. CI, container, and documentation

- Add GitHub Actions for installation with the frozen lockfile, Biome checks, type checking, unit and integration tests, clean migrations, production builds, and the API container build.
- Run Playwright in a separate job and retain useful failure artifacts.
- Do not provide OpenRouter, Better Auth, or email secrets to CI.
- Create a production-focused, multi-stage OCI build for `apps/api` with a minimal runtime and non-root process where supported.
- Build the Vite application as static output, but do not choose or configure a hosting vendor.
- Add `.env.example` containing only Phase 1 configuration with safe local examples and no secrets.
- Document prerequisites, PostgreSQL startup, migrations, development, tests, builds, health endpoints, and the API container.
- Do not add deployment automation, cloud manifests, secret-manager wiring, or a production database configuration.

## Phase boundary

The following are explicitly forbidden in Phase 1, including as placeholders or preinstalled dependencies unless Phase 1 itself requires them:

### Phase 2 — Identity

- Better Auth and its database schema
- User, workspace, membership, approval, verification, or session tables
- Cookies, sign-in, sign-up, sign-out, password, or authorization routes
- Email interfaces or fake/real email providers
- Administrator bootstrap or employee seed data

Phase 1 supplies only the migration command that Phase 2 will later use.

### Phase 3 — Conversation core

- Conversation, message, draft, branch, archive, deletion, or search schemas
- PostgreSQL full-text-search extensions, indexes, or helpers
- Conversation routes, cursor pagination, revisions, or idempotency storage

### Phase 4 — Streaming chat

- `ModelGateway`, `FakeModelGateway`, or provider event translation
- NDJSON response routes, event schemas, streaming utilities, checkpoints, cancellation, or `ChatRuntime`
- Composer or assistant-response state

### Phase 5 — Conversation controls and rendering

- Markdown, mathematics, or syntax-highlighting dependencies
- Edit, try again, undo, branch controls, scrolling systems, or copy actions
- A response-format gallery

### Phase 6 — OpenRouter and cost control

- OpenRouter SDKs, keys, configuration, catalog calls, or model metadata
- Tier policy, generation accounting, budgets, reservations, cost settlement, or reconciliation

### Phase 7 — Compaction and administration

- Compaction prompts or summaries
- Employee, model, budget, or usage administration screens and routes

### Phase 8 — Production hardening

- OpenTelemetry SDKs or an observability vendor
- Load-test infrastructure
- Hosting-vendor configuration or deployment automation
- Production secret-manager integration
- Backup or disaster-recovery automation

The production API container, structured logging, health endpoints, graceful shutdown foundation, and GitHub Actions belong to Phase 1 because they validate the architecture early. They must not expand into Phase 8 deployment work.

## Acceptance procedure

From a clean dependency install and with Docker available:

1. Install dependencies with the repository-pinned pnpm version.
2. Start local PostgreSQL with Docker Compose.
3. Apply all migrations explicitly.
4. Run `pnpm check`.
5. Run `pnpm typecheck`.
6. Run `pnpm test`.
7. Run `pnpm build`.
8. Start `pnpm dev` and verify:
   - the API liveness endpoint responds;
   - readiness reports PostgreSQL as ready;
   - the Vite application reaches readiness through `/api` and shows the Spanish ready state;
   - stopping PostgreSQL leaves liveness healthy and changes readiness and the web state to unavailable.
9. Build and start the production API container against an explicit test database and verify both health endpoints.
10. Confirm the GitHub Actions workflow covers the same gates and the separate Playwright smoke job.
11. Audit dependencies, routes, database schema, and UI to confirm none of the forbidden later-phase concerns were introduced.

## Definition of done

Phase 1 is complete only when:

- The approved root commands succeed.
- A clean database accepts the complete migration history.
- The local API, web application, and PostgreSQL integration work together.
- Health, configuration, shutdown, and database failure behavior are tested.
- The production API image builds and runs.
- CI represents the local quality gates without real-provider secrets.
- Documentation lets another developer reproduce the environment without unstated steps.
- The final diff contains no Phase 2–8 feature code, schema, dependencies, or placeholder architecture.
- Any failed or unavailable verification is reported explicitly rather than treated as complete.

Completion of Phase 1 authorizes no automatic work on Phase 2. Phase 2 begins only after Phase 1 is reviewed and explicitly approved.
