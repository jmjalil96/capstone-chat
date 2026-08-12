# Incident response

## Severity

- **SEV-1:** suspected content/credential exposure, cross-employee access, budget bypass, corrupting
  writes, lost database authority, destructive egress/domain drift, or total production outage.
- **SEV-2:** sustained readiness/5xx/latency failure, failed deployment/pre-deploy job, provider
  failure without safe fallback, email outage, reconciliation lag, resource exhaustion, failed
  backup, or repeated App/database restart.
- **SEV-3:** isolated recoverable failure or observability degradation with product availability.

## Response

1. Record UTC detection, safe symptom, current App deployment ID, full revision/digest, and incident
   lead. Never copy employee content, raw URLs, provider bodies, secret-bearing App specs,
   credentials, database URLs, or SQL values.
2. For suspected exposure, stop sharing output, revoke the affected credential when safe, restrict
   access, and preserve content-free evidence. For corrupting writes or uncertain database
   authority, serialize App-spec mutation, enable the reviewed maintenance posture, drain/cancel
   work, and fence the old database role before diagnosis.
3. Check App Platform deployment and `PRE_DEPLOY` outcomes, domain state, readiness/liveness,
   Insights CPU/memory/restarts/requests/latency, live/crash logs, Dedicated Egress pair, and the
   independent DigitalOcean Uptime check. Distinguish a same-digest provider restart from a new
   release.
4. Check PlanetScale CPU/RAM, connections, locks, I/O, storage, WAL, backup schedule/age, Query
   Insights, role boundaries, and both egress `/32` restrictions. Force new connections after an IP
   or credential change; provider restriction changes do not repair existing sessions.
5. Check New Relic application 5xx/latency, response-start, generation outcomes, budgets,
   reconciliation/pool waiting, OTLP, and direct-log-mirror delivery/drop categories. Use route
   templates, request/generation IDs, stable categories, tier/purpose, deployment ID, and
   timestamps—not prompt, response, summary, email, title, draft, search, URL, or provider payload.
6. Choose the narrowest reviewed response: allow reconciliation to finish; restart the same digest;
   rotate one credential; disable an affected tier through policy; renew privacy attestation;
   forward-deploy the immediately previous compatible digest; or follow PlanetScale PITR/cold App
   recreation. Do not click native rollback, edit the App spec in the control panel, remove
   Dedicated Egress, open PlanetScale, add a service, or switch providers during an incident.
7. A resize is a separate explicit decision. Record measured service CPU/memory or PS-5 bottleneck
   and live recurring price before changing `apps-s-1vcpu-1gb-fixed` or PS-5. Never lower workload,
   latency, privacy, or correctness gates to close the incident.
8. Before disabling maintenance, verify live-spec fingerprint, unchanged egress/domain/secrets,
   exact release/migration, one database authority, authentication, critical chat/Stop,
   settlement/reconciliation, email category, and telemetry.
9. Notify the approved channel with impact and status but no private data. If the sole Bitwarden
   owner is unavailable, invoke the sealed kit and record the deferred second-owner risk.
10. Close only after cause, bounded impact, provider/config reconciliation, follow-up owner,
    required credential/session revocation, recovery evidence, and any separately authorized
    resource cleanup are complete.

## Provider-specific failures

- **Deployment or job failure:** keep the last ready release serving. Capture safe deployment/job
  status, correct only the reviewed cause, and redeploy. Migration failure never triggers API-
  startup migration or database reversal.
- **Dedicated Egress missing or changed:** treat as SEV-1 because PlanetScale network authority may
  fail or widen. Stop App-spec writes, preserve the App, compare the live contract, and never remove
  restrictions to restore connectivity.
- **Domain or managed-edge failure:** preserve the App/domain binding. For planned replacement,
  detach and verify release before delete. If accidental deletion leaves a binding, escalate to
  DigitalOcean support and record the four-hour-RTO gap honestly.
- **Database-authority incident:** maintenance, zero active work, revoke old write authority,
  restore/verify in isolation, then use the explicit cutover procedure. Native rollback cannot
  restore database state.
- **New Relic outage:** use App Platform live/crash logs, Insights/Uptime, and PlanetScale protected
  signals. The bounded mirror may drop; it must not block requests or spool to disk.
- **App Platform dashboard outage:** use safe application telemetry, DigitalOcean status, Uptime,
  and PlanetScale. Observability loss never justifies content logging or weakened readiness.
- **Managed-edge privacy or client-header failure:** fail the candidate/production boundary and
  preserve evidence. Do not bypass the edge or trust `X-Forwarded-For`.
