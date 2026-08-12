# Incident response

## Severity

- **SEV-1:** suspected content/credential exposure, cross-employee access, budget bypass,
  corrupting writes, lost database authority, destructive egress/domain drift, or total outage.
- **SEV-2:** sustained readiness/5xx/latency failure, failed build/migration/deployment, provider
  failure without safe fallback, email outage, reconciliation lag, exhaustion, or failed backup.
- **SEV-3:** isolated recoverable failure or observability degradation with availability.

## Response

1. Record UTC detection, safe symptom, deployment ID, full source revision, and incident lead.
   Never copy employee content, raw URLs/provider bodies, secret-bearing specs, credentials, or
   database URLs.
2. For exposure, stop sharing output and revoke affected authority when safe. For corrupting writes
   or uncertain database authority, freeze release/configuration changes, enable the reviewed
   maintenance posture, drain work, and fence the old database role.
3. Check App Platform build/job/deployment/domain/health, CPU/memory/restarts/requests/latency,
   Dedicated Egress, Uptime, component `source_commit_hash`, and public runtime revision.
4. Check PlanetScale connections, locks, storage, WAL, backups, Query Insights, role boundaries,
   and both egress `/32`s. Force new connections after IP/credential changes.
5. Check New Relic 5xx/latency, response-start, generation outcomes, budgets, reconciliation/pool
   waiting, OTLP, and log-mirror categories using content-free identifiers only.
6. Choose the narrowest reviewed response: let reconciliation finish; restart the same source;
   rotate one credential; disable one tier through policy; renew privacy attestation; deploy a
   reviewed forward `git revert`; or follow PITR/cold recreation. Do not use native rollback,
   remove Dedicated Egress, open PlanetScale, add a service, or switch providers ad hoc.
7. A resize is a separate cost/capacity decision and requires measured evidence.
8. Before ending maintenance, verify the final live contract, source/migration, one database
   authority, authentication, chat/Stop, accounting/reconciliation, email category, and telemetry.
9. Close only after cause, bounded impact, provider/config reconciliation, follow-up ownership,
   credential/session revocation, recovery evidence, and authorized cleanup are complete.

## Provider failures

- **Build/job/deployment:** preserve the last ready release, correct only the reviewed cause, and
  deploy again. Migration failure never enables API-startup migration or database reversal.
- **Dedicated Egress:** treat missing/changed addresses as SEV-1; preserve the App and never widen
  PlanetScale to restore connectivity.
- **Domain/edge:** preserve binding. Detach and verify release before controlled deletion. The
  approved accidental-deletion exception is best-effort with a 24-hour maximum binding objective.
- **Database authority:** maintenance, zero active work, revoke old writes, restore/verify in
  isolation, then use explicit cutover. App rollback does not restore database state.
- **New Relic:** use App Platform logs/Insights/Uptime and PlanetScale signals. The bounded mirror
  may drop but cannot block requests or spool to disk.
- **Managed-edge privacy/client header:** fail the candidate; do not bypass the edge or trust
  `X-Forwarded-For`.
