# Development Roadmap

Status: locked for v1 sequencing

## Delivery rule

**Locked**

Development proceeds through small, dependency-ordered milestones. Each milestone ends with a runnable, demoable vertical checkpoint and proportional automated verification. Capstone does not develop multiple milestones simultaneously or introduce speculative abstractions for later milestones.

The order controls implementation, not product priority. All previously locked v1 requirements remain in scope unless explicitly amended.

## Milestones

### 1. Foundation

Establish workspace tooling, the Fastify API, React application, shared protocol package, PostgreSQL connectivity and migrations, typed configuration, health checks, automated tests, GitHub Actions, and the production API container.

The approved Foundation batch includes:

- A pnpm workspace containing `apps/api`, `apps/web`, `packages/protocol`, and the existing `packages/brand`.
- Strict TypeScript, ECMAScript modules, Biome, Vitest, React Router, and TanStack Query.
- Centralized typed configuration and a committed `.env.example`.
- Fastify structured logging, request IDs, liveness, readiness, and graceful-shutdown foundations.
- A branded Vite and React shell that fetches API readiness through the local `/api` proxy.
- Docker Compose for PostgreSQL only.
- Drizzle, `node-postgres`, a migration runner, and Testcontainers database smoke coverage.
- Root `dev`, `build`, `test`, `typecheck`, `check`, and `ci` commands.
- GitHub Actions, a production API container, and local-development documentation.

Foundation acceptance requires `pnpm install`, `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` to succeed, and `pnpm dev` to start the API and web application with the proxied readiness check working.

Foundation creates only the protocol package structure and basic shared primitives. The complete NDJSON event and stable error-code catalog is authored and approved before Milestone 4, then encoded as the package's TypeBox schemas.

Foundation explicitly excludes Better Auth, employee and workspace tables, conversation tables, OpenRouter, streaming, and chat UI behavior.

### 2. Identity

Integrate Better Auth, workspace membership, administrator bootstrap and employee approval, fake local email delivery, authorization boundaries, verification, session revocation, and approved authentication hardening.

### 3. Conversation core

Implement the immutable message tree, conversation creation and management, structural revisions, server-side drafts, history pagination, archive and deletion behavior, and PostgreSQL search.

### 4. Streaming chat

Implement the complete NDJSON contract, `FakeModelGateway`, composer, frontend `ChatRuntime`, incremental rendering, persistence checkpoints, idempotency, cancellation, interruption recovery, and terminal outcomes.

### 5. Conversation controls

Implement editing, trying again, undo, branch navigation, scroll behavior, answer and code copying, Markdown and mathematics presentation, and the fixed response-format gallery.

### 6. OpenRouter and cost control

Implement the curated model catalog, live ZDR eligibility validation, tier mappings, `OpenRouterGateway`, generation accounting, hard workspace budget reservations, settlement, cancellation accounting, and reconciliation.

Before hard budget enforcement is enabled, bootstrap configuration supplies an explicit initial monthly USD workspace budget. V1 does not rely on an undocumented numeric default while the administration UI is still pending.

### 7. Compaction and administration

Implement context compaction and fallback behavior, employee administration, model policy controls, tier availability and output limits, workspace budgets, and usage and cost tables.

### 8. Production hardening

Complete observability, cross-browser and accessibility verification, performance and load testing, deployment integration, production-secret wiring, operational runbooks, and the required disaster-recovery rehearsal.

## Deferred launch choices

The production venue, transactional email provider, exact tier models, numeric operating limits, backup retention, recovery objectives, and observability destination are selected before the milestone that needs them. They do not block foundation development.
