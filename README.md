# Capstone Chat

Capstone Chat is an internal AI chat product. This repository currently implements the Phase 1
foundation: a pnpm workspace, Fastify API, Vite and React status page, shared TypeBox contracts,
PostgreSQL migrations, automated verification, and a production API image.

Identity, conversations, chat, model access, budgets, and administration intentionally remain out
of scope until their roadmap milestones are approved.

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

The values in `.env.example` are safe local-development examples. Production configuration must be
provided explicitly.

## Local development

Start PostgreSQL and wait for its health check:

```sh
docker compose up -d --wait postgres
```

If port 5432 is already occupied, set `CAPSTONE_POSTGRES_PORT` and use the same port in
`DATABASE_URL` before starting Compose.

Apply the complete migration history explicitly:

```sh
pnpm db:migrate
```

Start Fastify and Vite together:

```sh
pnpm dev
```

The web application is available at [http://localhost:5173](http://localhost:5173). Vite proxies
`/api` to Fastify at `http://127.0.0.1:3000`.

| Endpoint | Purpose | Healthy response |
| --- | --- | --- |
| `GET /api/health/live` | Process liveness; never queries PostgreSQL | `200 {"status":"live"}` |
| `GET /api/health/ready` | Traffic readiness; probes PostgreSQL | `200` when ready, `503` otherwise |

To verify the failure boundary manually, stop PostgreSQL with
`docker compose stop postgres`. Liveness remains healthy while readiness and the web page report
that the service is unavailable. Restart it with `docker compose start postgres`; readiness recovers
on the next probe.

## Repository commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build the shared protocol, then run the API and web development servers |
| `pnpm check` | Run Biome formatting, linting, and import checks |
| `pnpm typecheck` | Run strict TypeScript checks in each executable TypeScript workspace |
| `pnpm test` | Run protocol, API, PostgreSQL integration, and deterministic web tests |
| `pnpm test:e2e` | Run the separate Playwright foundation smoke test |
| `pnpm build` | Build the protocol, production API JavaScript, and static web assets |
| `pnpm run ci` | Run the local non-browser CI gates in order |
| `pnpm db:migrate` | Apply every committed Drizzle migration to `DATABASE_URL` |

The API integration suite starts an isolated PostgreSQL 18.4 container and never uses the developer
database. Docker must be running for `pnpm test`. Install the Playwright browser once before running
the browser smoke test locally:

```sh
pnpm --filter @capstone/web exec playwright install chromium
pnpm test:e2e
```

## Configuration

The API reads and validates environment variables once during startup, then passes an immutable
configuration object through the process.

| Variable | Local example | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Fastify listen address |
| `PORT` | `3000` | Fastify listen port |
| `DATABASE_URL` | `postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat` | PostgreSQL connection URL |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | Public browser origin |
| `LOG_LEVEL` | `info` | Pino log level |

Startup logs contain only non-secret metadata. Database URLs and other secret-bearing values are not
logged.

`CAPSTONE_WEB_PORT` selects Vite's local port, and `CAPSTONE_POSTGRES_PORT` selects the Compose host
port. They default to 5173 and 5432 respectively and are not exposed in the browser bundle.

## Production builds

Build both applications locally with:

```sh
pnpm build
```

The Vite output is static content in `apps/web/dist`; Phase 1 deliberately does not select a hosting
provider.

Build the production-focused API image from the repository root:

```sh
docker build --file apps/api/Dockerfile --tag capstone-chat-api .
```

Run it against an explicit test database (on macOS, `host.docker.internal` reaches the host):

```sh
docker run --rm --publish 3000:3000 \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --env DATABASE_URL=postgresql://capstone:capstone@host.docker.internal:5432/capstone_chat \
  --env PUBLIC_ORIGIN=https://localhost:5173 \
  --env LOG_LEVEL=info \
  capstone-chat-api
```

Migrations remain an explicit deployment step and never run automatically when an API replica
starts.

## Workspace boundaries

- `apps/web` owns presentation and browser interaction.
- `apps/api` owns configuration, health policy, database access, and process lifecycle.
- `packages/protocol` contains only shared transport schemas and inferred public types.
- `packages/brand` is the vendored CAPSTONE Brand System v2.0.0 asset and token package.

The API and web application both depend on the protocol package; only the web application depends on
the brand package. No application imports another application's internals.
