# Providers, privacy, email, telemetry, and budget

## OpenRouter or model-catalog outage

1. Check catalog freshness, eligible ZDR route state, privacy-attestation age, stable provider error
   category, reservation totals, and reconciliation lag without inspecting content or raw payloads.
2. Do not route around `zdr: true`, `data_collection: "deny"`, the approved models, or the price cap.
3. Refresh metadata with `pnpm model-catalog:refresh` when the catalog is stale. A failed refresh
   preserves the last valid state; confirmed ineligibility keeps the tier unavailable.
4. If the 30-day attestation is stale, reverify the three account privacy settings and renew it with
   `pnpm model-policy:attest`. Do not infer compliance from a successful generation.
5. Allow stable employee-facing unavailable/error states. Do not add cross-tier fallback.

## Budget exhaustion or accounting lag

1. Compare actual, estimated, and reserved totals in administration; do not inspect conversations.
2. Confirm reservation expiry is 15 minutes and the reconciler is advancing.
3. Budget exhaustion is product policy, not infrastructure downtime. Change the USD 100 ceiling only
   through the authorized revision-checked administrator flow and an explicit business decision.
4. Never delete accounting rows to restore availability.

## Resend failure

1. Check verified domain, sender, send-only key restriction, tracking disabled, provider status
   category, and request timing. Never log the recipient, body, action URL, or provider response.
2. Use the existing deliberate invitation resend or public recovery flow after correction. There is
   no automatic retry or delivery queue. If the failed attempt's provider outcome was ambiguous, a
   deliberate retry can deliver a duplicate message.
3. Public auth responses remain generic regardless of provider state.

## New Relic or OTLP failure

1. Valid production telemetry configuration is required at startup. A later exporter outage does not
   fail readiness or block product requests.
2. Check Render's protected logs/metrics, OTLP endpoint region, license-key validity, export failures,
   ingest allowance, and the bounded shutdown flush.
3. Restore the one approved destination. Do not add another backend, collector, agent, or browser
   telemetry SDK during an incident.
