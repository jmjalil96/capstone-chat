# Incident response

## Severity

- **SEV-1:** suspected content/credential exposure, cross-employee access, budget bypass, corrupting
  writes, loss of database authority, or total production outage.
- **SEV-2:** sustained readiness/5xx/latency failure, provider failure without safe fallback, email
  outage, reconciliation lag, resource exhaustion, failed backup, or repeated host/database restart.
- **SEV-3:** isolated recoverable failure or observability degradation with product availability.

## Response

1. Record UTC detection time, safe symptom, full release/digest, and incident lead. Do not copy
   employee content, raw URLs, provider bodies, credentials, or database diagnostics containing SQL
   values.
2. For suspected exposure, stop sharing logs, revoke the affected credential, restrict access, and
   preserve content-free evidence. For corrupting writes or uncertain database authority, acquire
   the deployment/recovery lock and enable the generic Caddy maintenance response before diagnosis.
3. Check DigitalOcean reachability, CPU/load, memory, disk, network, Volume, reserved-IP routing,
   firewall, systemd/Docker restarts, Caddy, and security-update state. Then check PlanetScale
   CPU/RAM, connections, locks, I/O, storage, WAL, backups, Query Insights, and IP restrictions.
4. Check readiness, durable active-release metadata, recent deploys/migrations, application pool
   waiting, 5xx, generation outcomes, reconciliation lag, and New Relic OTLP/Fluent Bit delivery.
   Use route templates, request IDs, generation IDs, stable categories, tier/purpose, and timestamps.
   Never search by prompt, response, summary, email, title, draft, search term, or identity URL.
5. Choose the narrow response: reconcile host state, restart one bounded service, roll back to the
   immediately previous compatible digest, rotate one credential, disable an affected tier through
   existing policy, renew privacy attestation, cold-rebuild the host, or follow PlanetScale PITR.
   Do not add emergency infrastructure, enable an open database rule, bypass Caddy, or change data
   authority during ordinary blue/green overlap.
6. A resize is a separate explicit decision. Record the measured CPU, RAM, or database bottleneck
   and live recurring price before changing the Droplet or PlanetScale tier. Never lower the locked
   workload or latency/correctness gates to declare the incident solved.
7. Verify release identity, migration, readiness, database authority, authentication, critical chat,
   settlement/reconciliation, and telemetry before disabling maintenance.
8. Notify the approved operator channel with impact and status but no private data. If the sole
   Bitwarden owner is unavailable, invoke the sealed offline recovery kit and record the deferred
   second-owner risk.
9. Close only after cause, bounded impact, recovery evidence, follow-up owner, external configuration
   reconciliation, and required credential/session revocation are recorded.

If New Relic is unavailable, use the protected DigitalOcean and PlanetScale dashboards plus bounded
local content-free service status. If a provider dashboard is unavailable, use safe application
telemetry and the provider status page. Observability loss must not make readiness fail after valid
startup, and it must not justify logging application content to disk.
