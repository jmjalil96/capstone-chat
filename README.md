# Capstone Chat

Capstone Chat is an internal AI chat product. The repository currently implements the Phase 3
conversation core: an approved employee can create and verify an account, sign in with a
database-backed session, keep server-side drafts, browse and search owned conversation history,
and rename, archive, unarchive, or permanently delete a conversation. Operators manage the first
workspace, employee approvals, and deactivation through explicit commands.

Phase 3 intentionally has no Send action and cannot generate an answer. Model access, streaming,
conversation controls such as edit and retry, budgets, web administration, and production
deployment remain outside this milestone.

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

If port 5432 is occupied, set `CAPSTONE_POSTGRES_PORT` and use the same port in `DATABASE_URL`.

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

Start Fastify and Vite together:

```sh
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to Fastify at
`http://127.0.0.1:3000`.

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

`--role` accepts only `admin` or `member`. Repeating the exact approval is idempotent; a conflicting
role or lifecycle state fails without silently changing access. The employee uses the ordinary
`/sign-up` flow and chooses their own 12–128 character password.

Deactivate an employee and revoke their database sessions:

```sh
pnpm identity:deactivate --workspace capstone --email employee@example.test
```

Deactivation blocks authorization before session cleanup and is safe to retry. Phase 3 has no web
administration surface.

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
- Manual titles allow 120 Unicode code points. The initial-title helper reserved for first-send in
  Phase 4 collapses whitespace and limits its result to 72 Unicode code points.
- Rename, branch selection, archive, unarchive, and permanent deletion use the observed structural
  revision. A stale change is rejected instead of overwriting newer state.
- Permanent deletion removes the conversation, its messages, and its conversation-scoped draft
  immediately. The confirmation explains that inaccessible encrypted backups may retain content
  until their finite retention period expires.

Draft conflicts present two explicit choices: adopt the newest server draft, or deliberately
replace it using the newest observed revision. A failed or conflicted save never moves draft text to
localStorage or IndexedDB. Reloading or closing a tab can therefore lose text that never reached
Fastify. The only persisted browser preference is the desktop sidebar's collapsed state.

The conversation tables and PostgreSQL `unaccent` search extension are added by the committed Phase
3 migration. Apply migrations explicitly with `pnpm db:migrate`; API replicas never migrate during
startup. If conversation routes fail after upgrading a checkout, confirm the complete migration
history ran against the selected `DATABASE_URL`.

## Health and troubleshooting

| Endpoint | Purpose | Healthy response |
| --- | --- | --- |
| `GET /api/health/live` | Process liveness; never queries PostgreSQL | `200 {"status":"live"}` |
| `GET /api/health/ready` | Traffic readiness; probes PostgreSQL | `200` when ready, `503` otherwise |
| `GET /api/session` | Canonical protected employee/workspace session | `200` for an active member |

Common local checks:

- A readiness failure usually means PostgreSQL is unavailable or migrations were not applied. Run
  `docker compose up -d --wait postgres` and `pnpm db:migrate`.
- A startup error naming `BETTER_AUTH_SECRET`, `EMAIL_DELIVERY`, `DATABASE_URL`, or `PUBLIC_ORIGIN`
  means the selected runtime mode rejected its configuration.
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
| `pnpm test:e2e` | Run the separate Playwright identity and conversation browser suite |
| `pnpm build` | Build the protocol, production API JavaScript, and static web assets |
| `pnpm run ci` | Run `check`, `typecheck`, `test`, and `build` in order |
| `pnpm db:migrate` | Apply every committed Drizzle migration to `DATABASE_URL` |
| `pnpm identity:bootstrap …` | Create the initial workspace and pending administrator approval |
| `pnpm identity:approve …` | Create an idempotent pending employee approval |
| `pnpm identity:deactivate …` | Block an employee and revoke their sessions |
| `pnpm --filter @capstone/api auth:schema:generate` | Regenerate the reviewed Better Auth Drizzle schema with the pinned CLI |

Use `pnpm run ci`, not `pnpm ci`: `ci` is also a built-in pnpm install alias and does not invoke the
repository script.

The API integration suite starts isolated PostgreSQL 18.4 containers and never uses the developer
database. Docker must be running for `pnpm test`. Install Chromium once before running the browser
suite locally:

```sh
pnpm --filter @capstone/web exec playwright install chromium
pnpm test:e2e
```

The Playwright command starts its own migrated PostgreSQL container, seeds synthetic conversation
trees before the API listens, and starts the fake-email API harness and Vite server. It does not use
the local development database, expose a test-only application route, or use a real email provider.

GitHub Actions exposes formatting/linting, type checking, clean migrations, unit and PostgreSQL
integration tests, production builds, the non-root API image, and Playwright as separate gates. CI
uses only synthetic identities, a test-only auth secret, and fake delivery.

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
| `HOST` | `127.0.0.1` | Fastify listen address; defaults to `0.0.0.0` in production |
| `PORT` | `3000` | Fastify listen port |
| `DATABASE_URL` | `postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat` | PostgreSQL connection URL |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | Exact browser origin, with no path; HTTPS is required in production |
| `BETTER_AUTH_SECRET` | `capstone-chat-local-auth-secret-not-for-production-use` | Better Auth signing secret, at least 32 characters; explicit and secret in production |
| `EMAIL_DELIVERY` | `fake` | `fake` for development/test or `disabled`; fake is prohibited in production |
| `LOG_LEVEL` | `info` | Pino log level |

`CAPSTONE_WEB_PORT` selects Vite's local port, and `CAPSTONE_POSTGRES_PORT` selects the Compose host
port. They default to 5173 and 5432 and are not exposed in the browser bundle. If the web port
changes, update `PUBLIC_ORIGIN` to the same browser origin and port so authentication's exact-origin
check remains aligned.

Phase 2 fixes `trustProxy` to `false` in development, test, and production because no edge proxy has
been selected. Raw browser forwarding headers are not trusted. Startup logs and request-completion
logs contain only safe metadata; database URLs, request bodies, cookies, passwords, tokens, and
email bodies are excluded.

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

A future static host and edge must apply an equivalent policy to static web responses, preserve the
exact-origin boundary, and add HSTS only on verified production HTTPS. That edge configuration,
proxy trust, and HSTS verification belong to Phase 8.

## Production image and limitation

Build both applications and the API image from the repository root:

```sh
pnpm build
docker build --file apps/api/Dockerfile --tag capstone-chat-api .
```

The Vite output is static content in `apps/web/dist`; no production static host has been selected.
The API image runs as the non-root `node` user and includes the compiled runtime and committed
migrations.

Provide `DATABASE_URL`, an HTTPS `PUBLIC_ORIGIN`, and a unique `BETTER_AUTH_SECRET` of at least 32
characters through deployment secret/configuration management. Apply migrations as a separate
deployment action before starting any API replica:

```sh
docker run --rm \
  --env NODE_ENV=production \
  --env EMAIL_DELIVERY=disabled \
  --env DATABASE_URL \
  --env PUBLIC_ORIGIN \
  --env BETTER_AUTH_SECRET \
  capstone-chat-api \
  node apps/api/dist/database/migrate-command.js
```

Then start the API with the same explicit configuration:

```sh
docker run --rm --publish 3000:3000 \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --env EMAIL_DELIVERY=disabled \
  --env DATABASE_URL \
  --env PUBLIC_ORIGIN \
  --env BETTER_AUTH_SECRET \
  --env LOG_LEVEL=info \
  capstone-chat-api
```

`EMAIL_DELIVERY=disabled` is an honest Phase 2 validation mode, not a launch-capable email setup:
verification and password-recovery sends fail safely. `EMAIL_DELIVERY=fake` is rejected during
production startup. A real transactional provider, secret wiring, deployment venue, static host,
and edge configuration remain deliberately unselected until production hardening.

Bootstrap and approval commit their database change before attempting invitation delivery. With
delivery disabled, the command reports `"outcome":"approval-committed"` and
`"retrySafe":true`, exits nonzero, and sends no invitation; the persisted operation remains safe to
retry after a provider is configured.

## Workspace boundaries

- `apps/web` owns presentation and browser interaction.
- `apps/api` owns identity policy, authorization, configuration, persistence, and process lifecycle.
- `packages/protocol` contains only shared transport schemas and inferred public types.
- `packages/brand` is the vendored CAPSTONE Brand System v2.0.0 asset and token package.

The API and web application both depend on the protocol package; only the web application depends on
the brand package. No application imports another application's internals.
