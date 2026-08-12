# Secret rotation

Bitwarden Teams in the Capstone organization is the recoverable source. App Platform stores only
component-scoped encrypted `RUN_TIME` `SECRET` copies. Provider-encrypted values are not source
copies and never belong in Git, evidence, tasks, screenshots, or command output.

Rotate one boundary at a time unless a provider requires overlap. Freeze release-pointer changes,
confirm `app-platform-production` is the accepted green commit, record the active deployment, and
make the authorized change in App Platform. Configuration changes can rebuild source, so require
the service/job `source_commit_hash` and public readiness revision to remain on the frozen commit.
Verify the replacement before revoking the old value.

## Component scope

The steady service receives only:

```text
BETTER_AUTH_SECRET
DATABASE_URL
OPENROUTER_API_KEY
OTEL_EXPORTER_OTLP_HEADERS
RESEND_API_KEY
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is a non-secret service variable. The steady `PRE_DEPLOY` job
receives only its distinct migration `DATABASE_URL`. A recovery role is absent.

During first provisioning only, the temporary initialization job receives two distinct bootstrap
database URLs, the bounded initialization document, and the short-lived catalog key where needed.
It receives no final database role, Better Auth, Resend, or New Relic credential. Remove the job
and variables and revoke those temporary authorities before the final service activates.

The read-only live validator rejects missing, extra, wrongly scoped, plaintext, App-level, or
build-time secrets and retained initialization configuration. No secret may be a Docker build
argument.

## Rotation order and impact

- **Better Auth:** schedule maintenance because rotation invalidates cookies and cursors. Update
  only the service, verify authentication, then revoke the old value.
- **Application database role:** create a least-privilege replacement restricted to both existing
  egress `/32`s, update only the service, force new connections, prove DML and DDL/admin denial,
  terminate old sessions, then revoke.
- **Migration database role:** rotate separately, restrict both `/32`s, update only the job, run a
  safe migration metadata check, prove the service cannot use it, then revoke.
- **Recovery/default database role:** keep only in Bitwarden or an authorized isolated recovery
  environment; never install it in the normal App.
- **OpenRouter:** preserve approved privacy and price controls, update only the service, refresh the
  catalog, run a separately authorized minimal paid smoke, then revoke.
- **Resend:** use a send-only key restricted to `mail.capstone.com.ec`, keep tracking disabled,
  update only the service, send one controlled template, then revoke.
- **New Relic:** replace only the service's license-bearing header and verify OTLP plus bounded log
  mirror delivery before revocation.
- **GitHub source integration:** review repository-only access and branch protections before
  replacing/re-authorizing it. It is not a runtime secret.
- **DigitalOcean deployment token:** keep the pinned App ID and minimum deploy/read scope, replace
  it in the protected GitHub environment, run a read-only audit, then revoke the old token.
- **Provisioning, console, or teardown authority:** mint only for the separately authorized
  operation and revoke immediately. Delete authority is granted only after domain release.

Never expose values in shell arguments/history, console transcripts, environment dumps,
build/deploy/runtime/crash logs, telemetry, provider payloads, process metadata, or evidence. If
compromise is suspected, revoke first when safe, terminate affected sessions/connections, enable
maintenance for write-authority risk, and follow [incident response](./incident-response.md).
