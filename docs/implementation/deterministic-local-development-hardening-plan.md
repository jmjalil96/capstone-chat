# Deterministic local development hardening

Status: implemented and locally verified on 2026-08-21; capacity latency acceptance remains pending

## Approved boundary

This engineering amendment makes the ordinary local fake-model loop deterministic without moving
database ownership into either application server. It preserves the PostgreSQL-only Compose
topology, direct Fastify and Vite processes, normal authentication and sign-up, explicit hosted
migration jobs, and every Phase 11 compatibility boundary.

- `pnpm dev` owns pre-server local preparation: start the shared loopback PostgreSQL service,
  derive a persistent logical database from the absolute worktree path and `fake` profile,
  atomically lease available API and web ports, verify and apply migrations, idempotently bootstrap
  the `capstone` workspace and simulated model policy, then start Fastify and Vite.
- `pnpm dev:openrouter` uses a different worktree-specific database, requires a development-only
  OpenRouter key, and requires an absolute privacy-attestation file before first policy bootstrap.
- Managed fake development forces fake model and email delivery and clears provider credentials,
  telemetry export, hosted secret inputs, and recovery inputs even when `.env` conflicts.
- `pnpm dev:reset -- --profile fake|openrouter --confirm-local-data-loss` is the only automatic
  helper allowed to drop data. It accepts only its generated database name on the verified local
  Compose server and never runs as recovery from drift without the developer's explicit command.
  The command rejects `DOCKER_HOST` and remote contexts, pins the repository Compose file and
  project, and verifies the image, service, health, loopback publisher, server identity, and
  generated database name before deletion.

## Migration verification

Before DDL, every environment compares the migration ledger with the release journal as an exact
ordered prefix using journal timestamps and SHA-256 hashes of the SQL files. Rewritten, reordered,
unknown, missing-ledger, or ahead-of-release histories fail before migration execution. After DDL,
the complete ledger and an explicit release-owned critical-schema contract must pass.

Development, CI, staging, production, and recovery use this same verifier. Recovery retains only
its separately approved reconstruction of PlanetScale-restored manual objects before the shared
final verification. Application startup never runs migrations. Both valid Phase 11 behavior
contract versions remain accepted, schema-1 initialization remains intentional, and no migration
`0010` or protocol change is introduced.

## Verification boundary

Tests cover deterministic naming and profile isolation, managed environment precedence, provider
prerequisites, guarded reset, explicit and automatic ports, concurrent cross-process allocation,
migration-prefix divergence, critical-object loss, Phase 11 version compatibility, and recovery
reconstruction. Manual acceptance proves concurrent worktree isolation, fallback from an occupied
default port, provider-free fake generation, profile separation, and exact drift remediation.

This amendment changes no hosted topology, environment overlay, deployment command, provider
resource, production data, or automatic deployment behavior.
