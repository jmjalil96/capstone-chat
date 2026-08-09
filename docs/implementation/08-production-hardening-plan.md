# Phase 8 — Production Hardening Implementation Plan

Status: repository implementation complete on 2026-08-08; production acceptance pending

Code authorization: granted for repository changes. Render, Resend, New Relic, DNS, paid inference,
and paid recovery-resource mutations remain separately gated as described below.

## Planning record

- Planning began on 2026-08-08 after the user accepted the verified Phase 7 implementation and
  chose the remaining production-launch inputs in small decisions.
- The frozen implementation baseline is commit `5957485`
  (`Implement Phase 7 compaction and administration`), also `origin/main` before these planning
  documents. The baseline passed strict TypeScript, all production builds, 729 deterministic tests
  (188 protocol, 341 API/PostgreSQL, and 200 web), the configured Playwright matrix 25/25, and the
  repository-scoped Biome check over 250 files.
- The production API image built and ran as non-root UID 1000. High/critical production dependency
  audit, migration review, secret scans, boundary review, and `git diff --check` passed.
- Existing non-blocking baseline notes remain visible rather than being attributed to Phase 8: Vite
  reports a `930.41 kB` raw / `261.05 kB` gzip application chunk, the development toolchain retains
  one moderate transitive advisory, and abrupt local Playwright fixture teardown can leave its
  launcher briefly alive. Bundle splitting and bounded fixture shutdown are Phase 8 work only where
  they directly support production performance and reliable verification.
- No paid OpenRouter generation was used to prepare this plan. The development key pasted in the
  planning conversation is compromised for production purposes and must be rotated before any
  production secret is installed.
- The approved launch decisions are now recorded in the governing PRDs. This document derives the
  implementation and verification work from those locked decisions; it does not create a parallel
  product contract.

## Objective

Turn the accepted Phase 7 product into a measured, observable, recoverable production deployment
for Capstone's initial 15–20 employees without changing what the product does.

One Render Web Service serves the built React application and Fastify API from
`https://chat.capstone.com.ec`. One Render managed PostgreSQL database remains the source of truth.
Resend delivers transactional identity mail. New Relic receives content-free platform and
application telemetry. The exact approved OpenRouter policy is bootstrapped explicitly. Deployment,
rollback, incident response, secret rotation, and database recovery are documented and rehearsed.

Production readiness is earned through the full automated suite, browser and accessibility review,
the locked 20-user/40-stream capacity exercise, a real Ecuador latency check, a small authorized
OpenRouter smoke, and an isolated point-in-time-restore rehearsal. Phase 8 does not add another
product feature, service, queue, worker, cache, analytics platform, or generalized infrastructure
layer.

## Plan approval decisions

Approval of this plan locks the following Phase 8 interpretations. They are deliberately the
smallest complete implementation of the production baseline.

1. Render hosts one paid Docker Web Service and one paid managed PostgreSQL database in Virginia.
   Both belong to one Render Pro workspace and communicate through Render's private network.
2. Launch runs exactly one application instance. PostgreSQL high availability, read replicas,
   horizontal application scaling, Redis, a separate static-site service, workers, cron services,
   and queues are not added.
3. Exact Render compute and database sizes are not guessed. Phase 8 begins with the smallest paid
   candidates capable of running the production image, tests them under the locked workload, and
   records the smallest passing sizes before declaring production ready. Scaling is vertical only
   for launch.
4. The existing OCI image becomes the single deployable artifact. Its build includes
   `packages/brand`, `packages/protocol`, the Vite production assets, and Fastify. Runtime still
   executes only the non-root API process.
5. Fastify serves fingerprinted web assets and the SPA shell. API and authentication routes always
   take precedence, and an unknown `/api/*` route is never rewritten to `index.html`.
6. Fingerprinted assets receive immutable caching. The HTML shell and non-fingerprinted deployment
   metadata are revalidated or uncached. NDJSON and every authenticated API response remain
   `no-store`; streams additionally use `no-transform`.
7. Render deploys the Git-linked `main` branch only after GitHub checks pass. The committed
   `render.yaml` supplies the Docker build, readiness path, private database reference, migration
   pre-deploy command, custom domain, and graceful-shutdown limit. It contains no secret value.
8. Migrations remain an explicit pre-deploy operation. They never run during application startup.
   Every migration used in Phase 8 remains expand/contract compatible with the immediately previous
   application build.
9. The initial empty production database is provisioned before the web replica. An operator uses a
   temporary external database allowlist restricted to their current IP to run migrations and the
   exact production model-policy bootstrap. Resend DNS/key/sender and the final public origin are
   verified before the existing identity bootstrap, because that command sends the initial
   administrator invitation. The allowlist is then set to empty and private networking is verified
   before public launch. No bootstrap route, permanent administration tunnel, or deployment worker
   is added.
10. The production origin is exactly `https://chat.capstone.com.ec`. Render's generated subdomain is
    disabled only after custom DNS, TLS, readiness, authentication redirects, and streaming have
    been verified on the custom origin.
11. HSTS is emitted only in the final HTTPS production deployment, with one-year `max-age` and
    without `includeSubDomains` or preload. Capstone Chat must not make a security decision for
    unrelated `capstone.com.ec` hosts.
12. Production client-IP rate limiting uses one deployment-owned resolver for Render's trusted
    edge-sanitized client address, currently `CF-Connecting-IP`. It accepts exactly one valid IP and
    never trusts a browser-supplied leftmost `X-Forwarded-For` value. Local development and tests
    retain socket IP behavior. The resolved value is passed to Better Auth only through the existing
    private Capstone header boundary.
13. Resend is added as the third `EmailSender` implementation. Fastify calls
    `POST https://api.resend.com/emails` with native `fetch`; no Resend SDK is installed.
14. Production requires `EMAIL_DELIVERY=resend`, a send-only domain-restricted API key, and the
    exact sender `Capstone Chat <no-reply@mail.capstone.com.ec>`. Fake and disabled delivery remain
    development/test choices and are rejected in production.
15. Invitation, verification, and password-reset messages each have centralized Spanish plain-text
    and simple escaped HTML bodies. The HTML uses the approved brand tokens but introduces no React
    email renderer, template engine, remote image, tracking pixel, attachment, or marketing footer.
16. Each Resend request has a bounded timeout and response body, validates the returned message ID,
    supplies one UUID idempotency key for that transport attempt, and reports only provider
    status/category and timing. A later deliberate resend is a new attempt; Phase 8 does not claim
    cross-invocation idempotency without persisted delivery state. Recipient addresses, URLs,
    tokens, response bodies, and credentials never enter logs, traces, or metrics. Resend open and
    click tracking are verified disabled before launch.
17. Email delivery keeps the accepted best-effort request semantics. Public identity requests do
    not await provider latency and therefore retain enumeration-safe timing. Their promises belong
    to one application-lifecycle tracker that removes settled work and boundedly drains or aborts
    remaining sends during shutdown; no untracked detachment is introduced. Operator invitation
    commands continue awaiting their send. Phase 8 adds no retry queue, worker, webhook, or
    delivery-status database. A failed send is observable and can be retried only through an
    existing deliberate user/operator flow.
18. New Relic Free is the sole v1 observability destination. Render streams its platform logs and
    infrastructure metrics directly. Fastify sends application traces and metrics using standard
    OTLP over HTTPS/protobuf. No New Relic application agent, browser agent, OpenTelemetry collector,
    log-forwarding sidecar, or second telemetry backend is added.
19. Fastify uses narrow manual instrumentation rather than broad automatic Node or SQL
    instrumentation. This prevents URLs, query text, SQL, email addresses, prompts, responses,
    compaction summaries, and raw provider payloads from being captured implicitly.
20. Meaningful successful application requests and all failures are traced at launch. Successful
    liveness/readiness polls are omitted from traces but retain aggregate metrics; failed probes are
    traced. Sampling can be reduced later only from measured New Relic volume and without dropping
    errors.
21. Request spans record the route template, method, status family, request ID, release, and bounded
    timing. They do not record raw URLs, query strings, bodies, session tokens, user content, or
    high-cardinality user/conversation/model identifiers as metric labels.
22. One additional span represents each actual model call, including hidden compaction, with
    content-free lifecycle events and tier/purpose/outcome. Deltas never create spans or events.
    Provider time to first token remains a separately measured upstream value.
23. A small same-origin `POST /api/client-errors` endpoint accepts only a closed TypeBox metadata
    schema: an approved error kind, route category without object IDs, release, and optional
    sanitized asset/line/column fields. It rejects messages, stack traces, complete URLs, query
    strings, arbitrary objects, and content. React's error boundary and global error/rejection hooks
    deduplicate and send these reports best-effort. A narrow PostgreSQL fixed-window limiter allows
    at most 10 accepted reports per normalized client-address hash per minute and 200 globally per
    minute, with bounded stale-window cleanup. This endpoint does not depend on Better Auth's
    internal rate-limit table and adds no process-local authority.
24. Application metrics cover HTTP latency/error rate, `response.started` latency, provider first
    token, total generation duration, throughput/tokens/cost by tier and purpose, active streams,
    compaction outcomes, database-pool total/idle/waiting, budget reservation failures, and
    reconciler lag. Labels stay low-cardinality and content-free.
25. Telemetry export is never a product availability dependency after valid startup configuration.
    Missing or invalid production OTLP configuration fails startup; a temporary New Relic outage
    does not make readiness fail. Shutdown performs one bounded telemetry flush after request drain.
26. Launch capacity is 20 registered employees, 20 simultaneous authenticated sessions, and 40
    active chat streams because the approved per-employee limit is two. A sequential hidden
    compaction remains inside its already admitted chat workflow.
27. The primary capacity test uses `FakeModelGateway` and non-sensitive generated fixtures. It sends
    40 simultaneous streams plus representative history, draft, session, readiness, tier, and admin
    traffic. It validates complete NDJSON, authorization isolation, cancellation, settlement, and
    database-pool behavior without paid inference variability.
28. The load harness is a bounded opt-in Node/TypeScript script using native `fetch` and the shared
    NDJSON schemas. No k6, Artillery, autocannon, permanent test route, hosted load service, or
    long-running benchmark dependency is added.
29. The production container is first tested locally with CPU and memory limits matching each
    candidate Render size and a representative PostgreSQL pool. Exact managed Web Service/database
    sizing and deploy-drain evidence then use a disposable isolated Render rehearsal environment:
    the same image, candidate sizes, a non-production origin, a separate database, and test runtime
    configuration that permits the fake gateway while production continues to reject it. The fake
    seam supports deterministic per-workflow canaries, delays, cancellation, and terminal failures
    without a test-only HTTP route. Creating this paid environment requires immediate user approval;
    it is destroyed after evidence is accepted and never becomes permanent staging.
30. From Ecuador on normal broadband, an authenticated cold and warm navigation sample must show
    the composer usable at p95 within two seconds. Ordinary API p95 must be at most 300 ms and p99
    at most 750 ms; admitted send through `response.started` p95 at most 500 ms; received chunk
    through visible DOM p95 at most 100 ms; backend cancellation p95 at most 500 ms while the local
    UI changes immediately.
31. Provider time to first token, provider generation duration, and application overhead are
    reported separately. The 60-second first-event and five-minute total ceilings are reliability
    bounds, not acceptable performance targets.
32. A measured bottleneck may be fixed directly. The expected first web optimization is route-level
    lazy loading at existing identity/chat/admin React Router boundaries, especially administration.
    No new router, global state library, component system, or speculative performance abstraction is
    introduced.
33. Automated accessibility uses `@axe-core/playwright` against representative authenticated and
    unauthenticated states, desktop and mobile shell states, streamed/terminal answers, the response
    gallery, and administration. Every finding is reviewed; serious or critical findings are zero.
34. The critical browser suite runs in Chromium, Firefox, WebKit, branded current Chrome, and
    branded current Edge, with iPhone WebKit and Android Chrome emulation. Manual checks cover full
    keyboard operation, focus, VoiceOver on Safari, reduced motion, 200%/400% zoom, horizontal
    overflow, and actual current iOS Safari and Android Chrome before launch.
35. Render Pro's seven-day PITR is the only launch backup mechanism. There is no custom backup job,
    S3 export pipeline, conversation restore, or restore UI.
36. The disaster-recovery rehearsal restores a selected point to a new isolated paid database,
    validates it with an isolated application, measures the data boundary and elapsed recovery, and
    never mutates the source database. It must prove RPO at most 15 minutes and RTO at most four
    hours before production readiness is claimed.
37. Operational documentation is concise and executable by one operator. It covers provision and
    deploy, rollback, incidents, database restore, provider/privacy outage, budget exhaustion,
    email failure, observability failure, employee deactivation, domain/TLS, and every secret's
    rotation. It does not create an internal platform or duplicate provider documentation.
38. The exact production OpenRouter mappings are Fast
    `deepseek/deepseek-v4-flash-0731`, Balanced `deepseek/deepseek-v4-pro`, and Pro
    `moonshotai/kimi-k3`. The bootstrap sets USD 100 monthly, output ceilings
    4,096/8,192/16,384, two employee workflows, 20% reservation margin, and the approved privacy
    attestation. Hourly refresh and the remaining runtime timing values are source-controlled tuning,
    not persisted bootstrap fields.
39. Generation timeout values are 10 seconds to upstream headers, 60 seconds to first visible model
    event, 45 seconds of stream inactivity, five minutes total, and 10 seconds for the bounded
    post-stream usage lookup. Reservations expire after 15 minutes.
40. A tiny production OpenRouter smoke uses one short non-sensitive request on each tier plus one
    cancellation and accounting check. Because it spends money and uses the live credential, the
    implementer must ask the user immediately before running it. CI, load tests, and ordinary
    verification remain fully fake.
41. Identity email never puts a credential in an HTTP request target. Reset and verification links
    carry their token only in the browser fragment. The SPA captures it into component memory,
    removes the fragment immediately, and submits it in a same-origin JSON body. A narrow Fastify
    wrapper invokes Better Auth where its public verification contract otherwise requires a
    token-bearing GET. Tokens never enter browser storage, Render request paths/query strings,
    referrers, application logs, or telemetry.

## Required context

The implementer must read these sources in full before changing behavior:

1. `AGENTS.md`.
2. `docs/prd/README.md` and all six PRDs, especially the locked Phase 8 production baseline.
3. This plan in full, including its phase boundary and manual acceptance runbook.
4. The seven prior implementation plans, using their implementation and verification records as the
   accepted behavior baseline rather than redesigning their features.
5. Current configuration, application construction, lifecycle, health, request-security,
   authentication, identity-email, OpenRouter, generation, reconciliation, database-pool, web
   routing, error-boundary, Playwright, CI, and Docker seams before choosing file placement.
6. The current `.env.example`, root scripts, GitHub Actions workflow, migrations, and production
   image rather than creating parallel operational entry points.

The following external contracts were refreshed on 2026-08-08 and must be rechecked if implementation
occurs materially later:

- [Render Blueprint specification](https://render.com/docs/blueprint-spec),
  [deploy behavior](https://render.com/docs/deploys),
  [health checks](https://render.com/docs/health-checks),
  [web services](https://render.com/docs/web-services), and
  [private networking](https://render.com/docs/private-network).
- [Render PostgreSQL recovery](https://render.com/docs/postgresql-backups),
  [custom domains](https://render.com/docs/custom-domains), and
  [web-service caching](https://render.com/docs/web-service-caching).
- [Render log streams](https://render.com/docs/log-streams) and
  [metrics streams](https://render.com/docs/metrics-streams).
- [Resend API authentication](https://resend.com/docs/api-reference/introduction),
  [send-email request](https://resend.com/docs/api-reference/emails/send-email),
  [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys),
  [verified domains](https://resend.com/docs/dashboard/domains/introduction), and
  [API-key restrictions](https://resend.com/docs/dashboard/api-keys/introduction).
- [New Relic OTLP requirements](https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp/)
  and the [OpenTelemetry JavaScript exporter contract](https://opentelemetry.io/docs/languages/js/exporters/).
- [Playwright browser coverage](https://playwright.dev/docs/browsers) and
  [accessibility testing](https://playwright.dev/docs/accessibility-testing).

At the planning checkpoint, Render supports `checksPass`, a pre-deploy command, a health-check path,
a one-to-300-second graceful shutdown limit, private same-region database URLs, custom domains, and
disabling the generated subdomain. Render Pro retains seven days of PostgreSQL PITR and restores to
a new instance. Resend's direct API requires HTTPS, Bearer authorization, and a `User-Agent`; its
email endpoint accepts text and HTML, and idempotency keys are retained for 24 hours. New Relic's
OTLP endpoint requires TLS and an `api-key` header. Playwright explicitly supports Chromium,
Firefox, WebKit, branded Chrome/Edge, mobile emulation, and axe integration while noting that manual
accessibility testing remains necessary.

## Phase 8 checkpoint

The phase is demoable only when a clean production-shaped build can be provisioned from the
committed manifest, pass migrations and startup validation, serve the branded SPA and API through
the custom HTTPS origin, send real transactional mail, export safe telemetry, survive the approved
load, meet browser/accessibility targets, deploy and drain safely, and complete the isolated restore
rehearsal.

It is not enough for the code to compile, for a local fake-only flow to work, or for a Render service
to answer its health endpoint. The final record must identify the exact deployed commit, Render
sizes, browser/device versions, measured percentiles, OpenRouter smoke result, backup restore point,
RPO/RTO, remaining advisories, and every manual external action still outstanding.

## Dependency direction

Phase 8 extends the existing dependency flow without creating a deployment framework:

```text
browser
  |-- same-origin static assets ----------> Fastify static adapter
  |-- JSON / NDJSON ----------------------> existing routes and services
  `-- closed client-error metadata -------> client-error route

Fastify
  |-- explicit queries -------------------> Render PostgreSQL private URL
  |-- ModelGateway -----------------------> OpenRouter
  |-- IdentityEmailProvider -------------> Resend HTTPS API
  `-- content-free telemetry ------------> New Relic OTLP

Render platform
  |-- application/container logs --------> New Relic log stream
  `-- infrastructure metrics ------------> New Relic metrics stream
```

- `apps/web` remains presentation and browser interaction only.
- `apps/api` owns static delivery, configuration, trusted-proxy adaptation, email delivery,
  observability, shutdown, and every existing business rule.
- `packages/protocol` gains only the client-error transport schema if that endpoint is implemented;
  it does not gain observability or provider types.
- `packages/brand` remains static. Phase 8 may consume its existing fonts, logo, tokens, favicon, and
  icon assets but does not alter source brand geometry.
- Root deployment and operator documents describe the application. They do not become executable
  business-logic packages.

## Single production artifact

### Build and runtime image

Update the existing multi-stage `apps/api/Dockerfile` instead of adding a second Dockerfile:

1. Install with the frozen pnpm lockfile and the repository's pinned Node/package-manager policy.
2. Build `packages/brand`, `packages/protocol`, `apps/web`, and `apps/api` in dependency order using
   existing root/workspace scripts.
3. Copy only production API dependencies, compiled API output, migrations/operator commands, and
   `apps/web/dist` into the runtime stage.
4. Set a stable runtime path for the web assets through typed configuration or build layout; do not
   infer it from the process working directory in feature code.
5. Exclude source maps, test fixtures, development credentials, `.env` files, repository metadata,
   and build caches from the runtime image.
6. Preserve non-root execution and Render's `HOST=0.0.0.0` / injected `PORT` contract.
7. Add a container smoke that confirms the non-root UID, migrations, web assets, API entry point,
   liveness, readiness, SPA fallback, and that no secret-pattern file was copied.

The image remains reproducible locally. Render builds from the repository Dockerfile; Phase 8 does
not introduce a registry-release pipeline or prebuilt-image deployment.

### Static and SPA delivery

Use `@fastify/static` as the one production static dependency because it is smaller and clearer than
a custom file server. Registration order and explicit fallback rules must guarantee:

- `/api/*` and `/api/auth/*` always resolve through Fastify routes or return their API 404 envelope;
- `GET`/`HEAD` for an existing Vite asset returns that asset;
- a non-API browser navigation without a file extension returns `index.html`;
- mutation methods, unknown files, dotfiles, path traversal, and encoded traversal never receive the
  SPA shell;
- assets use correct MIME and `nosniff` behavior;
- fingerprinted Vite assets use `public, max-age=31536000, immutable`;
- `index.html` uses `no-cache` or `no-store`, and non-fingerprinted brand/browser metadata gets a
  short revalidation policy;
- authenticated JSON, Better Auth responses, health responses, and NDJSON are never made
  edge-cacheable;
- every NDJSON response has `Cache-Control: no-store, no-transform` and is verified to flush timed
  chunks through Render without buffering.

Install the existing approved brand favicon and Apple touch icon from `packages/brand`; do not
create new logo geometry. The web build must reference files that are actually copied to `dist`.

### Browser security headers

Retain the current strict same-origin/JSON security boundary. Adjust the production CSP only for
resources the application actually uses. Direct browser telemetry is prohibited, so New Relic does
not enter `connect-src`. Production verification covers CSP, `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'`, referrer policy, permissions policy, `nosniff`, secure
cookies, exact Origin rejection, and HSTS at the final custom domain.

## Render deployment integration

### Committed Blueprint

Add one root `render.yaml` with the smallest declarative topology:

- one Docker `web` service linked to `main`, region Virginia, one instance;
- Dockerfile path `apps/api/Dockerfile` with repository-root build context;
- `healthCheckPath: /api/health/ready`;
- `autoDeployTrigger: checksPass`;
- the existing migration command as `preDeployCommand`;
- `maxShutdownDelaySeconds` selected below the Render maximum and long enough for the application's
  own drain contract;
- `chat.capstone.com.ec` as the custom domain;
- generated Render subdomain initially enabled for provisioning, then explicitly disabled in the
  accepted final configuration;
- one managed PostgreSQL database in the same region with an empty public `ipAllowList` after the
  initial operator bootstrap;
- the database private connection string injected into `DATABASE_URL` through a Blueprint
  `fromDatabase` reference;
- non-secret fixed environment values committed, generated secrets marked for Render generation,
  and externally supplied credentials marked `sync: false`.

The manifest records the exact passing Web Service and PostgreSQL sizes after the load checkpoint.
It does not declare HA, replicas, disks, background workers, cron jobs, key-value stores, preview
environments, or a permanent staging environment.

### Production configuration and secrets

Extend the existing single typed configuration module. Application code still never reads
`process.env` directly. Production requires and validates:

| Variable | Production value or source |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Render injected |
| `PUBLIC_ORIGIN` | `https://chat.capstone.com.ec` |
| `DATABASE_URL` | Render private database URL |
| `BETTER_AUTH_SECRET` | Render-generated, at least existing minimum |
| `MODEL_GATEWAY` | `openrouter` |
| `OPENROUTER_API_KEY` | rotated secret, never the planning key |
| `EMAIL_DELIVERY` | `resend` |
| `RESEND_API_KEY` | send-only key restricted to `mail.capstone.com.ec` |
| `EMAIL_FROM` | `Capstone Chat <no-reply@mail.capstone.com.ec>` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | New Relic regional HTTPS OTLP endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | secret `api-key=<license-key>` header |
| `RENDER_GIT_COMMIT` | Render-provided production release metadata |
| `DEPLOYMENT_REVISION` | explicit local/test release override only |
| `LOG_LEVEL` | `info` initially |

Use the official New Relic regional endpoint selected by the account; do not hard-code a US endpoint
if the account is created in another region. Production derives its release from
`RENDER_GIT_COMMIT`; a local/test override is never accepted as production provenance. Reject
insecure OTLP URLs, missing headers, fake email, fake model gateway, local origins, or unsafe
production defaults. Startup's redacted summary may state modes, release, and origins but never
secret presence length, credential prefixes, or header values.

Application configuration validates that `DATABASE_URL` is a PostgreSQL URL but does not guess
whether a provider hostname is private. The committed Blueprint's `fromDatabase.connectionString`,
empty public `ipAllowList`, and deployed connectivity evidence establish that production uses the
private network.

The ignored development `.env` may continue to hold local keys. `.env.example` documents names and
safe local defaults only. GitHub Actions receives neither production nor paid-provider credentials.

### Trusted client address on Render

Do not flip Fastify to an unrestricted `trustProxy: true`. Add one narrow deployment adapter at the
request boundary:

1. In local/test mode, resolve the peer address exactly as today.
2. In production Render mode, require the one edge header selected above, parse one IPv4 or IPv6
   address, and reject malformed/multiple values for rate-limit identity rather than accepting a
   spoofable forwarding chain.
3. Remove any inbound `x-capstone-client-ip` before setting the internal value used by Better Auth.
4. Never log the complete forwarding chain. The normalized client IP is used only where the current
   authentication rate-limit boundary requires it.
5. Prove with a deployed request test that a caller cannot override the resolved address with
   `X-Forwarded-For` or the private Capstone header.

If Render's edge contract no longer overwrites `CF-Connecting-IP` at implementation time, stop and
select a documented sanitized Render header or proxy trust rule; do not silently weaken rate
limiting.

### First provision and bootstrap

Document the one-time order precisely:

1. Create the Render Pro workspace/environment and paid Virginia PostgreSQL database.
2. Configure the final public origin, verify the Resend sending domain, disable Resend open/click
   tracking, and install the send-only key and exact sender.
3. Restrict the database external allowlist to the operator's current single IP long enough to
   bootstrap.
4. Run every committed migration from the exact release image or workspace checkout.
5. Run `model-policy:bootstrap` with the exact three mappings, USD 100 budget, output limits,
   concurrency two, 20% margin, and current ZDR/privacy attestation.
6. Run the existing idempotent identity bootstrap for the real workspace/admin address; confirm its
   invitation uses the final origin and the verified Resend sender.
7. Verify the resulting policy with metadata-only operator reads; do not print prices, keys, or raw
   provider payloads unless an already approved command deliberately allows safe fields.
8. Remove all PostgreSQL public IP rules and confirm the list is empty.
9. Create/sync the Web Service with its private database reference and secrets, then deploy.
10. Complete the administrator sign-up and token-free verification flow.

This process deliberately avoids temporary application code. Bootstrap evidence records command
status, revision, and content-free policy summary only.

### Deploy, drain, and rollback

The application already marks readiness draining, closes HTTP admission, and aborts residual active
streams. Phase 8 aligns it to the hosting contract:

- readiness becomes false before the process accepts shutdown work;
- ordinary in-flight requests finish within a short bound;
- active streams may drain for up to four minutes, leaving headroom below the five-minute total
  generation ceiling and Render's 300-second maximum shutdown delay;
- after the application drain deadline, remaining streams are aborted, partial chat output is
  retained, hidden compaction stays hidden, and reservations settle or remain reconcilable;
- the database pool closes after terminal writes and reconciler stop;
- OTLP performs one bounded flush last; exporter failure does not keep the process alive indefinitely;
- Render must not send new traffic after readiness changes, and production verification proves the
  actual platform sequence rather than assuming it.

Rollback is limited to the immediately previous compatible image. The runbook records the commit,
checks migration compatibility before rollback, performs readiness and critical smoke afterward,
and never tries to reverse a destructive migration in place. A database recovery is a separate
incident procedure, not an application rollback shortcut.

## Transactional email

### Provider adapter

Extend the current `EmailSender` and factory in place:

- add `resend` to the typed delivery mode;
- extend `IdentityEmail` with both `text` and `html` so fake tests observe the complete logical mail;
- implement a small injectable `ResendEmailSender` using native `fetch`;
- give the request a fixed Capstone `User-Agent`, Bearer authorization, JSON content type,
  `Idempotency-Key`, and one recipient;
- cap request duration and response-body reads; abort at the deadline;
- accept only the documented success status and bounded `{ id: string }` shape;
- map HTTP, timeout, malformed response, and transport errors to a small internal sanitized category;
- log one content-free failure through the existing dispatch boundary without dumping the thrown
  provider body or the `IdentityEmail` object.

Do not retry automatically inside the adapter. The UUID scopes one transport attempt only. A
deliberate invitation resend or repeated public recovery flow is a new logical attempt and receives
a new key; no cross-invocation deduplication is claimed without persisted delivery state.

### Templates and deliverability

Keep the three templates beside the existing identity template functions. Each template:

- uses centralized Spanish product wording and the approved Capstone voice;
- includes one clear action URL and its plain-text equivalent;
- escapes employee-controlled display values before HTML interpolation;
- contains no remote content or executable markup;
- distinguishes invitation, verification, and password reset without revealing account existence in
  the public response;
- is covered by snapshots/assertions that intentionally exclude live tokens from committed output.

Before launch, the operator verifies Resend SPF/DKIM records for `mail.capstone.com.ec`, creates the
send-only domain key, sends each template to a controlled mailbox, checks desktop/mobile rendering,
link origin/expiry, text fallback, spam-folder behavior, and confirms the sender shown is exactly the
approved one. The plan does not require DMARC policy changes for the parent domain unless the domain
owner separately approves them.

### Token-free identity navigation

Do not email Better Auth's generated verification or password-reset URL unchanged because its token
would enter Render's platform request log through a path or query string. The provider-neutral email
boundary receives the token separately and constructs a Capstone public-origin URL whose credential
is stored only in the fragment. On navigation, the identity page captures the fragment into component
memory and removes it before performing network work. Password reset submits the token with the new
password in the existing JSON body. Email verification submits the token to one narrow same-origin
JSON endpoint, which calls the established Better Auth verification operation internally and returns
only the existing safe result/redirect state. Neither endpoint reflects the token.

Tests prove the email action target's path/query are token-free, fragments are removed before any
request, neither flow writes browser storage, API access logs retain only route templates, and
malformed/expired/replayed tokens preserve the existing Spanish recovery behavior. The launch audit
uses synthetic credentials to confirm Render and New Relic request logs cannot contain them.

## Content-free observability

### OpenTelemetry lifecycle

Create one narrowly focused API observability module initialized before Fastify starts and shut down
after the application drain. It owns the OpenTelemetry SDK, resource attributes, trace exporter,
metric exporter/reader, safe attribute helpers, and bounded shutdown. Business modules receive the
few counters/histograms or span helper functions they need; they do not import New Relic types.

Use OTLP HTTP/protobuf exporters for traces and metrics. Configure endpoint and headers through the
frozen API configuration rather than relying on ambient OpenTelemetry environment parsing throughout
the code. Resource attributes contain only stable service name, environment, and deployment
revision. Export batches are bounded in size, concurrency, timeout, and shutdown duration.

Do not add automatic HTTP, Fastify, `pg`, DNS, filesystem, or fetch instrumentation. Manual coverage
is sufficient for a small modular monolith and provides the required privacy control.

### HTTP traces and metrics

Fastify hooks create one span for each meaningful request after routing has resolved. The safe
attribute set is closed:

```text
http.request.method
http.route                  route template, never raw URL
http.response.status_code
capstone.status_family
capstone.request_id
service.version             deployment revision
```

Authenticated identity is not a span/metric attribute. Where incident correlation genuinely needs
an internal ID, keep it in protected structured logs already governed by retention/access rather
than a metric dimension. Query strings, request/response bodies, email addresses, titles, search
terms, message IDs, raw model IDs, and errors' arbitrary messages are prohibited.

Request metrics use route template, method, status family, and outcome only. Successful health probes
record aggregate availability/duration without opening spans. Failed probes create a span and safe
structured error entry.

### Generation and reconciliation instrumentation

Instrument the established lifecycle, not provider chunks:

- count admitted/rejected chat and compaction workflows by tier, purpose, and safe outcome;
- gauge active employee chat streams and active hidden provider calls separately;
- histogram admission-to-`response.started`, provider headers, provider first token, total provider
  duration, total workflow duration, cancellation handling, and final settlement;
- count prompt/completion/reasoning/cached tokens and decimal cost by tier/purpose/outcome without a
  raw model/provider label;
- count context full/compacted/fallback decisions and compaction terminal outcomes;
- count budget rejections, reservation-expiry settlement, reconciliation claims/errors, and measure
  the oldest due reconciliation lag;
- observe PostgreSQL pool total/idle/waiting at a bounded interval owned by the existing application
  lifecycle, not a new scheduler service.

One model-call span contains safe tier, purpose, privacy-policy version, context mode, terminal
outcome, timings, token counts, and final cost when known. It may contain the internal generation ID
for protected trace-to-log correlation, but never conversation/user IDs, prompt versions' text,
model/provider strings, OpenRouter bodies, or content. Lifecycle events are `request.sent`,
`response.started`, `first.token`, `cancel.requested`, and `settled`; no delta content or frequency is
represented.

### Browser failure reporting

Add a protocol schema and API route only if the safe closed payload can remain this small:

```ts
type ClientErrorReport = {
  kind: "render" | "resource" | "unhandled_error" | "unhandled_rejection";
  route: "identity" | "chat" | "admin" | "unknown";
  release: string;
  asset?: string;
  line?: number;
  column?: number;
};
```

`asset` is a validated basename from the application's own fingerprinted static path, not a URL.
Numeric positions are bounded. The route is derived from a route category and strips conversation or
employee identifiers. `release` must match the current server-known deployment revision or be
normalized to `unknown`; a caller cannot create an arbitrary telemetry dimension. The endpoint has
a small body limit, exact same-origin JSON enforcement,
authenticated and unauthenticated-safe rate limiting, no response echo, and ordinary metadata-only
logging. It must not accept an arbitrary `message`, `reason`, `stack`, breadcrumb, DOM snapshot,
network payload, or `location.href`.

The existing React error boundary sends `render` once per release/route/error kind. Global `error`
and `unhandledrejection` listeners map only to the enum and safe asset coordinates. A small in-memory
dedupe prevents storms, `sendBeacon` or `fetch` is best-effort, and failure remains invisible to the
user beyond the existing error UI. No browser storage or device fingerprint is introduced.

### New Relic destination and alerts

Configure the New Relic account as one production destination:

- a Render log-stream endpoint for application/container/platform logs;
- a Render metrics-stream integration for platform CPU, memory, restart, and database metrics;
- a license key used by Fastify OTLP exporters;
- one release tag and service/environment naming convention;
- saved NRQL queries or concise dashboard for the acceptance measures;
- alert notification to the one approved operator channel available at launch.

Use a short alert set: service/readiness down or telemetry absent, unexpected 5xx rate, ordinary API
latency, response-start latency, generation timeout/failure rate, sustained memory pressure,
PostgreSQL pool waiting/exhaustion, reconciliation lag, and failed telemetry export. Budget
exhaustion remains an explicit product policy visible in administration rather than being confused
with infrastructure failure.

Record monthly ingest after the load exercise and set a warning well below the New Relic Free
allowance. Do not solve hypothetical ingest growth with a second backend; reduce safe success
sampling or noisy platform streams from measured volume while retaining errors and required
operational metrics.

## Capacity and performance

### Opt-in load harness

Add a root `pnpm test:load` script that is excluded from ordinary `pnpm test` and CI. The harness
must require an explicit target and confirmation that the target is non-production unless the
operator passes a separate production-smoke flag. Its default mode starts or targets the
production-built container with `FakeModelGateway` and an isolated PostgreSQL database.

The harness runs locally against the production image in test runtime mode and, after separate spend
authorization, against the disposable Render rehearsal environment. Production mode and the final
origin continue to reject `FakeModelGateway`. The fake gateway's test-side configuration supports
per-workflow canary output plus selected delays, cancellations, and sanitized terminal outcomes; it
is not controlled through a production HTTP route.

The harness:

1. Creates 20 non-sensitive fixture employees and authenticated sessions through test support or
   direct setup code outside the production server; it never adds a test-only HTTP route.
2. Creates at least two conversations per employee with deterministic branch/draft/history data.
3. Warms the application and database before measurement.
4. Starts two distinct-conversation chat streams for every employee, for 40 concurrent streams.
5. Interleaves representative session reads, conversation pages, drafts, tier policy, readiness,
   search, and a small amount of administrator reads at ordinary rates.
6. Includes controlled cancellation, slow consumer, compaction-needed, and terminal failure samples
   without making the whole run adversarial.
7. Parses every NDJSON line with `packages/protocol`, checks lifecycle order and terminal outcome,
   and detects content crossing employee boundaries with unique non-sensitive canaries.
8. Captures latency histograms, HTTP outcomes, stream outcomes, active concurrency, pool waiting,
   process CPU/RSS/heap, and database resource behavior.
9. Runs several bounded measured waves followed by an idle period and repeats one wave to expose
   leaks or unreleased resources.
10. Produces a concise machine-readable report with no session cookies, content, emails, keys, raw
    provider identifiers, or database URL.

The Docker run uses CPU and memory constraints matching the candidate Render Web Service. PostgreSQL
uses the same major version and a pool/configuration compatible with the candidate managed plan.
Provider latency is deterministic and varied enough to exercise streaming without dominating app
overhead.

### Passing capacity criteria

At the selected size, the full workload must meet all locked latency objectives and:

- zero malformed or out-of-order known stream events;
- zero unexpected 5xx responses;
- zero unauthorized/cross-employee data exposure;
- zero connection-pool exhaustion or unbounded waiting;
- exactly enforced two-workflow employee and one-workflow conversation invariants;
- correct cancellation, terminal persistence, reservation settlement, and reconciliation;
- no unbounded application buffer for slow readers;
- no event-loop stall large enough to breach the API objectives;
- no sustained memory growth after warm-up.

For a repeatable leak gate, compare post-idle RSS/heap after each measured wave against the warmed
baseline. The final working set may vary with V8, but it must not show a monotonic upward slope and
must return within 15% of the warmed post-idle value. A one-off peak is capacity pressure, not by
itself a leak; investigate with heap/resource evidence before changing architecture.

If the smallest paid size fails, first fix a measured application or pool issue. If the workload is
healthy but resource-bound, select the next paid vertical size and rerun unchanged. Do not add
replicas, Redis, or another database layer to make the test pass.

### Browser performance measurement

Measure production-built assets rather than the Vite development server:

- record Vite asset sizes and route-specific transfer/parse cost;
- lazy-load existing identity, chat, and administration route boundaries where measurement shows a
  material initial-load benefit;
- keep the composer/new-chat critical path in the initial chat route;
- verify that route loading has branded, accessible fallback and error states;
- use Playwright instrumentation to timestamp test-side chunk receipt and the corresponding visible
  assistant update without adding token-level production telemetry;
- measure Stop click to immediate UI state and test server abort observation;
- run at least 20 authenticated cold and 20 warm custom-domain navigations from Ecuador normal
  broadband conditions and report p50/p95 rather than one best sample.

Do not introduce service workers, persistent browser caches, pre-rendering, a second frontend host,
or client-side content persistence. Optimize only evidence-backed code/assets.

### Small live-provider smoke

After fake load, production policy, domain, and telemetry are working, request explicit user
authorization for a small paid smoke. Then:

1. Refresh/validate all exact model metadata and ZDR eligibility.
2. Send one short content-free/non-sensitive prompt through Fast, Balanced, and Pro.
3. Confirm each stream starts, renders, terminalizes, and settles authoritative usage/cost.
4. Cancel one short additional response and confirm upstream abort/retained partial behavior.
5. Confirm raw provider/model names remain absent from employee network responses and UI while
   authorized admin accounting remains correct.
6. Report provider headers/first-token/total timing separately from application overhead.

Do not use the live provider for 40-stream load, CI, compaction fuzzing, or repeated tuning. A live
hidden compaction is optional only if the three-tier smoke does not otherwise exercise the same
provider framing/settlement seam; ask before any additional paid call.

## Browser and accessibility acceptance

### Automated coverage

Keep the existing Playwright matrix and add targeted projects rather than duplicating every test in
every browser. One critical suite runs against:

- Playwright Chromium, Firefox, and WebKit;
- installed branded current Google Chrome and Microsoft Edge;
- iPhone WebKit emulation and a current Android Chrome device profile.

Critical flows are sign-in, invitation/verification where feasible, new chat, stream and Stop,
Markdown/table/code/math presentation, copy, edit, try again, undo/branch selection, search result,
archive, responsive drawer, and administrator access/denial. Chromium may keep the broadest suite;
other engines run the critical subset.

Add `@axe-core/playwright` as a dev-only dependency. Scan stable states after animations/streams
settle, including identity forms/errors, empty chat, populated chat, open sidebar/drawer, active and
terminal response states, response gallery, dialogs, and all three admin pages at desktop/mobile
widths. Use WCAG 2.2 A/AA-compatible axe tags available in the installed version. Do not blanket
exclude components or suppress rules; any unavoidable third-party limitation is individually
documented with impact and a manual check.

### Manual accessibility and device review

Automated scans do not complete the brand's WCAG 2.2 AA target. Record a manual checklist and
evidence for:

- keyboard-only navigation through every critical flow, with visible focus and no trap;
- focus retained in the composer during send/stream and intentionally restored after dialogs/drawer;
- no per-token screen-reader announcement; one meaningful status region for starting, compacting,
  completion, cancellation, failure, and output limit;
- VoiceOver with current Safari for sign-in, new chat, streamed answer, actions, table/code overflow,
  branch navigation, and administration;
- text zoom at 200% and page zoom/reflow at 400% where applicable;
- reduced-motion behavior and no required hover-only action;
- high-contrast/forced-color behavior where the platform exposes it;
- landscape/portrait narrow layouts, safe areas, virtual keyboard, composer growth, tables, code,
  and modal drawer on actual current iOS Safari and Android Chrome.

Playwright WebKit is valuable but is not branded Safari. Final device acceptance therefore requires
either available physical devices or a short reputable device-cloud session. Record OS/browser
versions and any limitations rather than claiming unsupported hardware coverage.

## Backup and disaster recovery

### Production backup posture

Confirm in the Render account—not only in the manifest—that the paid database is on a Pro workspace,
PITR is active, and the recovery window has aged to the full seven days before claiming the complete
retention period. The deletion confirmation copy and privacy/operations documentation state that
deleted active content may remain inaccessible in encrypted backups for up to seven days.

V1 does not download conversation data into an operator-made backup, run `pg_dump` on a schedule,
copy backups to another cloud, or add a retention table. Render PITR is the approved mechanism.

### Isolated restore rehearsal

Use non-sensitive recovery markers and a written clock:

1. Record the source database/service, UTC start time, release, migration version, and current
   readiness without copying employee content into the record.
2. Create a pre-recovery marker, wait for it to fall within a selectable PITR point, create a
   post-recovery marker, and choose a restore time whose expected boundary is unambiguous and no
   more than 15 minutes behind the simulated incident point.
3. Trigger Render PITR to a new paid isolated database. Never restore over the source.
4. Keep the recovered database inaccessible from the public internet. Connect only a temporary
   isolated validation application or operator command using separate configuration.
5. Verify PostgreSQL version, migration ledger, workspace/membership integrity, conversation-tree
   constraints, selected leaves, drafts, search indexes, compactions, generations, reservations,
   budget totals, Better Auth tables, and the expected pre/post marker boundary. Verification logs
   contain counts/statuses, not message content or credentials.
6. Exercise liveness, readiness, sign-in with a dedicated recovery-test identity, one fake-gateway
   read/write flow if isolation permits, and reconciliation without contacting OpenRouter or Resend.
7. Record the latest recovered expected marker as observed RPO and the elapsed time from declared
   incident to a validated replacement as observed RTO.
8. Document the real cutover steps: enable Render maintenance mode, update the private database
   binding, deploy/restart, verify readiness and critical smoke, then disable maintenance.
9. Do not perform that cutover during the rehearsal. The source remains the authoritative production
   candidate.
10. Delete the disposable application/database only after evidence is captured and the user confirms
    the rehearsal is accepted. Note that PITR recovery instances incur cost while alive.

The runbook includes alternative restore-point selection, a failed validation branch, stakeholder
communication, rollback to the untouched source when safe, and the prohibition on deleting the
source until recovery acceptance.

## Security and privacy hardening

Phase 8 performs an evidence-based audit of the deployed boundary without adding a new security
product:

- production configuration fails closed for every fake provider, missing secret, non-HTTPS origin,
  invalid email sender, insecure OTLP endpoint, or malformed deployment value;
- Render database public IP rules are empty after bootstrap and the application uses only the
  private URL;
- credentials exist only in Render/New Relic/Resend secret stores or ignored local files. Render
  can expose service environment variables as ephemeral Docker build arguments, so the Dockerfile
  never declares, reads, prints, or persists secret arguments; credentials do not appear in the
  Blueprint, image layers, logs, traces, CI artifacts, source maps, or browser bundles;
- the compromised planning OpenRouter key is revoked and replaced; every other launch secret has a
  named owner and rotation procedure;
- production cookies, Origin checks, Better Auth CSRF boundary, CSP, HSTS, cache controls, request
  body limits, rate limits, and trusted client IP are verified through the real custom domain;
- unauthenticated and member callers cannot reach admin routes, client-error reporting cannot become
  an arbitrary logging endpoint, and administrator status still cannot read another employee's
  content;
- log, trace, metric, Render integration, and client-error samples are inspected for prompts,
  responses, summaries, searches, titles, drafts, emails, URLs with tokens, cookies, authorization
  headers, raw provider payloads, and credentials;
- OpenRouter requests still require `zdr: true`, `data_collection: "deny"`, the current 30-day
  privacy attestation, exact curated mapping, and the accepted price ceiling;
- response and provider stream headers prevent proxy transformation/buffering while preserving the
  existing bounded backpressure behavior;
- production image and dependency audits run in CI at the existing high/critical threshold, with
  documented triage for any lower-severity advisory.

Do not add a web application firewall rule set, VPN, SSO, MFA, secret vault abstraction, content
scanner, DLP service, or penetration-testing vendor unless a separate decision authorizes it.

## Operational runbooks and release evidence

Add a small `docs/operations/` set with one index and narrowly scoped procedures. Prefer links and
commands over duplicated explanation:

1. `provision-and-deploy.md` — accounts, Blueprint, secrets, first bootstrap, DNS/TLS, Resend DNS,
   New Relic integrations, smoke, and generated-subdomain disablement.
2. `deploy-and-rollback.md` — CI gate, migrations, rollout, drain, compatible rollback, and evidence.
3. `incident-response.md` — triage order, severity, safe logs/queries, maintenance mode,
   communication, and closure.
4. `database-recovery.md` — the exact isolated PITR procedure, validation, cutover, RPO/RTO, and
   source-preservation rules.
5. `providers-and-budget.md` — OpenRouter outage/privacy/catalog/30-day attestation, budget
   exhaustion, Resend failure, New Relic/OTLP failure, and safe degraded behavior.
6. `secret-rotation.md` — Better Auth, database, OpenRouter, Resend, New Relic, and any Render deploy
   credential; order and session/deploy impact are explicit.
7. `employee-access.md` — approve, deactivate, session revoke, last-admin protection, and emergency
   account recovery using existing commands/UI.
8. `domain-and-tls.md` — `chat.capstone.com.ec`, `mail.capstone.com.ec`, DNS verification,
   certificate health, generated subdomain, and rollback.

The index identifies the single initial operator and where provider account recovery information is
kept outside the repository. Runbooks use placeholders for account IDs, emails, keys, endpoints, and
service IDs. No screenshot with content/secrets is committed.

The final implementation record in this plan captures:

- exact commit and date;
- exact Render workspace/service/database plans and region;
- migrations and initial bootstrap result;
- domain/TLS and email-domain verification;
- automated suite, browser matrix, device/VoiceOver/axe results;
- load report and all locked percentiles/error/resource criteria;
- production OpenRouter smoke and measured provider timings;
- New Relic log/metric/trace sample privacy audit and alert tests;
- PITR restore point, expected/observed boundary, RPO, RTO, and cleanup;
- dependency audit, image identity/non-root result, and secret scan;
- any remaining production blocker or explicitly accepted non-blocking advisory.

## Dependency policy

The expected additions are deliberately narrow and pinned through the lockfile.

Production API dependencies:

- `@fastify/static` for production assets and SPA delivery;
- `@opentelemetry/api` for stable instrumentation calls;
- `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`, and
  `@opentelemetry/sdk-metrics` for the narrow Node trace/metric lifecycle;
- `@opentelemetry/exporter-trace-otlp-proto` and
  `@opentelemetry/exporter-metrics-otlp-proto` for direct standard OTLP export;
- `@opentelemetry/resources` or semantic-convention package only if the selected compatible SDK
  version requires a direct import for the three approved resource fields.

Web development dependency:

- `@axe-core/playwright` for automated accessibility checks.

Do not add a Resend SDK, New Relic agent, browser telemetry SDK, automatic-instrumentation bundle,
OpenTelemetry collector, static file server, template engine, React email renderer, load-testing
framework, process manager, deployment CLI runtime dependency, or generalized configuration library.

Before installation, check exact current package compatibility with the repository Node and
OpenTelemetry versions, use one compatible version family, inspect licenses, and run production
audit. If an expected package pulls a high/critical production advisory or materially larger
framework, stop and select the smallest official compatible alternative rather than layering a
workaround.

## Implementation sequence

The phase should be implemented in small, independently verifiable batches in this order.

### 1. Freeze baseline and add contract tests

- Re-run the Phase 7 full gate before changing behavior.
- Record current bundle/image sizes and startup/shutdown behavior.
- Add failing tests for production configuration, static/API routing, caches, stream headers, Resend
  contract, telemetry privacy helpers, client-error schema, and trusted client IP before their
  implementations.
- Do not touch business behavior in this batch.

### 2. Build and serve the single artifact

- Add `@fastify/static`, web/brand build output, SPA fallback, favicon/icons, and cache policies.
- Update the existing Dockerfile and `.dockerignore` only as needed.
- Prove API route precedence, traversal rejection, non-root runtime, static asset existence, and a
  production container smoke.

### 3. Add production proxy and header hardening

- Implement the one trusted client-address adapter and production security/cache headers.
- Preserve local/test socket-IP behavior and existing Better Auth internal-header stripping.
- Prove origin, forwarding-header spoof, secure-cookie, HSTS, and NDJSON no-transform behavior.

### 4. Add Resend transactional delivery

- Extend typed configuration, email value type/templates, provider factory, and native-fetch adapter.
- Replace emailed token-bearing HTTP targets with fragment-based reset/verification landing links
  and same-origin JSON-body consumption before enabling platform log streaming.
- Track non-awaited public sends in the application lifecycle and boundedly drain/abort them during
  shutdown without changing public request timing.
- Add provider contract, timeout, malformed body, idempotency, HTML escaping, fake-provider, and
  production-fail-closed tests.
- Update `.env.example` and local documentation without adding a real key.

### 5. Add safe OpenTelemetry lifecycle

- Install the minimal compatible OTel dependencies.
- Add configuration, resource/export lifecycle, safe attribute helpers, and bounded shutdown.
- Instrument HTTP, database pool, generation, budget, compaction, and reconciliation at lifecycle
  boundaries only.
- Use an in-memory/test exporter to assert exact safe attributes and absence of content or
  high-cardinality labels.

### 6. Add closed browser-error reporting

- Add the TypeBox schema/route, PostgreSQL fixed-window limiter, React listeners, dedupe, and
  existing-boundary logging.
- Verify every rejected content field, IDs stripped from route categories, body/rate bounds, and no
  effect on the existing user-facing error boundary.

### 7. Add Render Blueprint and deployment documentation

- Commit the initial one-service/one-database `render.yaml` with secret placeholders and candidate
  sizes.
- Add provision/deploy/rollback/domain/secret runbooks.
- Validate Blueprint syntax with the current official Render validator or dashboard dry run without
  creating extra services accidentally.

### 8. Add bounded load and browser-performance harnesses

- Implement the opt-in native-fetch workload and machine-readable safe report.
- Add test-side chunk-to-DOM and cancellation timing.
- Resolve the Playwright fixture launcher's bounded shutdown while preserving per-test isolation.
- Run local candidate constraints first. After immediate spend authorization, create the disposable
  Render rehearsal environment, run the same workload and deploy/drain/rollback checks on actual
  candidate service/database sizes, fix only measured issues, record the smallest passing sizes,
  and destroy the rehearsal resources after evidence is accepted.

### 9. Optimize the measured web path

- Apply route-level lazy loading at existing router boundaries if the bundle/profile confirms the
  expected benefit.
- Keep presentation/focus/errors cohesive and rerun unit/browser/accessibility checks.
- Record before/after transfer, parse, and usable-composer measures; remove an optimization if it
  adds complexity without material improvement.

### 10. Complete automated and manual browser/accessibility verification

- Add axe coverage and current branded browser/mobile projects.
- Fix product-controlled findings within Phase 8 scope.
- Complete keyboard, VoiceOver, zoom, reduced-motion, actual iOS, and actual Android checks and
  record versions/results.

### 11. Provision external production services

- With the user's account access, create/configure Render Pro, PostgreSQL, Resend domain/key with
  open/click tracking disabled, New Relic destination/integrations/alerts, and DNS.
- Rotate the exposed OpenRouter key and install every production secret.
- Execute migrations and model bootstrap, then run identity bootstrap only after Resend and the final
  origin are ready; remove public database access afterward.
- This step requires the user's external ownership/credentials but no product decision remains.

### 12. Deploy and run production acceptance

- Deploy only after GitHub checks pass and the pre-deploy migration succeeds.
- Verify custom domain/TLS, static/cache/security headers, real identity email, authentication,
  critical chat/admin flow, streaming/no buffering, drain, telemetry, and rollback.
- Run Ecuador cold/warm performance samples and the approved 20-user/40-stream capacity exercise
  against production-shaped fake infrastructure, not a paid 40-stream OpenRouter load.

### 13. Run the authorized OpenRouter smoke

- Ask immediately before spending.
- Run the three exact tiers and one cancellation, verify privacy route, stream, usage, cost, and
  metrics, then report spend and results.
- Revoke/rotate again if any credential handling evidence is unsafe.

### 14. Rehearse disaster recovery and close operations

- Run the isolated Render PITR rehearsal and measure RPO/RTO.
- Exercise alert notifications and each runbook's critical command path.
- Remove disposable recovery resources only after evidence and approval.
- Update the implementation record and perform the final full review against all PRDs and
  `AGENTS.md` before requesting acceptance.

## Required automated verification

The implementation may organize tests by existing conventions, but it must prove every behavior
below. Test names should describe behavior rather than mirror this document.

### Configuration and startup

- Production rejects absent/invalid public origin, PostgreSQL URL, Better Auth secret, OpenRouter
  mode/key, Resend mode/key/sender, OTLP HTTPS endpoint/header, Render release, or fake provider.
  Blueprint/deployed tests—not URL-shape guessing—prove private database wiring and an empty public
  allowlist.
- Development and test retain safe fake email/model defaults and do not require external telemetry.
- Configuration is frozen, redacted summaries contain no secret fragments, and application modules
  do not read `process.env` outside the approved environment/config boundary.
- OTel exporter construction failure caused by invalid required configuration fails startup;
  transient export failure after startup does not fail readiness.
- Startup and shutdown are idempotent, the reconciler/pool/exporters close in order, and telemetry
  flush is bounded.

### Static application and container

- Fingerprinted JS/CSS/font/image assets return correct bytes, MIME, immutable cache policy, and
  security headers.
- `index.html` is revalidated/uncached and references only emitted assets.
- Non-API navigation returns the SPA shell; unknown API, auth, file-extension, mutation, traversal,
  and encoded traversal requests never do.
- Health, JSON, auth, and NDJSON responses are not cached; NDJSON includes `no-transform`.
- Docker builds all workspaces, contains current migrations/operator commands/assets, excludes test
  and secret files/source maps, runs as non-root, binds Render host/port, and serves API plus SPA.
- The immediately previous web/API compatibility tests still pass after static integration.

### Trusted proxy and security boundary

- Local socket IP behavior is unchanged.
- Production accepts one valid trusted edge IP and handles IPv4/IPv6.
- Missing, repeated, comma-separated, malformed, browser-supplied Capstone, and spoofed
  `X-Forwarded-For` values cannot influence Better Auth rate-limit identity.
- Same-origin mutations, strict CORS, cookies, CSP, HSTS production condition, framing/object/base
  restrictions, request limits, and model HTML sanitization remain intact.
- A deployed custom-domain probe confirms HTTP redirects to HTTPS and final HSTS/TLS behavior.

### Resend

- All three templates contain correct Spanish text and equivalent escaped HTML with only the
  approved origin/action.
- Fake delivery captures text and HTML deterministically; disabled delivery retains its explicit
  behavior.
- Resend sends exact endpoint/method, Bearer header, User-Agent, content type, sender, one recipient,
  subject, text, HTML, and unique valid idempotency key.
- Success requires a bounded valid ID response.
- Timeout, abort, DNS/network failure, 4xx, 5xx, oversized/malformed/empty responses, and repeated
  invocation map to sanitized behavior without credential, recipient, URL, token, or response-body
  logging.
- Production provider selection cannot silently fall back to fake or disabled.
- Public sends retain enumeration-safe non-awaited timing while the lifecycle owns every in-flight
  send and bounded shutdown drains or aborts it.
- Verification/reset email targets contain the credential only in a fragment; the browser removes
  it immediately and the server receives it only inside a bounded JSON body.

### Traces, metrics, and logs

- HTTP spans contain only the closed route-template attributes and never raw URL/query/body.
- Successful health probes omit spans while errors are traced; both retain expected safe metrics.
- Generation/compaction traces contain lifecycle metadata and no chunks, content, summary, raw
  provider response, email, user/conversation identifiers, or raw model/provider label.
- Metric names, units, bucket boundaries, and allowed label sets are asserted centrally.
- Request, response-start, first-token, generation, cancellation, token/cost, active-stream,
  compaction, pool, reservation, and reconciliation values update once at the correct lifecycle
  boundary.
- Cancellation, provider error, final-write failure, late authoritative usage, and reconciliation do
  not double-count terminal metrics or settlement.
- In-memory exporters prove batch/flush behavior without network access in CI.
- Structured log fixtures and telemetry snapshots pass a prohibited-field/content canary scan.

### Client-error reporting

- The shared schema accepts each known kind/category and bounded optional safe coordinate.
- It rejects arbitrary/unknown fields, error messages, stacks, URLs, query strings, IDs, content,
  invalid assets, negative/oversized coordinates, oversized bodies, wrong content type, and
  untrusted Origin.
- React maps each failure source to safe metadata, strips route IDs, deduplicates storms, and ignores
  reporting failure.
- The endpoint cannot reflect supplied data and cannot bypass the PostgreSQL-backed 10-per-address
  and 200-global per-minute limits; counters remain authoritative across two application instances.

### Load harness and concurrency

- Harness configuration refuses an accidental production target by default and redacts reports.
- Fixture setup creates distinct ownership canaries without a production-only route.
- NDJSON validation catches malformed, duplicate terminal, missing started, wrong order, and
  cross-user content.
- 20 employees can each hold two distinct-conversation workflows; a third and same-conversation
  conflict receive the approved stable errors without branch/budget side effects.
- Forty streams plus ordinary traffic finish within bounds with correct active gauges, pool release,
  reservation settlement, cancellation, and compaction behavior.
- The disposable Render rehearsal repeats the capacity and deploy/drain gates on the selected
  managed service/database sizes; production mode still rejects fake inference.
- Slow clients preserve bounded buffering/backpressure.
- Repeated waves/idle detect leaked fetches, timers, sockets, pool clients, active-stream leases,
  reconciler claims, and unbounded heap/RSS.

### Web performance and routing

- Lazy route boundaries preserve direct URL navigation, authorization redirects, loading/error
  states, session-scoped queries, stream continuity, draft state, and keyboard focus.
- Admin code is absent from the initial employee chat chunk if route splitting is retained.
- Test-side chunk receipt through visible Markdown update meets the p95 target under the approved
  scenario and does not add per-token production reporting.
- Stop changes local state synchronously and reaches backend cancellation within the p95 target.
- Existing scroll-follow disengagement, selection, reduced motion, wide tables/code, and streamed
  render batching remain correct after performance changes.

### Accessibility and browsers

- Axe scans cover the agreed stable states at desktop/mobile widths and have zero serious/critical
  violations; every other result is triaged rather than silently excluded.
- Critical flows pass Chromium, Firefox, WebKit, branded Chrome, branded Edge, iPhone emulation, and
  Android emulation.
- Status regions do not announce each token, controls retain accessible names, focus stays or moves
  according to locked flows, dialogs/drawer trap and restore correctly, and hover is not required.
- Zoom/reflow and reduced-motion automated assertions cover the product-controlled boundaries that
  can be asserted reliably.

### Deployment and recovery artifacts

- `render.yaml` parses against the current Blueprint schema and defines exactly one web service and
  one database with approved region/topology, checks-pass, pre-deploy migration, readiness, custom
  domain, shutdown delay, secret references, and final public database lockout.
- It defines no worker, cron, cache, replica, HA, disk, or secret literal.
- Runbook commands reference real repository scripts/paths and use placeholders for external IDs.
- A runbook link/check script catches stale nonexistent commands without executing destructive
  operations.
- The DR evidence validator confirms selected/observed UTC points, RPO, RTO, migration, integrity,
  isolation, source untouched, and recovery-resource cleanup state.

### Regression gate

Before every implementation handoff, run:

```text
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Also run the full Playwright matrix, production container build/smoke, empty-database and exact
Phase 7 migration upgrade, `pnpm audit --prod --audit-level high`, `git diff --check`, dependency and
architecture boundary review, secret-pattern scan, production bundle report, opt-in load run, and
Blueprint validation. Paid/external tests remain explicit manual gates and are never hidden inside
the ordinary test command.

## Manual production acceptance runbook

The implementer records pass/fail evidence for this order. Do not skip ahead after a security,
privacy, migration, or recovery failure.

1. Confirm GitHub Actions passed on the exact candidate commit and the working tree/tag is known.
2. Confirm the compromised OpenRouter key is revoked and every installed secret is newly issued or
   deliberately retained according to the rotation runbook.
3. Confirm Render Pro, Virginia region, one web instance, one managed PostgreSQL database, no HA or
   replica, passing measured sizes, empty database public allowlist, and private connection.
4. Confirm pre-deploy migrations and initial identity/model-policy bootstrap values exactly match
   the PRDs.
5. Confirm `chat.capstone.com.ec` DNS/TLS, HTTPS redirect, security/cache headers, API 404 boundary,
   assets, SPA navigation, and streamed chunk timing through Render.
6. Confirm `mail.capstone.com.ec` SPF/DKIM and all three real Spanish identity emails in controlled
   desktop/mobile mail clients, including text fallback and final-origin links.
7. Confirm member/admin onboarding, verification, reset, fresh-session mutation, deactivation,
   revocation, ownership isolation, and generic enumeration-safe responses.
8. Confirm the entire critical chat flow, three tiers in the picker without raw names, drafts,
   history/search/archive, stream/Stop, Markdown/table/code/math, copy, edit/retry/undo/branches,
   compaction/fallback, budgets, usage, and administration.
9. Complete automated browsers/axe and manual keyboard, VoiceOver, zoom, reduced motion, iOS Safari,
   and Android Chrome checks with versions recorded.
10. Run the locked fake 20-user/40-stream workload and record percentiles, errors, pool, CPU,
    memory, stream correctness, cancellation, and isolation.
11. Run Ecuador custom-domain cold/warm measurements and record usable-composer and API percentiles.
12. Inspect New Relic platform logs/metrics and Fastify traces/metrics, test alert delivery, verify
    required signals, and manually audit samples for prohibited content.
13. Ask the user for live-spend authorization, then run the exact three-tier OpenRouter smoke and
    one cancellation. Record cost and separated provider/application timings.
14. In the disposable isolated Render rehearsal environment, start a long fake-gateway stream,
    deploy a compatible no-op candidate, and prove readiness drain, completion or bounded
    interruption, reservation correctness, and no traffic error.
15. Exercise immediate previous-release rollback and return to the candidate, with migration
    compatibility and smoke on both transitions.
16. Run the isolated seven-day-PITR rehearsal, prove RPO at most 15 minutes and RTO at most four
    hours, keep the source untouched, and remove temporary paid resources after acceptance.
17. Disable the Render generated subdomain, repeat domain/auth/stream smoke, and ensure no callback or
    asset references it.
18. Review every runbook with the launch operator, confirm account recovery and notification access,
    and record any external dashboard-only setting not represented in source.

## Phase boundary

Phase 8 may implement only what is necessary to deploy, operate, observe, measure, secure, and
recover the already accepted v1 chat product.

It must not add:

- documents, retrieval, uploads, skills, agents, tools, web browsing, memory, images, or application
  integrations;
- conversation sharing, teams, custom roles, MFA, SSO, commercialization, billing workflows, or
  multi-workspace administration;
- new chat content types, prompt customization, model controls, provider gateways, provider names in
  employee UI, or cross-tier fallback;
- a hard employee budget, charts, exports, materialized analytics, data warehouse, or business
  intelligence service;
- Redis, another cache, queue, worker, cron service, event bus, microservice, serverless function,
  separate frontend deployment, CDN vendor, or permanent staging environment;
- PostgreSQL HA/read replicas, custom backup service, object-storage exports, restore UI, or
  conversation recovery from backup;
- New Relic proprietary agents, browser session replay, arbitrary frontend stack collection,
  OpenTelemetry auto-instrumentation, a collector, or another observability backend;
- an email SDK, queue, webhook, inbound email, delivery-history feature, attachments, marketing
  templates, or tracking;
- service workers, offline storage, persistent Query caching, a new router/state library, design
  system, generic repository, deployment framework, or speculative portability adapter;
- real-provider load tests, unapproved inference spend, credential commits, or content in operational
  evidence.

If a production platform limitation requires any item above or materially changes privacy,
security, cost, data retention, model policy, or recovery objectives, stop and ask the user. For a
minor implementation ambiguity, choose the smallest extension of the existing pattern and record it
in this plan's implementation record.

## Definition of done

Phase 8 is complete only when all of the following are true:

- The governing PRDs and this accepted plan agree on every production choice and numeric value.
- The single non-root OCI artifact serves the current branded SPA and Fastify API safely from one
  origin and passes local production-container verification.
- The committed Render Blueprint describes exactly the accepted topology, contains no secret, and
  has the measured passing instance sizes.
- Production uses `https://chat.capstone.com.ec`, private managed PostgreSQL, checks-pass deployment,
  pre-deploy migrations, correct readiness/drain, custom TLS, and the final generated-subdomain
  policy.
- Resend sends all required Spanish identity email from the approved verified domain with text/HTML,
  bounded safe failures, and no queue/worker.
- New Relic receives required Render logs/metrics and safe Fastify OTLP traces/metrics; alerts work,
  ingest is understood, and a privacy sample audit finds no employee content or secrets.
- The approved model mappings, USD 100 budget, output limits, concurrency, margin, and privacy
  attestation are explicitly bootstrapped. Source-controlled refresh, timeout, reservation-expiry,
  and drain tuning is independently verified.
- All ordinary automated gates, migrations, Playwright/axe/browser projects, container, audit,
  Blueprint, secret, and boundary checks pass.
- The 20-user/40-stream production-shaped workload meets every locked latency, correctness, pool,
  memory, error, and isolation criterion locally and in the disposable rehearsal environment on the
  recorded Render sizes; no result is attributed to the final production service without evidence.
- Ecuador custom-domain performance, actual current iOS Safari/Android Chrome, keyboard, VoiceOver,
  zoom, and reduced-motion acceptance are recorded and pass.
- The user authorized and the implementer completed the minimal paid OpenRouter smoke without using
  the compromised key or exposing content/secrets.
- Deployment/drain and immediately previous compatible rollback are exercised successfully.
- Render seven-day PITR is active and the isolated rehearsal proves RPO at most 15 minutes and RTO
  at most four hours without altering the source database.
- Runbooks are complete, executable by the initial operator, and every production secret/account has
  ownership, recovery access, and rotation instructions.
- The implementation record states exact evidence and no unresolved P1/P2 defect, hidden external
  action, or unsupported production-readiness claim remains.

The user authorized repository implementation on 2026-08-08. Provider account configuration,
deployment, paid inference, DNS mutation, disposable rehearsal resources, and recovery-resource
creation still require separate access and, where called out above, immediate confirmation before
external spend or mutation.

## Repository implementation record

Repository work completed the approved source-controlled boundary without creating or changing a
Render, Resend, New Relic, DNS, OpenRouter, or recovery resource. The result remains deliberately
short of production acceptance until the separately gated runbook evidence below exists.

### Delivered

- One non-root OCI artifact now serves the Vite application and Fastify API from one origin with
  explicit static/API fallback, cache, security-header, request-timeout, stream-drain, and shutdown
  behavior. `render.yaml` describes the approved one-service/one-database topology; `pro_plus` is
  the locally constrained Web Service candidate and `basic-256mb` remains an unverified database
  candidate for the authorized Render rehearsal.
- Shutdown atomically transfers admitted response requests from the five-second ordinary-request
  drain into their own full four-minute stream grace. A further bounded cleanup fence prevents the
  email client, telemetry, or PostgreSQL pool from closing underneath a live handler or stream; an
  unfenced process fails shutdown explicitly so the platform can hard-stop it.
- Provider-header, first-token, and total provider timings are captured inside the gateway adapter.
  They exclude async-iterator consumer suspension, remain private to server telemetry, and are
  reconstructed out of every employee-facing NDJSON event.
- Production identity mail uses a bounded native-fetch Resend adapter. Verification and reset
  credentials use URL fragments, are removed before browser network work, remain in component
  memory, and are submitted in JSON. Legacy credential-bearing query/path requests fail closed.
- Manual content-free OpenTelemetry traces/metrics, bounded PostgreSQL client-error limits,
  release metadata, recovery markers, migration `0005`, and indexed deployment/incident/
  rotation/recovery runbooks implement the approved observability and operational boundary.
- Route-level administration splitting and deferred Markdown content remove administration and the
  large renderer from the initial graph. Browser performance, accessibility, critical browser/
  device projects, production-container smoke, repository/operations audits, and the opt-in
  native-fetch load harness are committed without a second service or production test route.
- Load tuning kept the modular-monolith and transaction boundaries intact: generation admission
  performs fewer explicit PostgreSQL round trips, reuses only ownership/revision-validated context,
  preserves workspace-before-membership locking, and never holds a transaction across provider
  work. No cache, queue, replica, worker, or new runtime service was introduced.
- Emergency operator deactivation now enters the same workspace-serialized employee-administration
  boundary as the HTTP flow. It preserves final-active-administrator protection, durably cancels
  chat and compaction work, revokes sessions, and makes incomplete cleanup explicit and retryable
  without depending on a process-local stream registry.

### Local verification evidence

- `pnpm check` passed for 291 files; `pnpm verify:repository` passed for 391 files; operations
  validation, strict TypeScript, `git diff --check`, and the high/critical production audit passed.
  The audit still reports the previously documented single moderate development-server advisory.
- `pnpm test` passed 854 deterministic tests: 204 protocol, 433 API/PostgreSQL, and 217 web.
  Production protocol/API/web builds and the Phase 8 migration history passed.
- The production bundle report proves administration is outside the initial module graph. Initial
  assets are 814,538 raw / 314,317 gzip bytes; the deferred graph is 671,468 raw / 225,170 gzip
  bytes, including the 597,266 raw / 181,471 gzip message renderer.
- The core Chromium/Firefox/WebKit Playwright matrix passed 37/37. A separate local extended run
  excluding unavailable Microsoft Edge passed 58 tests with three intentional same-engine identity
  skips across branded Chrome, iPhone 15 WebKit, and Pixel 7 Chrome projects. The Edge project is
  configured for CI but was not locally runnable because Edge is not installed on this Mac.
- The built image runs as the non-root `node` user, contains migration `0005` and the SPA, excludes
  tests/source maps/environment files, and passed readiness, SPA navigation, immutable-asset,
  private-build-metadata, API-404, security-header, and cache-policy smoke checks.
- The guarded built-container load rehearsal passed twice from newly created empty PostgreSQL 18
  databases on the final source candidate at the exact 4 CPU / 8 GB `pro_plus` Web limit. Each run
  exercised 20 employees, 40 simultaneous streams, cancellation, slow readers,
  failure/reconciliation, compaction, ordinary and administrator traffic, ownership canaries,
  pool release, and five measured waves. Across the ten final measured waves, worst ordinary API
  p95/p99 were 26.97/55.36 ms, response-start p95 was 484.85 ms, and cancellation p95 was 78.70 ms.
  Every wave ended with zero active work/reservations and an idle ten-connection pool; post-idle
  heap/RSS stayed within 15% and did not rise monotonically.
- Two preceding post-audit rehearsals breached only the unchanged 500 ms response-start objective,
  at 547.08 and 575.53 ms. The safe diagnostics identified the existing workspace budget-lock
  convoy rather than gateway, shutdown, event-loop, or correctness work. Admission now removes a
  redundant optimistic idempotency read and obtains idempotency, owned-conversation, and draft
  state in one materialized statement while preserving workspace-before-membership-before-
  conversation-before-draft locks, conflict precedence, revision CAS, and the unique-index race
  defense. No threshold or workload timing was relaxed.
- An initial leak-gate failure was investigated rather than waived. Heap snapshots attributed the
  small rise to finite lazy schema/JIT code and feedback structures, while registries, pool,
  timers, sockets, telemetry, and the gateway had no per-wave retained store. Five complete
  unmeasured warm-up waves now precede the unchanged five measured waves. The strict memory bounds
  were not loosened, and three clean repetitions passed after that correction.

### Production acceptance still gated

No production-readiness claim is made from local evidence. The following remain unverified and
require the manual acceptance order above: GitHub Actions on an exact committed candidate; actual
Render Web/database sizing and private networking; DNS, custom-domain TLS, generated-hostname
disablement, and Ecuador latency; live Resend clients and New Relic ingest/alerts/privacy sampling;
fresh OpenRouter credentials, catalog refresh, and the separately authorized paid three-tier smoke;
deploy/drain/rollback; isolated seven-day PITR; and current physical-device, keyboard, VoiceOver,
zoom, and reduced-motion review. The disposable local database and diagnostic heap snapshots were
removed after verification, and no paid inference was run.
