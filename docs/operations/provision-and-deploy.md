# Provision and deploy

This runbook separates one-time provisioning from routine releases. It does not authorize an
external mutation. Obtain a target-specific grant before creating an App, database, role, key,
domain, pointer, or paid request.

## Fixed environments

| Boundary | Staging | Production |
|---|---|---|
| App origin | `https://staging.chat.capstone.com.ec` | `https://chat.capstone.com.ec` |
| Source pointer | `app-platform-staging` | `app-platform-production` |
| Service | one `apps-s-1vcpu-0.5gb` | one `apps-s-1vcpu-1gb-fixed` |
| Migration job | one `apps-s-1vcpu-0.5gb` | one `apps-s-1vcpu-0.5gb` |
| Database | independent PS-5, synthetic data | existing authoritative PS-5 |
| Database network | public, strict TLS, least privilege | exactly two Dedicated Egress `/32`s |
| Model/email | dedicated low-limit key and allowlisted sender | existing production providers |

Both Apps are in managed region `ric`; both databases are PS-5 ARM Single Node in AWS
`us-east-1`, start at 10 GB, and have a hard 15 GB ceiling. Staging has no Dedicated Egress.
Neither environment has autoscaling, scale-to-zero, a worker, second service, replica, or HA.

## Complete steady secret matrix

The service receives encrypted component-scoped `RUN_TIME` secrets only:

| Secret | Staging | Production |
|---|---|---|
| `BETTER_AUTH_SECRET` | dedicated | existing production |
| `DATABASE_URL` | staging application role | production application role |
| `OPENROUTER_API_KEY` | dedicated low-limit | existing production |
| `OTEL_EXPORTER_OTLP_HEADERS` | dedicated environment/account authority | existing production |
| `RESEND_API_KEY` | send-only, staging-domain-restricted | existing send-only production key |
| `CAPSTONE_STAGING_EMAIL_RECIPIENTS` | 1–10 unique normalized addresses | absent |

The steady migration job receives only its separate migration `DATABASE_URL` plus non-secret
`CAPSTONE_ENVIRONMENT`, `DEPLOYMENT_REVISION`, and `NODE_ENV`. Recovery and initialization
authority is absent from steady components. Staging and production keys, roles, GitHub
environments, Apps, and provider resources are never reused across environments.

Both environments require their fixed `CAPSTONE_ENVIRONMENT` value on the service and migration
job. Neither App spec contains predecessor deployment sentinels.

## One-time provisioning

1. Record one exact green `main` commit. Under separate Git authorization, create each protected
   release pointer once at that commit. Block deletion and force pushes, but allow merge commits so
   the pointer can accept the exact `main` commit. Disable App Platform autodeploy and connect only
   the matching pointer. Routine workflows cannot create an absent pointer.
2. Create the fixed App and database topology. Production obtains exactly two stable Dedicated
   Egress IPv4 addresses before any database URL is installed; allowlist each as a separate `/32`.
   Staging uses public connectivity with direct port 5432, `sslmode=verify-full`, distinct
   application/migration/recovery roles, and no claim of an IP-allowlist boundary.
3. If domain, egress, or recovery sequencing requires an App with no product authority, temporarily
   run `node apps/api/dist/entrypoint.js health-bootstrap`. It exposes only fixed health routes and
   a revision header. Remove it before applying the hosted contract; it is not a release stage,
   maintenance mode, or accepted application deployment.
4. Attach the fixed domain and edge settings through [Domain and TLS](./domain-and-tls.md). Create
   dedicated Resend/OpenRouter/telemetry resources. Staging's sender is exactly
   `Capstone Chat Staging <no-reply@staging.mail.capstone.com.ec>` and its Resend key is send-only
   and restricted to that domain.
5. For an empty database only, temporarily add one source-built initialization job using
   `node apps/api/dist/entrypoint.js initialize`, `NODE_ENV=production`, the environment's exact
   `CAPSTONE_ENVIRONMENT`, and `CAPSTONE_INITIALIZATION_SCHEMA_VERSION=1`. Give it only the two
   distinct bootstrap database URLs, the canonical initialization document, and the environment's
   short-lived catalog key. It receives no steady application role, Better Auth, Resend, or New
   Relic secret.
6. Require ordered migrations, the schema-1 document-hash latch, an idempotent exact repeat,
   conflict rejection before provider work, one workspace/pending administrator, and no invitation.
   Remove the initialization job and variables and revoke both bootstrap roles and the temporary
   key. Initialization is never repeated during deployment or recovery.
7. Apply the common contract and matching fixed environment overlay from
   `deploy/app-platform/contract.mjs`. Require the normal server, one migration-only `PRE_DEPLOY`
   job, exact source/Dockerfile/branch, health and termination, encrypted component variables,
   fixed domain/edge, and no extra component or in-progress deployment. Production alone has
   Dedicated Egress.
8. Capture the desired and active provider state in an owner-only temporary file and run the
   focused `staging` or `production` validator. Require both service and job to report the frozen
   commit and public readiness to return the same `x-capstone-revision`.
9. Seed staging with synthetic identities and conversations only. Exercise invitation,
   verification, and password-reset delivery solely to allowlisted recipients. A rejected address
   must cause no Resend call and expose no address.
10. Configure GitHub environments and the shared release action as described in
    [Deploy and rollback](./deploy-and-rollback.md). Thereafter all releases use the short steady
    path; configuration/provisioning changes remain separately reviewed.

Owner acceptance of a source release does not authorize real employee data. Production receives no
real employee data until staging, bounded production smokes, TLS, database authority, telemetry,
failure preservation, forward revert, Ecuador/browser/accessibility, aged isolated PITR,
controlled cold recreation, and the first controlled email gate pass.

## Recovery is separate

Staging is not a backup or restored-data validation environment. PITR and cold-recreation exercises
remain isolated, preserve the authoritative source database, and use
[Database recovery](./database-recovery.md). They never receive the initialization document,
initialization roles, or first-invitation authority.
