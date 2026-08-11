# Providers, privacy, email, telemetry, and budget

## OpenRouter or model-catalog outage

1. Check catalog freshness, eligible ZDR route state, privacy-attestation age, stable provider error
   category, reservation totals, and reconciliation lag without inspecting content or raw payloads.
2. Do not route around `zdr: true`, `data_collection: "deny"`, the approved models, or the price cap.
3. When the catalog is stale, refresh metadata through the audited operator container:

   ```sh
   sudo /opt/capstone-chat/bin/request-operator.sh model-catalog-refresh
   ```

   A failed refresh preserves the last valid state; confirmed ineligibility keeps the tier
   unavailable.
4. If the 30-day attestation is stale, reverify the three account privacy settings, stage the
   approved attestation JSON as a root-owned `0400` file beneath `/run/capstone-input` during a
   named, time-bounded recovery-console root session, close that console, and renew it through the
   protected workspace/file prompts:

   ```sh
   sudo /opt/capstone-chat/bin/request-operator.sh model-policy-attest
   ```

   Remove the staged source immediately afterward. Do not infer compliance from a successful
   generation.
5. Keep the stable employee-facing unavailable/error state. Do not add cross-tier fallback.

## Budget exhaustion or accounting lag

1. Compare actual, estimated, and reserved totals in administration; do not inspect conversations.
2. Confirm reservation expiry is 15 minutes and the reconciler is advancing.
3. Budget exhaustion is product policy, not infrastructure downtime. Change the USD 100 ceiling only
   through the authorized revision-checked administrator flow and an explicit business decision.
4. Never delete accounting rows, weaken locking, or enlarge a provider limit to restore availability.

## Resend failure

1. Check verified domain, sender, send-only key restriction, tracking disabled, provider status
   category, and request timing. Never log the recipient, body, action URL, or provider response.
2. Use the existing deliberate invitation resend or public recovery flow after correction. There is
   no automatic retry or delivery queue. An ambiguous failed attempt can make a deliberate retry
   deliver a duplicate message.
3. Public authentication responses remain generic regardless of provider state.

## New Relic, OTLP, or Fluent Bit failure

1. Valid production OTLP and Fluent Bit configuration is required at startup/install verification.
   A later exporter or Log API outage does not fail readiness or block employee requests.
2. Check the regional OTLP endpoint, application key, Fluent Bit Log API key, bounded retry/drop
   counters, New Relic ingest allowance, and shutdown flush. Do not inspect application bodies.
3. Confirm Docker's Fluentd path remains non-blocking with the dual-log cache disabled and Fluent
   Bit has no filesystem buffer. Confirm the 16 KiB raw-record bound, parsed-data discard, and exact
   operational-field allowlist remain active; prompt/response/email/cookie/authorization/URL/query/
   provider-body/database-URL fields must be absent from a controlled malicious fixture.
   Confirm the encrypted `new-relic.env` is root-owned `0440` and contains exactly one nonempty
   `NEW_RELIC_LICENSE_KEY` assignment with no quoting, expansion, control syntax, or extra key; the
   service's data-only launcher must reject any drift without printing the value or asking systemd
   to parse the secret as environment syntax.
   Exhaustion may drop telemetry; it must never write application logs to the unencrypted root disk
   or block chat.
4. Restore New Relic as the one external application/log destination. Do not add another backend,
   collector, New Relic infrastructure agent, browser agent, scraper, sidecar, or disk spool.

## DigitalOcean or PlanetScale signal failure

DigitalOcean Monitoring remains authoritative for host CPU/load, memory, disk, network, reboot, and
availability. PlanetScale's protected dashboard remains authoritative for database CPU/RAM,
connections, I/O, locks, storage, WAL, backups, and Query Insights. If one dashboard or alert path is
unavailable, use the other approved content-free application evidence and provider status pages;
telemetry loss alone is not a reason to weaken readiness, database restrictions, privacy, or budget
rules. Where PS-5 lacks a threshold alert, perform the documented manual review rather than adding a
polling worker.

## Cost review

The approved starting baseline is USD 11.10/month infrastructure plus one USD 4 Bitwarden Teams
owner: USD 15.10/month before taxes, temporary resources, backup/WAL/network overage, and model use.
At the 15 GB database ceiling it is approximately USD 15.73/month. OpenRouter remains independently
hard-capped by the application at USD 100/month. Verify live provider estimates and alerts; do not
resize, add a Bitwarden seat, increase storage, or purchase an add-on without recording the revised
recurring cost and obtaining approval where required.
