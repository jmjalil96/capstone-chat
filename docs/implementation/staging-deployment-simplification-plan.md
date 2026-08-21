# Staging and deployment simplification

Status: implemented and accepted in persistent staging. Production promotion remains a separate,
protected manual operation.

Date: August 20, 2026.

This amendment replaces hosted fake-model rehearsal and routine validation on production with one
persistent staging-first release path. Historical deployment plans remain historical evidence;
their production topology, privacy, recovery, and cost decisions survive only where the active PRDs
explicitly retain them.

## Locked boundary

- `CAPSTONE_ENVIRONMENT` distinguishes development, staging, and production. Hosted environments
  both run `NODE_ENV=production` and the normal server.
- Staging is fixed to `https://staging.chat.capstone.com.ec`, one 512 MiB service, one 512 MiB
  migration job, a separate PS-5 database with synthetic data, dedicated low-limit provider
  resources, a staging-domain sender with 1–10-recipient allowlisting, and no Dedicated Egress.
- Production retains its current origin, sizes, Dedicated Egress, edge settings, provider
  credentials, and authoritative database.
- One common App Platform contract plus fixed overlays defines source builds, migration-only
  `PRE_DEPLOY`, normal server, health, termination, component secret scopes, domain/edge, and exact
  source identity. Provider builds from the same commit are not claimed byte-identical.
- Staging automatically deploys an exact green `main` push after quality and Playwright. Production
  manually selects a fixed staging-accepted commit behind protected approval. Both pointers move
  without force; initial pointer creation is separate provisioning.
- The focused validator checks desired and active specs, both component SHAs, topology, commands,
  encrypted variables, domains/edge, production egress, and absence of extra/in-progress
  components.
- The deterministic load gateway, fixture catalog, diagnostics, and harness are local/container-only.
  A minimal provider-native health bootstrap is reserved for first provisioning or controlled
  recovery and is never a routine product stage.

## Preserved Phase 11 and recovery authority

Migration `0009` remains additive over every valid `0008` database. Initialization stays schema 1;
predecessor writes remain behavior-contract version 1 compatible; Phase 11 writes version 2; and
`0010` remains deferred until production acceptance. Deployment has no quiesce, startup migration,
database copy/replacement, cutover workflow, or temporary initialization credentials. Isolated PITR
and controlled cold recreation remain separate recovery exercises with independently validated
evidence.

## External boundary

No repository change creates a pointer, GitHub environment, App, database, role, key, domain,
provider request, deployment, or production mutation. Separate provider resources and roles enforce
opaque-secret separation; repository tests can validate only explicit environment/origin/sender/key
placement, not cryptographically identify a reused opaque secret.

## Production follow-up — August 21, 2026

Production later accepted the cleanup-aware source revision
`9df207f1ddd762e66c0e6528f66c3bd2ca1faf0a` under the strict hosted contract. The owner also
accepted Phase 11 in production. No migration `0010` exists or is pending; schema-1 initialization
and version-1 predecessor compatibility remain intentional, and removing them would require a
separately approved contract release. Recovery exercises remain independently governed.
