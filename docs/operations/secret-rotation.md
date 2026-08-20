# Secret rotation

Bitwarden Teams is the recoverable source for production secrets. Staging uses separate provider
resources and credentials. App Platform holds encrypted component-scoped `RUN_TIME` copies only;
encrypted dashboard values are not recovery sources and never belong in Git or evidence.

Rotate one environment and one boundary at a time. Freeze its release pointer, record the active
deployment and revision, install the authorized replacement, require the exact hosted contract and
readiness revision, verify the new authority, then revoke the old one.

## Steady scopes

The service has `BETTER_AUTH_SECRET`, `DATABASE_URL`, `OPENROUTER_API_KEY`,
`OTEL_EXPORTER_OTLP_HEADERS`, and `RESEND_API_KEY`. Staging alone also has
`CAPSTONE_STAGING_EMAIL_RECIPIENTS`. `OTEL_EXPORTER_OTLP_ENDPOINT` is non-secret. The migration job
has only its distinct migration `DATABASE_URL`; recovery and initialization credentials are absent.
The validator rejects extra, plaintext, wrongly scoped, App-level, or build-time secrets.

- **Better Auth:** update the service only; rotation invalidates cookies and cursors.
- **Application database role:** replace the environment's least-privilege role, force new
  connections, prove DML plus DDL/admin denial, then revoke. Production retains both egress `/32`s;
  staging retains strict `verify-full` public connectivity without claiming an IP allowlist.
- **Migration role:** rotate separately in the job, prove migration metadata access and service
  denial, then revoke.
- **OpenRouter:** preserve privacy/price policy, use the environment's dedicated key, refresh the
  catalog, authorize any paid smoke separately, then revoke.
- **Resend:** production uses its existing `mail.capstone.com.ec` key and sender. Staging uses a
  separate send-only key restricted to `staging.mail.capstone.com.ec`, the exact staging sender,
  and the 1–10-recipient allowlist. Prove a rejected recipient makes no provider request.
- **New Relic:** replace only the environment's license-bearing header; verify OTLP and bounded log
  mirror delivery before revocation.
- **GitHub/DigitalOcean:** preserve repository-only source access, protected pointers, fixed App
  IDs, environment separation, and minimum deployment-token scopes.

First-provisioning initialization roles, document, and catalog key are short-lived and never
rotated into steady service. Recovery credentials remain in Bitwarden or an isolated authorized
recovery environment only.

Never expose secrets through shell arguments/history, environment dumps, console transcripts,
screenshots, logs, telemetry, provider payloads, or evidence. For suspected compromise, revoke
when safe, terminate affected sessions/connections, freeze releases, and follow
[Incident response](./incident-response.md).
