# Capstone Chat

Capstone Chat is Capstone's internal AI workspace. The current Phase 11 application provides
approved employee identity, private branching conversations, durable streaming and reconnection,
Fast/Balanced/Pro model policy, workspace behavior controls, administration, usage controls, and
content-free operational telemetry.

The product is a TypeScript modular monolith:

- `apps/web` is the React browser application.
- `apps/api` is the Fastify application and owns policy, authorization, providers, and PostgreSQL.
- `packages/protocol` contains shared transport schemas and public types.
- `packages/brand` contains the vendored CAPSTONE Brand System v2.0.0 assets and tokens.

The governing behavior and security decisions live in [`docs/prd`](./docs/prd/README.md). Active
hosted procedures live in [`docs/operations`](./docs/operations/README.md). Dated implementation
plans are historical records, not alternate operating instructions.

## Local development

Requirements:

- Node.js 24.13.x (`.node-version` and `.nvmrc` pin `24.13.0`)
- Corepack and pnpm 11.20.0
- Docker with Docker Compose

Install dependencies and start PostgreSQL:

```sh
corepack enable
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
```

Development has safe local defaults, so `.env` is optional. [`.env.example`](./.env.example) lists
the supported overrides. Never reuse its synthetic auth secret or any development credential in a
hosted environment.

Apply migrations and initialize the local workspace explicitly:

```sh
pnpm db:migrate
pnpm identity:bootstrap \
  --workspace capstone \
  --name "Capstone" \
  --email admin@example.test
pnpm model-policy:bootstrap \
  --mode simulated \
  --workspace capstone \
  --monthly-budget-usd 100 \
  --fast-max-output 4096 \
  --balanced-max-output 8192 \
  --pro-max-output 16384 \
  --employee-generation-limit 2 \
  --reservation-margin-bps 2000
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to Fastify at
`http://127.0.0.1:3000`. Development uses a deterministic zero-cost model and a process-local fake
mailbox at [http://localhost:5173/api/dev/mailbox](http://localhost:5173/api/dev/mailbox). The
bootstrap result includes a safe `signUpPath`; the mailbox contains subsequent verification and
password-reset deliveries and is cleared when the API restarts.

Migrations, workspace initialization, model policy, and employee approval are operator actions.
The API never performs them during startup. Exact bootstrap retries are safe; conflicting inputs
fail explicitly.

### Optional OpenRouter development

Real inference is an explicit development opt-in. Use a dedicated key, set
`MODEL_GATEWAY=openrouter` and `OPENROUTER_API_KEY`, and first verify that OpenRouter data-discount
logging, input/output observability logging, and broadcast are disabled. Record a fresh UTC
attestation outside Git:

```json
{
  "attestationVersion": "openrouter-privacy-v1",
  "broadcastEnabled": false,
  "dataDiscountLoggingEnabled": false,
  "inputOutputLoggingEnabled": false,
  "verifiedAt": "2026-08-20T16:00:00.000Z"
}
```

Bootstrap with `--mode openrouter --privacy-attestation -` and pipe that document through standard
input. Attestations expire after 30 days and renew through `pnpm model-policy:attest`. See the
[provider and budget runbook](./docs/operations/providers-and-budget.md) for the complete provider,
privacy, and spend boundary. Configuring a key or refreshing model metadata does not request a
generation.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build the protocol and run the API and web development servers |
| `pnpm run ci` | Run checks, audits, types, tests, builds, and the bundle report |
| `pnpm check` | Run Biome formatting, linting, and import checks |
| `pnpm typecheck` | Run strict TypeScript checks, including unused-code rejection |
| `pnpm test` | Run protocol, API, PostgreSQL integration, and web tests |
| `pnpm test:e2e` | Run the Playwright desktop, accessibility, and browser/device matrix |
| `pnpm build` | Build protocol, API JavaScript, and static web assets |
| `pnpm report:bundle` | Report production assets and route-splitting evidence |
| `pnpm verify:repository` | Check credentials, dependencies, and architecture boundaries |
| `pnpm verify:operations` | Test hosted contracts, runbook references, and recovery validators |
| `pnpm verify:recovery -- <evidence.json>` | Validate content-free PITR/recreation evidence |
| `pnpm smoke:container -- <image> <full-sha>` | Probe a built image against disposable PostgreSQL |
| `pnpm test:load -- <image>` | Run deterministic one-CPU/512-MiB built-container capacity evidence |
| `pnpm db:migrate` | Apply the committed migration history to `DATABASE_URL` |

Use `pnpm run ci`, not `pnpm ci`: the latter is pnpm's clean-install alias. Docker must be running
for API integration and Playwright tests. Install Playwright's supported browsers once with:

```sh
pnpm --filter @capstone/web exec playwright install chromium firefox webkit
```

## Local operators

| Command | Purpose |
| --- | --- |
| `pnpm identity:approve …` | Approve a pending `admin` or `member` |
| `pnpm identity:deactivate …` | Block an employee and revoke sessions |
| `pnpm model-policy:bootstrap …` | Create simulated or OpenRouter workspace policy |
| `pnpm model-policy:attest …` | Renew an existing OpenRouter privacy attestation |
| `pnpm model-catalog:refresh` | Refresh approved model metadata without inference |
| `pnpm environment:initialize` | Run the schema-1 latched empty-database initializer |
| `pnpm identity:invite-initial` | Send the initial hosted owner invitation after acceptance |

Administrator product actions are available under `/admin`. The browser role controls presentation
only; Fastify independently authorizes every operation and requires a fresh session for mutations.
Employee lifecycle procedure and retry semantics are in the
[employee access runbook](./docs/operations/employee-access.md).

## Built-container verification

The production image runs as the non-root `node` user and contains the compiled API, migrations,
and web assets. Build it from the repository root:

```sh
pnpm build
docker build --file apps/api/Dockerfile --tag capstone-chat-api:local .
```

For the smoke test, point `DATABASE_URL` at a migrated disposable loopback PostgreSQL database:

```sh
DATABASE_URL='<disposable loopback PostgreSQL URL>' \
  pnpm smoke:container -- capstone-chat-api:local "$(git rev-parse HEAD)"
```

The smoke runs the compiled minimal health bootstrap, migration command, identity/model bootstrap,
unmodified image command, readiness/revision checks, and representative static/API security probes.

The capacity harness is opt-in and never hosted. It uses the deterministic load gateway, validates
the disposable database, constrains the built image to one CPU and 512 MiB, runs ten warm-up waves
and five measured waves, and always removes its container:

```sh
export CAPSTONE_LOAD_DATABASE_URL='<disposable loopback PostgreSQL URL>'
export CAPSTONE_LOAD_AUTH_SECRET='<generated test-only value of at least 32 characters>'
DATABASE_URL="$CAPSTONE_LOAD_DATABASE_URL" pnpm db:migrate
pnpm test:load -- capstone-chat-api:local
```

The default accepted workload is 20 employees and 40 concurrent streams. Run it twice from clean
containers for staging-sized capacity evidence. This validates application behavior and bounded
resources, not App Platform's managed edge, lifecycle, public database path, or provider services.

## Hosted release path

Hosted releases use one path:

```text
exact green main commit
  -> protected source pointer
  -> App Platform source build
  -> migration-only PRE_DEPLOY
  -> normal server
  -> exact contract and readiness revision
```

- Staging: [https://staging.chat.capstone.com.ec](https://staging.chat.capstone.com.ec), persistent,
  synthetic-only, one 512 MiB service and migration job, isolated PS-5 database and provider keys,
  no Dedicated Egress.
- Production: [https://chat.capstone.com.ec](https://chat.capstone.com.ec), authoritative employee
  data, existing one-GiB service and migration job, PS-5 database, Dedicated Egress, and provider
  credentials.

Every accepted `main` commit deploys to staging after quality and Playwright succeed. Production is
a manual protected promotion of an exact staging-accepted commit that is reachable from `main` and
strictly ahead of the current production pointer. Both environments source-build the same commit
and Dockerfile independently; the repository does not claim byte-identical artifacts.

The sole desired App Platform contract and validator live in
[`deploy/app-platform`](./deploy/app-platform/README.md). Routine release, provisioning,
forward-revert rollback, recovery, domains, secrets, providers, and incidents are indexed in the
[operations runbooks](./docs/operations/README.md).

Phase 11 preserves ordinary expand/contract deployment: additive migration `0009` upgrades any
valid Phase 10 database, initialization remains schema 1, predecessor writes remain version 1
compatible, and Phase 11 writes version 2. No migration `0010` exists or is pending; removing the
intentional compatibility boundary would require a separately approved contract release. There is
no startup migration, quiesce stage, database copy/replacement, schema-2 initializer, or custom
cutover path.

The minimal `health-bootstrap` entrypoint is for first provisioning or controlled recovery only.
It exposes health endpoints without product or database authority and is not part of routine
release mechanics. Recovery rehearsals are isolated PITR/cold-recreation exercises, not staging
deployments.

## Configuration boundary

Development defaults to loopback PostgreSQL, `CAPSTONE_ENVIRONMENT=development`, fake email/model,
socket-derived client addresses, and a synthetic revision. Common local overrides are:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Local or disposable PostgreSQL URL |
| `PUBLIC_ORIGIN` | Exact local browser origin |
| `BETTER_AUTH_SECRET` | Local signing secret of at least 32 characters |
| `EMAIL_DELIVERY` | `fake` or `disabled` locally |
| `MODEL_GATEWAY` | `fake`, or explicit development-only `openrouter` |
| `OPENROUTER_API_KEY` | Dedicated development key for the OpenRouter opt-in |
| `CAPSTONE_WEB_PORT` | Vite port, default `5173` |
| `CAPSTONE_POSTGRES_PORT` | Compose PostgreSQL host port, default `5432` |

Hosted configuration is fail-closed. Both staging and production require `NODE_ENV=production`,
their exact environment/origin/sender, TLS database URLs, secure cookies, HSTS, normal server and
migration commands, encrypted component-scoped secrets, telemetry, and exact source revision.
Staging additionally rejects every email recipient outside its normalized 1–10 address allowlist
before any Resend request. Production additionally requires its fixed edge and Dedicated Egress
contract. The validator, tests, and [deployment runbook](./docs/operations/deploy-and-rollback.md)
are the complete hosted configuration authority; `.env.example` is development-only.

Fastify never logs prompts, responses, summaries, drafts, credentials, database URLs, cookies,
tokens, recipients, or raw provider payloads. PostgreSQL is authoritative for identity, sessions,
conversation trees, drafts, generation state, policy, budgets, audit metadata, and recovery
markers. Browser storage contains no conversation content.

## Repository boundaries

- The web application never imports API internals or owns business rules.
- The API remains a modular monolith; there are no services, queues, caches, or workers.
- Protocol schemas contain transport contracts, not backend policy.
- Only the web application depends on the brand package.
- API startup never applies migrations or performs initialization.
- Hosted load routes, fake hosted providers, native rollback, and database replacement do not exist.

For product details, privacy/security invariants, cost ceilings, and milestone authority, start with
the [PRD index](./docs/prd/README.md).
