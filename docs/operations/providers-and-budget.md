# Providers, privacy, email, telemetry, and budget

## OpenRouter or model-catalog outage

1. Check catalog freshness, eligible ZDR route state, privacy-attestation age, stable provider error
   category, reservations, and reconciliation without inspecting content or raw payloads.
2. Never route around `zdr: true`, `data_collection: "deny"`, approved models, price ceilings, or
   the selected tier.
3. Run catalog refresh from the existing administrator model-policy screen. Use the reviewed
   bounded application-role console helper only for privacy re-attestation on one verified ready
   App Platform instance. Its input arrives through standard input; the helper verifies deployment
   ID, digest/revision, non-root user, readiness, and current database authority. There is no SSH,
   persistent operator file, or migration/recovery credential.
4. A failed metadata refresh preserves last valid state; confirmed ineligibility or a stale
   30-day attestation keeps the tier unavailable. Do not infer privacy compliance from a successful
   generation.
5. Keep the stable employee-facing unavailable/error state. There is no cross-tier fallback.

## Budget exhaustion or accounting lag

1. Compare actual, estimated, and reserved totals in administration; never inspect conversations.
2. Confirm reservation expiry is 15 minutes, the reconciler advances, and active workflows remain
   bounded across the workspace month boundary.
3. Budget exhaustion is product policy, not platform downtime. Change the USD 100 ceiling only
   through the revision-checked administrator flow and an explicit business decision.
4. Never delete accounting, weaken row locking, alter cost precision, or enlarge a provider limit
   to restore availability.

## Resend failure

1. Check verified domain, exact sender, send-only/domain restriction, disabled tracking, stable
   provider category, and timing. Never log recipient, body, action URL, or provider response.
2. After correction use deliberate invitation resend or the public recovery flow. There is no
   background retry or queue; an ambiguous timeout followed by deliberate retry can deliver a
   duplicate message without duplicating approval authority.
3. Public authentication responses remain generic regardless of provider state.

## New Relic OTLP or direct-log-mirror failure

1. Valid production OTLP and direct-log-mirror configuration is required at startup. A later
   exporter/Log API outage does not fail readiness or block an employee request.
2. Check the configured regional OTLP destination and its exact mirror mapping: US
   `https://otlp.nr-data.net` maps to `https://log-api.newrelic.com/log/v1`; EU
   `https://otlp.eu01.nr-data.net` maps to `https://log-api.eu.newrelic.com/log/v1`. Verify one
   component-scoped license
   credential, bounded queue/drop/retry counters, New Relic ingest allowance, and shutdown flush
   without inspecting application bodies.
3. Confirm only allowlisted content-free Pino fields are mirrored. The in-process queue is bounded
   to 1,024 records or 1 MiB, batches to 64 records or 128 KiB, one request at a time, three total
   attempts with bounded backoff, a three-second request timeout, and a five-second shutdown flush.
   It has no disk spool, sidecar, worker, collector, proprietary agent, or second vendor.
4. App Platform stdout/live/crash logs remain the immediate fallback. On sustained outage the
   mirror drops oldest records and increments content-free drop metrics; it never blocks chat or
   recursively logs its own drop signal.
5. Sample App Platform and New Relic output for absence of prompts, responses, drafts, summaries,
   search/title text, email, cookies, authorization, URLs, database URLs, stacks, and raw provider
   payloads before closing the incident.

## DigitalOcean and PlanetScale signals

App Platform Insights/alerts own deployment, domain, job, CPU, memory, restart, request, and latency
signals. One DigitalOcean Uptime check independently owns public readiness/TLS/latency. PlanetScale
owns protected database CPU/RAM, connections, locks, I/O, storage, WAL, backups, and Query Insights.
New Relic owns retained allowlisted application logs plus application traces/metrics. Do not add a
host agent, scraper, browser agent, collector, second telemetry vendor, or readiness dependency to
fill a provider gap.

If a provider dashboard or alert path fails, use the other approved content-free evidence and
provider status pages. Where a threshold alert is unavailable, perform the documented manual review
rather than adding a polling worker.

## Infrastructure and provider cost review

Review the dedicated DigitalOcean team's complete bill monthly because the App Platform transfer
allowance is team-pooled and DigitalOcean does not expose cumulative accrued transfer in the same
way as a reserved per-App quota. Recheck the Uptime allowance and overage before provisioning.

| Component | Candidate monthly estimate |
|---|---:|
| One `apps-s-1vcpu-1gb-fixed` service | USD 10 |
| Dedicated Egress pair | up to USD 25 |
| PlanetScale PS-5 Single Node, 10 GB included | USD 5 |
| One Uptime check | USD 0 if included; otherwise USD 1 |
| **Infrastructure base** | **USD 40–41** |
| One Bitwarden Teams owner | USD 4 |
| **Operational base** | **USD 44–45** |

At the approved 15 GB database ceiling, the prior estimate is approximately USD 44.63–45.63.
Migration and one-time initialization jobs are billed only while running and require recorded live
estimates. Transfer, backup/WAL/storage overage, rehearsal/recovery resources, DNS, taxes, support,
and provider drift remain variable. New Relic and Resend free allowances must be reverified.
OpenRouter remains separately hard-capped by the application at USD 100/month.

Any service/database size, second Bitwarden seat, add-on, storage ceiling, second instance,
autoscaling, or other recurring-cost change requires measured evidence and an explicit decision.
The 512 MiB service is not an automatic downgrade.
