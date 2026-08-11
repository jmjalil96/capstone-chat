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

## Production launch baseline

**Locked for Milestone 8**

- The production candidate is one DigitalOcean Basic shared-CPU Droplet with one vCPU and 1 GiB RAM
  in RIC1, one encrypted 1 GiB DigitalOcean Volume, and one PlanetScale Postgres PS-5 ARM Single
  Node cluster in AWS `us-east-1`. Launch has one active application instance and one single-node
  database with no application autoscaling, database high availability, read replica, or automatic
  failover. The exact managed topology remains provisional until the separately authorized
  production-shaped rehearsal passes every unchanged gate twice.
- The public origin is `https://chat.capstone.com.ec`. Its DNS-only IPv4 record targets the
  Droplet's reserved address directly; Caddy owns TLS and proxies only to the active loopback-bound
  application slot. Only 80/443 are public, and SSH is limited to the approved operator `/32`.
- PlanetScale accepts new connections only from the verified Droplet `/32`. Production uses direct
  port 5432, `verify-full` TLS, a least-privilege application role, a separate migration role, and a
  recovery-only provider credential. The database starts at 10 GB with a hard 15 GB storage
  ceiling.
- GitHub Actions remains the authoritative gate. It publishes an immutable, exact-revision GHCR
  image only after checks pass. A named operator explicitly runs the audited migration and
  blue/green deployment path; migrations never run during API startup. The immediately previous
  compatible digest remains available for rollback.
- PlanetScale backups run every 12 hours and are retained for 84 hours, preserving at least three
  continuously accessible days of point-in-time recovery. Production retains an RPO of at most 15
  minutes and an RTO of at most four hours. An isolated database restore and a source-controlled
  cold Droplet rebuild are required before launch; no paid Droplet backup is used.
- Resend Free sends transactional mail through direct HTTPS calls from Fastify. The verified sending
  domain is `mail.capstone.com.ec`, and the sender is
  `Capstone Chat <no-reply@mail.capstone.com.ec>`. Templates provide Spanish HTML and plain text.
  V1 adds no Resend SDK, email queue, worker, webhook, inbound mail, or marketing mail.
- New Relic Free is the single external application/log telemetry destination. Fastify exports
  vendor-neutral OTLP traces and application metrics; one bounded Fluent Bit host process forwards
  content-free application JSON logs. DigitalOcean Monitoring owns host infrastructure signals and
  PlanetScale's protected dashboard owns database signals. V1 adds no proprietary backend or
  browser agent, infrastructure collector, second telemetry backend, or employee content export.
- Production secret source copies live in the Capstone Bitwarden Teams organization. Runtime copies
  are narrowly permissioned read-only files on the encrypted Volume. The initial one-owner setup
  has MFA and a sealed offline recovery kit; adding a second recovery owner is deferred and remains
  a visible launch risk.
- The approved starting operational baseline is USD 15.10/month: USD 11.10 infrastructure plus one
  USD 4 Bitwarden Teams owner, before taxes, variable backup/network charges, temporary resources,
  and model use. At the 15 GB database ceiling it is approximately USD 15.73/month. No resource
  tier or storage ceiling changes without an explicit decision.
- Production maps Fast to `deepseek/deepseek-v4-flash-0731`, Balanced to
  `deepseek/deepseek-v4-pro`, and Pro to `moonshotai/kimi-k3`.
- The monthly workspace ceiling is USD 100. Fast, Balanced, and Pro output ceilings are 4,096,
  8,192, and 16,384 tokens. Each employee may run two chat workflows in separate conversations.
  Cost reservations use a 20% margin, expire after 15 minutes, and model metadata refreshes hourly.
- Generation limits are 10 seconds to upstream headers, 60 seconds to the first visible model event,
  45 seconds without a stream event, five minutes total, and 10 seconds for a bounded authoritative
  usage lookup. Connected downstream responses emit a content-free heartbeat every 15 seconds, and
  the browser treats 35 seconds without response bytes as an interrupted stream before adopting
  canonical durable state.
- Launch capacity is 20 registered employees, 20 simultaneously signed-in employees, and 40 active
  employee streams under ordinary internal-chat traffic. Hidden compaction is sequential within an
  admitted workflow rather than a forty-first class of employee concurrency.
- From Ecuador on normal broadband, the authenticated chat should become usable at p95 within two
  seconds. Ordinary API requests target p95 at or below 300 ms and p99 at or below 750 ms; admitted
  send through `response.started` targets p95 at or below 500 ms; receipt of a model chunk through
  visible browser presentation targets p95 at or below 100 ms; and cancellation reaches the local
  UI immediately and backend abort handling at p95 within 500 ms. Provider time to first token is
  reported separately rather than hidden inside application latency.
- The capacity run must have zero malformed streams, unexpected 5xx responses, database-pool
  exhaustion, sustained memory growth, and cross-employee data leakage.
