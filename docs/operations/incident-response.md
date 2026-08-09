# Incident response

## Severity

- **SEV-1:** suspected content/credential exposure, cross-employee access, budget bypass, unrecoverable
  writes, or total production outage.
- **SEV-2:** sustained readiness/5xx/latency failure, provider failure without safe fallback, email
  delivery outage, reconciliation lag, or resource exhaustion.
- **SEV-3:** isolated recoverable failure or observability degradation with product availability.

## Response

1. Record UTC detection time, safe symptom, release, and incident lead. Do not copy employee content.
2. For suspected exposure, stop sharing logs, revoke the affected credential, restrict access, and
   preserve evidence. For corrupting writes, enable maintenance mode before diagnosis.
3. Check Render service/database health, readiness, release, recent deploys, pool waiting, 5xx,
   generation outcomes, reconciliation lag, and New Relic export health in that order.
4. Use route templates, request IDs, generation IDs, stable error codes, tier/purpose, and timestamps.
   Never search by prompt, response, summary, email, title, or token URL.
5. Choose the narrow response: rollback a compatible application release, rotate one credential,
   disable an affected tier through existing policy, renew privacy attestation, or follow the PITR
   procedure. Do not add emergency infrastructure.
6. Validate readiness and the critical flow before disabling maintenance mode.
7. Notify the approved operator channel with impact and status but no private data.
8. Close only after the cause, bounded impact, recovery evidence, follow-up owner, and any required
   credential/session revocation are recorded.

If telemetry itself is unavailable, use Render's protected dashboard and content-free application
logs; telemetry loss must not make readiness fail.
