# Capstone Chat

Capstone Chat is an internal AI chat product. The repository implements the Phase 8 production-
hardening checkpoint: one non-root container serves the branded SPA and Fastify API, transactional
identity email has a bounded Resend adapter, content-free telemetry can export to New Relic over
OTLP, and the deployment, recovery, load, browser, accessibility, and operator gates are committed.
Approved employees can use the complete conversation experience, choose Fast, Balanced, or Pro for
each next response, and continue long selected branches through bounded backend-owned compaction.

The approved provisional production candidate is one DigitalOcean App Platform dynamic service in
`ric`, sized `apps-s-1vcpu-1gb-fixed`, with one 512 MiB `PRE_DEPLOY` migration job and paid
Dedicated Egress. PlanetScale Postgres remains the only application-data authority: one PS-5 ARM
Single Node cluster in AWS `us-east-1`, initially 10 GB with a hard 15 GB ceiling. Both exclusive
egress IPv4 addresses are allowlisted separately for the applicable least-privilege database roles,
and every connection uses direct port 5432 with `sslmode=verify-full`.

App Platform and Cloudflare provide managed ingress and TLS. Fastify accepts only the documented
`do-connecting-ip` address claim after stripping every forwarded alternative. New Relic receives
content-free OTLP traces/metrics and a bounded, no-disk application log mirror; App Platform and
PlanetScale retain their native infrastructure/database signals. PlanetScale backups run every 12
hours and are retained for 84 hours, with at least 72 hours of continuous point-in-time recovery.

The approved operational base is approximately USD 44–45/month: USD 10 for the one-GiB App service,
up to USD 25 for Dedicated Egress, USD 5 for the database, and USD 4 for one company-controlled
Bitwarden owner; one Uptime check may add USD 1 if it is not included. At the 15 GB database ceiling
it is approximately USD 44.63–45.63 before taxes, variable backup/network charges, temporary
resources, and model use. OpenRouter spend is separate and remains hard-capped by the application
at USD 100 per workspace month.
The deferred second Bitwarden recovery owner remains a visible launch risk. The topology remains
unaccepted until it passes the closed production-stack checks in the committed runbooks. On August
13, 2026, the owner explicitly replaced the two disposable managed rehearsals with direct staged
production provisioning and accepted DigitalOcean's current feature-preview label for the
selected compute sizes. This explicitly waives the two managed 20-employee/40-stream passes; the
two clean one-CPU/one-GiB container repetitions are the accepted capacity evidence because the
fake load server correctly refuses production mode and the real production hostname. The empty,
closed production service still requires bounded real-path smoke coverage for source identity,
egress, database, TLS, migration, readiness, secret isolation, telemetry, streaming/cancellation,
and Ecuador/browser/accessibility. No employee is invited until those checks plus isolated aged
PITR and controlled cold recreation pass. The initial owner invitation is the final controlled
email gate; no second employee is invited until invitation, verification, and password-reset
delivery are proven and final acceptance is recorded. The owner accepted a best-effort maximum
24-hour domain-binding exception for accidental App deletion; controlled recovery keeps the
four-hour RTO.

Earlier Render, raw-Droplet, RIC1/NYC3 host, Caddy, systemd, UFW, Volume, and Fluent Bit records are
historical evidence only. They are not alternate production instructions.

Development and automated tests still default to the deterministic zero-cost `FakeModelGateway`.
Real inference is an explicit `MODEL_GATEWAY=openrouter` opt-in and requires a dedicated key, a live
validated catalog, and a fresh privacy attestation. No DigitalOcean, PlanetScale, GitHub Package,
Resend, New Relic, DNS, paid OpenRouter, or recovery resource is created by repository setup.
Production acceptance remains a separate operator exercise with evidence from the committed
runbooks; the direct-production decision authorizes the staged production target, not a bypass of
its security-sensitive provisioning order.

## Prerequisites

- Node.js 24.13.x (the repository pins `24.13.0` in `.node-version` and `.nvmrc`)
- Corepack with pnpm 11.20.0
- Docker with Docker Compose

Enable the pinned package manager and install the workspace from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

The committed example contains synthetic local-only values. Never reuse its Better Auth secret in
production.

## Local identity setup

Start PostgreSQL and wait for its health check:

```sh
docker compose up -d --wait postgres
```

Compose publishes PostgreSQL on loopback only. If port 5432 is occupied, set
`CAPSTONE_POSTGRES_PORT` and use the same port in `DATABASE_URL`.

Apply the complete committed migration history explicitly:

```sh
pnpm db:migrate
```

Bootstrap the one workspace and its pending administrator approval. This command creates no
password or default credential:

```sh
pnpm identity:bootstrap --workspace capstone --name "Capstone" --email admin@example.test
```

An exact retry is safe and reports `"repeated": true`. A different workspace or conflicting
bootstrap fails explicitly. Migrations and bootstrap are operator actions; API replicas never run
either one during startup.

Bootstrap the local zero-cost model policy with explicit development limits:

```sh
pnpm model-policy:bootstrap \
  --mode simulated \
  --workspace capstone \
  --monthly-budget-usd 100 \
  --fast-max-output 4096 \
  --balanced-max-output 8192 \
  --pro-max-output 16384 \
  --employee-generation-limit 2 \
  --reservation-margin-bps 2000
```

The simulated policy makes all three employee-facing tiers available but records them as untracked,
zero-cost local generations. An exact retry is idempotent. Changing bootstrap inputs is rejected;
after the administrator account is active, use the web administration area for revision-checked
policy and budget changes. Runtime mode remains an operator choice, so changing an existing
workspace between simulated and OpenRouter mode still requires a separately bootstrapped workspace.

Start Fastify and Vite together:

```sh
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to Fastify at
`http://127.0.0.1:3000`.

After signing in, choose Fast, Balanced, or Pro, enter a draft, and choose **Enviar** (or press Enter
on desktop). The local fake preserves the selected preference and streams this clearly simulated
answer in three deterministic chunks about 400 ms apart:

> Esta es una respuesta simulada de Capstone Chat para desarrollo local.

No OpenRouter key is needed in simulated mode. Send, Continue, Edit, and Try again use the selected
tier; changing the picker while a response is active applies only to the next response.

## Real OpenRouter setup

Real mode maps Fast, Balanced, and Pro to the three approved exact model IDs in backend policy; raw
provider and model names never enter employee responses. Before real bootstrap, verify in the
dedicated OpenRouter workspace that data-discount logging, observability input/output logging, and
observability broadcast are all disabled. Record that operator verification in a local JSON file:

```json
{
  "attestationVersion": "openrouter-privacy-v1",
  "broadcastEnabled": false,
  "dataDiscountLoggingEnabled": false,
  "inputOutputLoggingEnabled": false,
  "verifiedAt": "2026-08-08T16:00:00.000Z"
}
```

Use the actual current canonical UTC timestamp. Keep the attestation file and key outside Git, set
`MODEL_GATEWAY=openrouter` and `OPENROUTER_API_KEY` in the local environment, then run:

```sh
pnpm model-policy:bootstrap \
  --mode openrouter \
  --workspace capstone \
  --monthly-budget-usd 100 \
  --fast-max-output 4096 \
  --balanced-max-output 8192 \
  --pro-max-output 16384 \
  --employee-generation-limit 2 \
  --reservation-margin-bps 2000 \
  --privacy-attestation - \
  < /absolute/path/to/openrouter-privacy.json
```

An attestation is valid for 30 days. Before it expires, verify the same three dedicated-workspace
settings again, update only `verifiedAt` in the local document, and renew it without changing model
or cost policy:

```sh
pnpm model-policy:attest \
  --workspace capstone \
  --privacy-attestation - \
  < /absolute/path/to/openrouter-privacy.json
```

An identical retry is idempotent. Privacy documents are accepted only through bounded standard
input; the command rejects file paths. It accepts only a newer, still-fresh verification for an
existing real OpenRouter policy; it rejects older timestamps, simulated policy, and unbootstrapped
workspaces. Expiry makes every real tier unavailable and blocks inference until renewal succeeds.
The command reads no model metadata and makes no network request.

Bootstrap and `pnpm model-catalog:refresh` read only the approved OpenRouter metadata and do not
request a model generation. API replicas refresh due approved rows with a short PostgreSQL lease;
network failure preserves the last valid catalog, while a successful response confirming no safe
route makes that tier unavailable. Merely configuring a key incurs no inference spend. Spend begins
only when an employee sends a response while the application is running in OpenRouter mode.

Each real response reserves the configured fixed-request ceiling plus conservative input and maximum
output cost inside the same transaction that creates its turn. The current workspace month is based
on its IANA timezone. Final OpenRouter usage and billed USD replace the reservation when available;
ambiguous interrupted requests remain fully reserved until a narrow reconciler settles the
conservative estimate after expiry. Conversation deletion removes content but retains generation
accounting required for later workspace reporting.

The development fake sender is process-local. The bootstrap and approval commands therefore report
the safe `signUpPath` in their JSON result; open [http://localhost:5173/sign-up](http://localhost:5173/sign-up)
to continue locally. Invitation URLs contain no email, approval identifier, or credential.

After registration, read the verification delivery from
[http://localhost:5173/api/dev/mailbox](http://localhost:5173/api/dev/mailbox), open its URL, and
then sign in at [http://localhost:5173/sign-in](http://localhost:5173/sign-in). Protected access is
unavailable until verification activates the approved workspace membership.

The mailbox is JSON, retains only the latest 100 messages, and exposes verification and
password-reset messages created by the running API process. It is registered only with
`NODE_ENV=development` and `EMAIL_DELIVERY=fake`, accepts only loopback requests, returns
`Cache-Control: no-store`, and is cleared whenever that API process restarts.

## Employee operator commands

Approve another employee after bootstrap:

```sh
pnpm identity:approve --workspace capstone --email employee@example.test --role member
```

`--role` accepts only `admin` or `member`. Repeating the exact approval is idempotent. A pending
approval's role may be corrected before activation; an active or deactivated lifecycle conflict
fails without silently changing access. The employee uses the ordinary `/sign-up` flow and chooses
their own 12–128 character password.

Deactivate an employee, durably cancel active chat/compaction work, and revoke database sessions:

```sh
pnpm identity:deactivate --workspace capstone --email employee@example.test
```

Deactivation blocks authorization before cleanup, protects the final active administrator, and is
safe to retry. If cleanup is reported incomplete, repeat the exact command after correcting the
database/connectivity failure; access remains blocked between attempts. The same operations are
available to administrators in the browser.

## Administration

Administrators can open `/admin`; it redirects to the employee area. The browser uses the session
role only for presentation. Fastify independently requires the administrator role for every read
and a session authenticated within the last 15 minutes for every mutation.

- `/admin/employees` pages through pending, active, and deactivated approvals. It can approve and
  invite an employee, resend an invitation, revoke sessions, set or clear a non-blocking monthly
  personal spend warning, and deactivate access. An administrator cannot deactivate themselves or
  the workspace's last active administrator.
- `/admin/models` shows the workspace-curated catalog and the complete revisioned tier policy. An
  administrator can validate an exact OpenRouter model, refresh approved metadata, select each
  tier's mapping and output limit, choose the default tier, enable or disable employee-facing tiers,
  and change the hard monthly workspace budget atomically.
- `/admin/usage` reports the current workspace-local month. It separates actual, estimated, and
  still-reserved cost and groups content-free token/cost metadata by employee, tier, and purpose
  (`chat` or `compaction`). It never exposes conversations, prompts, responses, or summaries.

The development fake sender delivers administrator invitations to `/api/dev/mailbox`. Production
uses the bounded native-fetch Resend adapter and the verified `mail.capstone.com.ec` sender; it does
not add an email SDK, queue, webhook, tracking, or retained delivery body. If a mutation reports
that the session must be refreshed, sign out and sign in again; the application does not collect
credentials inside the administration area.

## Identity and recovery flow

- `/sign-up` accepts only a pending operator-approved email but always presents a generic outcome.
- `/verify-email` activates exactly the approved workspace role after address verification.
- `/sign-in` creates a revocable PostgreSQL-backed session for a verified active member.
- `/forgot-password` sends a generic recovery outcome; its fake delivery appears in the local
  mailbox.
- `/reset-password` consumes the delivered reset link and revokes all existing sessions.
- `/account/security` changes the password, preserves the current session, and revokes the others.
- `/` is the protected new-chat draft inside the responsive application shell.
- `/c/:conversationId` opens the selected immutable branch of an owned conversation.
- `/search` searches owned active and archived titles and message text without putting the query in
  the browser URL.
- `/archived` pages through archived conversations.
- `/admin/employees`, `/admin/models`, and `/admin/usage` are available only to administrators.

Verification and reset tokens are removed from the visible browser URL and are never intended for
logs or browser storage.

## Conversation core

PostgreSQL is authoritative for conversation trees, selected branches, revisions, archive state,
search indexes, and drafts. Conversation and draft reads are always scoped to both the active
workspace and employee; an administrator has no exception for reading another employee's content.

- Recent and archived history use opaque keyset cursors with 20 conversations per page.
- Conversation detail returns the selected branch in pages of 40 whole plain-text messages.
- Search returns 20 results per page, is case- and accent-insensitive, and prefix-matches only the
  final term. It covers preserved alternative branches and clearly labels archived results.
- New-chat and conversation drafts autosave 600 ms after typing pauses. Drafts allow 32,768 UTF-8
  bytes and use independent compare-and-swap revisions so concurrent tabs cannot silently
  overwrite one another.
- Manual titles allow 120 Unicode code points. First Send derives an initial title by collapsing
  whitespace and limiting the result to 72 Unicode code points.
- Rename, branch selection, archive, unarchive, and permanent deletion use the observed structural
  revision. A stale change is rejected instead of overwriting newer state.
- Permanent deletion removes the conversation, its messages, and its conversation-scoped draft
  immediately. The confirmation explains that inaccessible encrypted backups may retain content
  until their finite retention period expires.

Draft conflicts present two explicit choices: adopt the newest server draft, or deliberately
replace it using the newest observed revision. A failed or conflicted save never moves draft text to
localStorage or IndexedDB. Reloading or closing a tab can therefore lose text that never reached
Fastify. The only persisted browser preference is the desktop sidebar's collapsed state.

## Conversation experience checkpoint

Sending first confirms the server draft, then atomically creates one user message, an assistant
placeholder, and one active generation. Fastify constructs prior context from the selected owned
branch; the browser cannot supply history. The response is newline-delimited JSON and is rendered
incrementally through the same safe Markdown path as persisted messages.

- One conversation can have only one active response; separate conversations may stream at the
  same time, including while navigating between them.
- The composer stays editable during a response so the next draft can autosave, but it cannot be
  sent until the current response reaches a terminal state.
- **Detener** records durable cancellation before the browser reconciles canonical conversation
  state. The serving API replica preserves text already streamed to the employee; cancellation on
  another replica preserves the latest durable checkpoint.
- A response ending because of the output limit exposes **Continuar**. Its backend-owned visible
  message does not consume a separately typed draft.
- Interrupted streams are never resumed or automatically retried. The browser reloads canonical
  messages and lifecycle state; explicit employee action is required to generate again.
- User messages are limited to 32,768 UTF-8 bytes. Assistant accumulation and selected-branch
  context are each bounded at 1 MiB.

Immutable conversation controls preserve every prior branch:

- **Editar** is available on owned user messages. Saving creates a user sibling and immediately
  starts a new assistant child without changing the original message, title, or ordinary draft.
- **Volver a intentar** creates only a new assistant sibling from the backend-stored user message.
- **Deshacer último turno** moves the selected endpoint back one complete turn without deleting
  descendants.
- Previous/next alternative controls persistently select a complete branch. Metadata is fetched in
  bounded revision-scoped chunks; sibling content is loaded only after selection.
- Edit, retry, Undo, and branch selection are blocked while a response is active. Composer typing
  and draft autosave continue throughout streaming.

User and assistant text share one local renderer for CommonMark, GitHub-flavored tables and task
lists, fenced code, and inline/block mathematics. Raw HTML and Markdown images never mount; links
allow only `http`, `https`, and `mailto`, and syntax highlighting uses only the committed grammar
set. Copy answer/user writes the original normalized Markdown source, while code copy writes the
exact fenced payload without its markers. No renderer asset or grammar is fetched at runtime.

Streaming follows only while the employee remains near the bottom. Scrolling upward or selecting
text disengages following and exposes **Ir a lo más reciente** when more streamed content arrives.
Completion, cancellation, and failure never force a final scroll. Opening a message search result
selects its preserved branch, loads ancestors until the exact match is present, positions once, and
marks it briefly without placing the query or message content in the URL.

Long selected branches are planned entirely by Fastify. At 80% of the smaller safe chat/Fast input
budget, the server reuses an applicable persisted summary or makes one synchronous hidden Fast call.
Normal compaction keeps the newest eight complete turns verbatim, never changes or deletes original
messages, and records the hidden call under purpose `compaction`. Its summary and deltas never enter
the browser, search, logs, or administrator responses. Stop and disconnect cancel both the hidden
work and the waiting chat.

If compaction is unavailable, rejected by the hard budget, or ends without a reusable summary, the
chat proceeds once with the newest bounded turns and displays a context warning. The fallback keeps
eight complete turns when possible and never drops below six; if even that minimum cannot fit, the
request fails before consuming the draft or creating messages. There is no automatic inference
retry. In simulated mode both the compaction and chat calls are deterministic and zero-cost; in
OpenRouter mode both are separately reserved and settled.

The committed migration history includes the conversation/search tables, durable generation
lifecycle, model-policy/accounting state, compaction and administration state, and Phase 8's
content-free client-error limits and recovery markers.
Apply the complete history with `pnpm db:migrate` after updating a checkout; API replicas never
migrate during startup. If conversation, model-tier, response, or administration routes fail after
an update, confirm the migrations ran against the selected `DATABASE_URL` before investigating
application code.

## Health and troubleshooting

| Endpoint | Purpose | Healthy response |
| --- | --- | --- |
| `GET /api/health/live` | Process liveness; never queries PostgreSQL | `200 {"status":"live"}` |
| `GET /api/health/ready` | Traffic readiness; probes PostgreSQL | `200` when ready, `503` otherwise |
| `GET /api/session` | Canonical protected employee/workspace session | `200` for an active member |

Common local checks:

- A readiness failure usually means PostgreSQL is unavailable or migrations were not applied. Run
  `docker compose up -d --wait postgres` and `pnpm db:migrate`.
- An ordinary database error on a feature route after an update usually means the committed
  migration history is incomplete; apply the complete migration history and retry.
- A startup failure with `configurationKey` set to `BETTER_AUTH_SECRET`, `EMAIL_DELIVERY`,
  `DATABASE_URL`, or `PUBLIC_ORIGIN` means the selected runtime mode rejected that field. Operator
  failure metadata intentionally omits the rejected value and arbitrary error messages.
- A missing local mailbox requires both development mode and fake delivery. A `403` means the
  request did not arrive from a loopback address.
- Fake deliveries belong to one API process. Reload the mailbox after the request that sends the
  message; restarting the API clears it. Operator-command invitations do not persist into the
  separately running API mailbox, so use the command's `signUpPath` locally.
- Registration, verification resend, password recovery, and invalid sign-in intentionally use
  generic browser outcomes. Check that the approval is pending and that the employee entered the
  same normalized email rather than expecting account-existence details from the UI.
- A `429` response means a PostgreSQL-backed identity rate limit is active; wait for that route's
  window before retrying.

To exercise the Phase 1 availability boundary, stop PostgreSQL with
`docker compose stop postgres`. Liveness remains healthy while readiness and the web indicator
report that the service is unavailable. Restart it with `docker compose start postgres`.

## Repository commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build the shared protocol, then run the API and web development servers |
| `pnpm check` | Run Biome formatting, linting, and import checks |
| `pnpm typecheck` | Run strict TypeScript checks in each executable TypeScript workspace |
| `pnpm test` | Run protocol, API unit/PostgreSQL integration, and deterministic web tests |
| `pnpm test:e2e` | Run Playwright's configured desktop, critical-flow, accessibility, and CI browser/device matrix |
| `pnpm test:load` | Run the separately authorized, isolated load harness; this is not part of ordinary CI |
| `pnpm build` | Build the protocol, production API JavaScript, and static web assets |
| `pnpm report:bundle` | Report production assets and prove the admin route is absent from the initial module graph |
| `pnpm verify:repository` | Scan nonignored repository text, dependencies, and architecture boundaries |
| `pnpm verify:operations` | Validate the App Platform/PlanetScale contract, runbook links/commands, and recovery-evidence validator |
| `pnpm verify:recovery -- <safe-evidence.json>` | Validate accepted, content-free PITR evidence and recompute RPO/RTO limits |
| `pnpm smoke:container -- <image> <full-revision>` | Start and probe a built image against a migrated loopback test database |
| `pnpm run ci` | Run repository checks, operations validation, types, tests, builds, and the bundle report |
| `pnpm db:migrate` | Apply every committed Drizzle migration to `DATABASE_URL` |
| `pnpm identity:bootstrap …` | Create the initial workspace and pending administrator approval |
| `pnpm identity:approve …` | Create an idempotent pending employee approval |
| `pnpm identity:deactivate …` | Block an employee and revoke their sessions |
| `pnpm identity:invite-initial` | Send the existing initial administrator approval only after every pre-invitation production gate passes; reads bounded input from standard input |
| `pnpm model-policy:bootstrap …` | Create the explicit simulated or real workspace model/cost policy |
| `pnpm model-policy:attest …` | Renew the content-free OpenRouter privacy attestation for an existing real policy |
| `pnpm model-catalog:refresh` | Revalidate approved real OpenRouter models and print a metadata-only summary |
| `pnpm production:initialize` | Run the latched empty-database initialization contract; reserved for the temporary authorized App Platform job |
| `pnpm --filter @capstone/api auth:schema:generate` | Regenerate the reviewed Better Auth Drizzle schema with the pinned CLI |

Use `pnpm run ci`, not `pnpm ci`: `ci` is also a built-in pnpm install alias and does not invoke the
repository script.

The API integration suite starts isolated PostgreSQL 18.4 containers and never uses the developer
database. Docker must be running for `pnpm test`. Install the supported Playwright browsers once
before running the browser suite locally:

```sh
pnpm --filter @capstone/web exec playwright install chromium firefox webkit
pnpm test:e2e
```

The Playwright command starts its own migrated PostgreSQL container, seeds synthetic conversation
trees before the API listens, and starts the fake-email API harness, deterministic fake model, and
Vite server. It does not use the local development database, expose a test-only application route,
or contact a real email or model provider. The broad suite remains Chromium-first; critical stream,
scroll, Markdown-overflow, copy, and branch interactions also run in Firefox and WebKit with isolated
mutable fixture conversations.

The opt-in capacity harness is intentionally outside `pnpm test` and CI. Local built-container runs
are regression and diagnostic evidence only; they do not reproduce App Platform's managed edge,
rolling lifecycle, Dedicated Egress, Insights/Uptime, public database path, or PS-5 limits. Generate
a test-only secret, migrate an empty disposable PostgreSQL 18 database, and build the exact
candidate image:

```sh
export CAPSTONE_LOAD_DATABASE_URL='<isolated PostgreSQL URL>'
export CAPSTONE_LOAD_AUTH_SECRET='<generated test-only value of at least 32 characters>'
DATABASE_URL="$CAPSTONE_LOAD_DATABASE_URL" pnpm db:migrate
docker build --file apps/api/Dockerfile --tag capstone-chat:phase8-load .
```

Run the unchanged five measured waves. Before their warmed heap/RSS baseline, the harness runs ten
complete unmeasured workload waves so lazy schema compilation and V8 tiering are finite warm-up
rather than false leak evidence. The wrapper constrains and verifies the image as the non-root
`node` user, starts its compiled load entry point with explicit garbage collection, waits for
readiness, runs the harness, and always removes the container:

```sh
pnpm test:load:container -- capstone-chat:phase8-load
```

The direct driver also accepts `--employees <4-100>` for an explicitly isolated capacity search.
It defaults to 20 employees, always keeps the approved two distinct-conversation workflows per
employee, and does not relax the five-wave latency, correctness, settlement, pool, or memory gates.
This option is diagnostic only; the accepted production workload remains 20 employees and 40
streams.

The compiled server injects the deterministic load gateway through a test-only process entry point;
it never contacts OpenRouter. The wrapper accepts only a loopback disposable database URL. The
harness additionally refuses the production origin, credentials in the target URL, missing
confirmations, a nonempty or mismatched fixture database, or an invalid NDJSON lifecycle. Its report
contains only safe identifiers, counts, resource measurements, and latency percentiles. Delete the
disposable database after the wrapper stops. A source/`tsx` load server can still aid debugging, but
it is not managed capacity evidence. Historical Render and raw-Droplet constraints/results remain
recorded in superseded implementation plans only. On August 13, 2026, the owner explicitly waived
a managed repetition of this synthetic load test and accepted the two clean one-CPU/one-GiB
container runs as capacity evidence. The load server remains prohibited on the production origin
and in production mode. The closed production service instead receives bounded real-path
streaming, deployment, rollback, secret, edge, and recovery smokes without test-only endpoints or
a fake gateway.

GitHub Actions runs formatting/linting, repository and operations validation, type checking, clean
migrations, unit/PostgreSQL integration tests, production builds, the bundle report, dependency
audit, and a non-root container startup/static/API smoke as named steps in one quality job.
Playwright remains separate. CI uses only synthetic identities, a test auth secret, fake providers,
and job-local PostgreSQL. It builds but does not publish the production Dockerfile.

The protected manual deployment workflow accepts only the current green `main` commit. It advances
`app-platform-production` by non-force fast-forward, asks App Platform to build that source with
autodeploy disabled, and accepts the release only when the service, migration job, and public
readiness report the authorized commit. First provisioning, initialization, configuration,
teardown, paid smoke, and recovery remain separately authorized.

## Auth schema regeneration

Better Auth, its Drizzle adapter, and the schema CLI are all pinned to `1.6.26`. Regenerate the core
Drizzle definitions without connecting to a database:

```sh
pnpm --filter @capstone/api auth:schema:generate
```

The command uses `apps/api/src/auth/schema-generation.ts`, overwrites
`apps/api/src/database/auth-schema.generated.ts`, and formats it with Biome. Review that diff before
running `pnpm --filter @capstone/api db:generate` to create a new committed migration. Neither
schema generation nor migration generation/application runs during API startup.

## Configuration

The API validates environment variables once during startup and passes an immutable configuration
object through the process.

| Variable | Local example | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Fastify listen address; production requires `0.0.0.0` inside App Platform |
| `PORT` | `3000` | Fastify listen port |
| `DATABASE_URL` | `postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat` | PostgreSQL connection URL |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | Exact browser origin, with no path; HTTPS is required in production |
| `BETTER_AUTH_SECRET` | `capstone-chat-local-auth-secret-not-for-production-use` | Better Auth signing secret, at least 32 characters; explicit and secret in production |
| `EMAIL_DELIVERY` | `fake` | `fake` or `disabled` outside production; production requires `resend` |
| `RESEND_API_KEY` | unset | Backend-only Resend key required with `EMAIL_DELIVERY=resend` |
| `EMAIL_FROM` | unset | Approved sender; production requires `Capstone Chat <no-reply@mail.capstone.com.ec>` |
| `LOG_LEVEL` | `info` | Pino log level |
| `MODEL_GATEWAY` | `fake` | `fake` or `openrouter`; production requires `openrouter` |
| `OPENROUTER_API_KEY` | unset | Backend-only key required when `MODEL_GATEWAY=openrouter` |
| `WEB_ASSETS` | unset | Exact `production-build` mode for the deployed production image or managed test rehearsal; ordinary development/test leaves assets to Vite |
| `DEPLOYMENT_REVISION` | `development` | Safe local label; production requires the full 40-character deployed Git revision |
| `DEPLOYMENT_TARGET` | unset | Production requires exactly `digitalocean-app-platform` |
| `CAPSTONE_SECRET_SOURCE` | unset | Production requires exactly `platform-environment` |
| `CLIENT_ADDRESS_SOURCE` | `socket` | `socket` for local/test; production requires exactly `digitalocean-app-platform` |
| `CAPSTONE_SECRET_FILE` | unset | Prohibited for the normal production service/job; retained only for authenticated offline recovery tooling that explicitly requires it |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | New Relic regional HTTPS OTLP origin; required in production |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Exactly one backend-only `api-key=…` header; required in production |

The bounded New Relic log mirror uses the same validated license key and its fixed HTTPS Log API
destination. It does not add a second secret, telemetry provider, worker, sidecar, or disk spool.

`CAPSTONE_WEB_PORT` selects Vite's local port, and `CAPSTONE_POSTGRES_PORT` selects the Compose host
port. They default to 5173 and 5432 and are not exposed in the browser bundle. If the web port
changes, update `PUBLIC_ORIGIN` to the same browser origin and port so authentication's exact-origin
check remains aligned.

Fastify keeps unrestricted proxy trust disabled. Development and test use the socket address. In
production the App Platform mode captures exactly one valid `do-connecting-ip` value before
deleting it and every `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, and legacy private address header.
Missing client-address metadata is accepted only on health checks because provider probes may omit
it; product and authentication routes reject missing, multiple, or malformed claims. Startup,
request, email, model, telemetry, and recovery output excludes database URLs, bodies, cookies,
credentials, tokens, provider payloads, and employee content.

## Identity security policy

- Sessions expire after seven days, slide at most once per day, and count as fresh for 15 minutes.
  Cookie session caching is disabled so database revocation is authoritative on the next request.
- Authentication bodies are limited to 16 KiB. The Fastify-wide limit remains 64 KiB.
- The ordinary auth limit is 100 requests per 60 seconds. Sign-in is limited to five per 60
  seconds; verification to ten per 60 seconds; verification resend and password recovery to three
  per 15 minutes; and reset to five per 15 minutes. Counters live in PostgreSQL and are shared by
  API replicas. The database retention horizon covers the longest rule while the effective
  catch-all remains the 60-second ordinary rule, so cleanup cannot shorten recovery limits.
- Auth cookies are `HttpOnly` and `SameSite=Lax`, and are also `Secure` in production. The exact
  `PUBLIC_ORIGIN` is the only trusted browser origin.
- The API emits a self-only Content Security Policy with `base-uri 'self'`,
  `frame-ancestors 'none'`, and `object-src 'none'`, plus `Permissions-Policy`,
  `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

The production container applies the same policy to API and static responses and adds one-year HSTS
only in the locked HTTPS production mode. Fingerprinted assets are immutable; the SPA shell and API
responses are not stored as immutable content.

## Production artifact and acceptance boundary

Build both applications and the source-deployable API image from the repository root:

```sh
pnpm build
docker build --file apps/api/Dockerfile \
  --tag capstone-chat-api .
```

The API image runs as the non-root `node` user and includes the compiled runtime, migrations, and
`apps/web/dist`. Fastify serves the SPA and API from the same origin with explicit API-404, fallback,
cache, security-header, and streaming boundaries. The committed
[`deploy/app-platform`](./deploy/app-platform/) contains four source contracts and one read-only
live-state validator. App Platform builds the protected release-pointer commit with
`apps/api/Dockerfile` for one non-root service and one non-root `PRE_DEPLOY` migration job.
`DEPLOYMENT_REVISION=${_self.COMMIT_HASH}` is injected at runtime; component source hashes and
public readiness must agree. PlanetScale remains the only authoritative application data store.

Production secrets originate in Bitwarden and enter only encrypted, component-scoped App Platform
variables. The service receives the application database role and runtime-provider credentials; the
steady migration job receives only its distinct migration `DATABASE_URL`; the recovery role is
never installed. API startup never applies migrations. Protected deployment may select only the
current checked `main` release. Compatible rollback is a reviewed `git revert`, green CI, and
normal forward source deployment through the **current** App configuration; DigitalOcean's native
rollback action is not production authority.

Empty-database provisioning first runs a secret-free health-only service to acquire the two stable
Dedicated Egress addresses. After PlanetScale restrictions are installed, a temporary job performs
ordered migration, database-only identity bootstrap, catalog validation, and model-policy bootstrap
behind a durable initialization-document hash latch. Operators then remove its configuration,
revoke every temporary role/key, deploy the steady service, and send
the one initial administrator invitation only after every pre-invitation production gate passes. Cold recreation against an
initialized or restored database must verify the existing latch and authority; it must never reuse
the initialization document/job/key or resend that invitation.

`EMAIL_DELIVERY=disabled` is an honest non-production validation mode, not a launch-capable setup.
Production rejects disabled/fake email, the fake model gateway, a noncanonical origin, absent release
metadata, or incomplete New Relic OTLP configuration. OpenRouter mode requires its key and a
previously bootstrapped real policy with a fresh privacy attestation. Identity action credentials
are delivered in URL fragments, removed immediately when the SPA starts, kept only in memory, and
sent to Better Auth in JSON rather than entering request paths, queries, storage, or referrers.

Bootstrap and approval commit their database change before attempting invitation delivery. With
delivery disabled, the command reports `"outcome":"approval-committed"` and
`"retrySafe":true`, exits nonzero, and sends no invitation; the persisted operation remains safe to
retry after a provider is configured.

Repository implementation does not authorize or perform deployment. Follow the indexed
[operations runbooks](./docs/operations/README.md) for provisioning, domain/TLS, deploy/rollback,
provider/budget setup, employee access, incidents, secret rotation, and isolated PITR recovery.
Those runbooks require content-free evidence and fresh approval before external mutation, paid
inference, disposable DigitalOcean/PlanetScale resources, or recovery-resource creation. Repository
implementation and CI do not authorize a DigitalOcean configuration update, historical GHCR
deletion, DNS change, credential installation, invitation, or provider recovery action.

## Workspace boundaries

- `apps/web` owns presentation and browser interaction.
- `apps/api` owns identity policy, authorization, configuration, persistence, and process lifecycle.
- `packages/protocol` contains only shared transport schemas and inferred public types.
- `packages/brand` is the vendored CAPSTONE Brand System v2.0.0 asset and token package.

The API and web application both depend on the protocol package; only the web application depends on
the brand package. No application imports another application's internals.
