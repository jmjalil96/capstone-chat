# Provision and deploy

This procedure creates the approved production topology. It is not authorization to create paid
resources or mutate DNS.

## Prerequisites

- User approval for Render Pro, the paid Web Service/database sizes, DNS, Resend, and New Relic.
- `main` contains the accepted Phase 8 revision and GitHub Actions is green.
- The planning OpenRouter key has been revoked; all production credentials are newly issued.
- The operator controls `capstone.com.ec`, the Render workspace, Resend account, New Relic account,
  GitHub repository, and the administrator mailbox with recovery methods verified.

## Order

1. Validate `render.yaml` without creating resources. Confirm Virginia, one instance, PostgreSQL 18,
   no HA/read replica/pooler, `checksPass`, the readiness path, pre-deploy migration, and the private
   database reference. Local constrained load rejected the smaller Web Service candidates; the
   committed `pro_plus` Web Service and `basic-256mb` database remain unverified on Render. Replace
   them only with the smallest sizes that pass the separately authorized load rehearsal before
   accepting production readiness.
2. Before Render prompts for secrets, create the new production OpenRouter key; configure and verify
   the Resend `mail.capstone.com.ec` domain and exact sender; disable open/click tracking; create its
   send-only domain-restricted key; and create the New Relic OTLP endpoint/license value, ingest
   warning, dashboard, and approved notification channel. Keep every value only in its provider's
   secret store or the operator's secure transfer path.
3. Sync the Blueprint to create the paid PostgreSQL database and Web Service. Supply all four
   `sync: false` values from step 2 in Render, but do not change the application domain's public DNS
   yet. Temporarily allow only the operator's current public IP on the database while bootstrap
   commands are required.
4. Temporarily enable the Web Service's generated Render hostname in the dashboard. This is the
   bootstrap-only transition from the committed final-state `renderSubdomainPolicy: disabled`;
   record the setting change and do not distribute that hostname. Confirm the service exists and
   use Render's displayed custom-domain target for the next step.
5. Confirm the Blueprint-declared `chat.capstone.com.ec` custom domain on the Web Service, then
   configure its DNS record. Remove conflicting `A`/`AAAA` records and ensure CAA permits Render's
   certificate authority before changing traffic.
6. Connect the now-created Render Web Service/database to the prepared regional New Relic platform
   log and metric integrations.
7. Confirm all Render secrets through the dashboard. Never put values in `render.yaml`, shell history,
   command output, or an evidence file.
8. From the exact release checkout/image, run `pnpm db:migrate`.
9. Run the production model-policy bootstrap with the locked mappings, USD 100 budget, output limits,
   concurrency two, 2,000 basis-point margin, and a current privacy attestation. Record only its safe
   summary.
10. With Resend and `PUBLIC_ORIGIN=https://chat.capstone.com.ec` already ready, run
   `pnpm identity:bootstrap --workspace <identity> --name <workspace-name> --email <admin-email>`.
11. Remove every database public allowlist entry. Confirm the application receives only Render's
    private `fromDatabase.connectionString` binding.
12. Deploy after GitHub checks pass. Confirm `/api/health/live`, `/api/health/ready`, the SPA shell,
    static cache headers, API `no-store`, NDJSON `no-transform`, release metadata, and non-root UID.
13. Verify custom-domain TLS, HSTS, origin rejection, secure cookies, streaming without buffering,
    and that spoofed forwarding headers cannot influence rate-limit identity.
14. Complete administrator sign-up and fragment-based verification. Inspect Render/New Relic with a
    synthetic credential and confirm no identity token appears in any request path, query, or log.
15. Send controlled invitation, verification, and password-reset messages. Check Spanish text/HTML,
    final-origin links, mobile/desktop rendering, and plain-text fallback.
16. Re-sync the committed Blueprint only after the custom-origin smoke passes. Confirm its final
    `renderSubdomainPolicy: disabled` takes effect, the generated hostname no longer serves the app,
    and the custom-origin smoke still passes.

Do not declare production ready until the authorized rehearsal, device/accessibility checks,
OpenRouter smoke, and PITR rehearsal recorded by the Phase 8 plan are complete.
