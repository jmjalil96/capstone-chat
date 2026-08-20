# Operations

Capstone Chat has two hosted application environments and one release path:

```text
exact green main commit
  -> protected source pointer
  -> App Platform source build
  -> migration-only PRE_DEPLOY
  -> normal server
  -> exact contract and readiness revision
```

Staging is persistent, synthetic-only, and the required pre-production gate. Production remains
the authoritative employee environment and database. Source builds from one commit are expected to
be functionally equivalent, not byte-identical. No registry publication, startup migration,
backward pointer movement, native rollback, database replacement, or routine initialization is
part of deployment.

Repository implementation is not permission to create, mutate, deploy, spend, send email, call a
paid model, change DNS, install a secret, or touch production data. Each external operation needs a
separate grant naming its target, cost/data boundary, rollback, and cleanup.

## Routine inspection

Before and after each deployment, inspect the exact service/job source commit, migration result,
active/desired contract, domain, readiness revision, resource signals, database health, telemetry,
email categories, provider budgets, and protected-pointer state. Production additionally requires
exactly two assigned Dedicated Egress addresses and database `/32` restrictions. Staging must have
no Dedicated Egress and no non-synthetic data.

The read-only validator in `deploy/app-platform/` is the deployment audit authority. Recovery
evidence remains independently validated with `pnpm verify:recovery -- <safe-evidence.json>`.
Recovery exercises are isolated PITR or controlled App recreation, not staging deployments.

## Runbooks

- [Provision and deploy](./provision-and-deploy.md)
- [Deploy and rollback](./deploy-and-rollback.md)
- [Incident response](./incident-response.md)
- [Database recovery](./database-recovery.md)
- [Providers and budget](./providers-and-budget.md)
- [Secret rotation](./secret-rotation.md)
- [Employee access](./employee-access.md)
- [Domain and TLS](./domain-and-tls.md)

Evidence contains UTC time, environment, full source revision, deployment/build ID, migration,
safe outcome, duration, provider size/region, and operator role only. Never retain credentials,
database URLs, recipients, action URLs, prompts, responses, summaries, drafts, or raw provider
payloads.
