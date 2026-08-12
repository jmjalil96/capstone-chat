# Secret rotation

Bitwarden Teams in the Capstone organization is the recoverable source. App Platform stores runtime
copies only as component-scoped encrypted `SECRET` environment variables; private-GHCR credentials
live separately in each image source's encrypted `registry_credentials`. Provider-encrypted
`EV[...]` values are not source copies and never belong in Git, evidence, or a task.

Release, maintenance, and domain workflows serialize through the protected
`capstone-chat-production-app-spec` group. Secret and registry rotation uses the same shared
fingerprint helper only from an operator-local checkout proven equal to protected `main`, after
the workflows are frozen and the current active deployment ID is supplied as the reviewed base.
Disable shell tracing,
write fetched sensitive specs only to a mode-0600 file in a fresh temporary directory, clean every
exit path, and never place them in output, cache, artifact, or repository. The DigitalOcean control
panel is read-only for App configuration after acceptance.

Rotate one boundary at a time unless a provider requires overlap. Because a secret update triggers
a rolling deployment, account for old/new container overlap, verify the replacement becomes ready,
force new database connections after role/IP changes, and revoke the prior value only after new
authority is proven.

For runtime or registry rotation, mint a short-lived DigitalOcean token with the steady update/read
scopes and do not install it in GitHub. Place the replacement from Bitwarden in one owner-only
mode-0600 JSON file, set `CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID` to the freshly reviewed active
deployment ID and `CAPSTONE_TOOL_REVISION` to protected `main`, then invoke
`deploy/app-platform/configure.mjs rotate-runtime-secrets` or `rotate-registry` locally. A retry
with the old base is rejected after provider activation, preventing a blind second rotation.
Delete the protected input on every exit, validate the exact live contract, unfreeze workflows,
and revoke the token. GitHub must never store the rotation JSON; Bitwarden and App Platform remain
the only recoverable/runtime copies.

## Component scope

The service receives only:

```text
BETTER_AUTH_SECRET
DATABASE_URL
OPENROUTER_API_KEY
OTEL_EXPORTER_OTLP_HEADERS
RESEND_API_KEY
```

The steady `PRE_DEPLOY` job receives only its distinct migration `DATABASE_URL`. A recovery role is
absent. During empty-database first provisioning only, the temporary initialization job receives
two distinct revocable bootstrap database URLs, one short-lived catalog key, and the encrypted
bounded initialization document. It receives no final role, Better Auth, Resend, or New Relic
credential. Those variables/job are removed and the temporary roles/key revoked before the final
service activates.

The live-contract audit rejects missing, extra, wrongly scoped, plaintext, App-level, or build-time
secrets. It also rejects retained initialization configuration. Never use native rollback: it can
restore stale encrypted values and a pre-egress spec.

## Rotation order and impact

- **Better Auth:** schedule maintenance because rotation invalidates signed cookies and cursors.
  Update only the service component, deploy/readiness-check the current digest, verify auth, then
  revoke the old source value after recovery evidence is current.
- **Application database role:** create a least-privilege replacement, restrict it to both existing
  Dedicated Egress `/32`s, update only service `DATABASE_URL`, deploy, force pool reconnection, and
  prove DML plus DDL/admin denial before terminating old sessions and revoking the old role.
- **Migration database role:** rotate separately, restrict both `/32`s, update only the pre-deploy
  job, run a safe migration metadata check, prove the service cannot read/use it, then revoke old
  authority.
- **PlanetScale default near-superuser/recovery role:** keep only in Bitwarden or a separately
  authorized isolated recovery environment. It is never installed in the normal App spec or
  service console.
- **OpenRouter:** create the dedicated replacement with approved privacy settings, update only the
  service, deploy, refresh catalog, and run only a separately authorized minimal paid smoke before
  revoking the old key.
- **Resend:** create a send-only key restricted to `mail.capstone.com.ec`, update only the service,
  deploy, send one controlled template, reconfirm tracking disabled, then revoke old key.
- **New Relic:** replace the service's license-bearing OTLP header through the encrypted-variable
  path, then verify OTLP traces/metrics and the bounded direct Log API mirror before revoking the old
  value. DigitalOcean and PlanetScale native metrics use neither credential.
- **GHCR pull credential:** rotate the read-only package credential in every image-bearing block in
  one protected spec update. Submit plaintext only through the protected first-field/rotation input,
  place it only in `image.registry_credentials`, pull the exact digest into a fresh replacement,
  fetch/verify each new encrypted representation, then revoke the prior GitHub credential. Never
  substitute plaintext during an ordinary deployment.
- **GitHub GHCR-delete credential:** rotate independently in the protected GitHub environment. It
  is not the App pull credential and is never installed in DigitalOcean.
- **Steady DigitalOcean deploy token:** its scopes remain exactly `app:update`, `app:read`,
  `regions:read`, `sizes:read`, and `actions:read`; the protected App ID and dedicated-team boundary
  must still match. Freeze writers, replace the token in GitHub, run read-only live audit, then
  revoke the old token.
- **Provisioning, console, or teardown token:** mint only for the separately authorized operation
  with its exact scopes; never install it in GitHub. Revoke immediately. Delete authority is not
  created until the domain is detached and release verified.
- **Domain/TLS:** App Platform owns certificate material. Revalidate DNSSEC/CAA, managed certificate,
  primary/default-domain behavior, and account access; there is no Caddy ACME secret to rotate.
- **DigitalOcean, PlanetScale, GitHub, DNS, New Relic, Resend, OpenRouter, Bitwarden, or mailbox
  account:** recover company ownership first, test MFA/offline recovery, revoke provider sessions/
  tokens, update Bitwarden, and reconcile every live consumer. The one-owner Bitwarden posture
  remains a launch risk until a second independent owner is approved and tested.

Never expose values in command arguments, shell history, console transcripts, environment dumps,
screenshots, build/deploy/runtime/crash logs, telemetry, provider payloads, process metadata, or
evidence. If compromise is suspected, revoke first when safe, terminate affected sessions and
connections, enable maintenance for write-authority risk, and follow `incident-response.md`. Close
only after the retired value is absent from App configuration, GitHub, Bitwarden superseded items,
logs/evidence, and all active database/provider sessions.
