# Secret rotation

Bitwarden Teams in the Capstone organization is the recoverable source. Runtime copies live only in
narrowly permissioned files beneath the encrypted Volume at `/srv/capstone-secure`; the application
and migration containers receive only their respective read-only files under
`/run/capstone-secrets`. Rotate one credential at a time, record only owner/version and UTC outcome,
and verify the affected boundary before removing the old value.

Never expose values in shell arguments, history, environment dumps, Docker inspection, screenshots,
logs, telemetry, cloud-init, unit files, the unencrypted root disk, or evidence. Install a new file
through the root-owned audited path using create-write-`fsync`-rename semantics; reject symlinks,
wrong owner/mode, unexpected keys, or cross-readable directories. Confirm host and unit core dumps
remain disabled. Installing or replacing encrypted-Volume secret files requires an explicitly
authorized, time-bounded DigitalOcean recovery-console root session; public root SSH remains
disabled, and the ordinary operator never receives broad sudo.

## Order and impact

- **Better Auth secret:** schedule a maintenance window. Replacing it invalidates signed session
  cookies and cursor signatures. Install the new runtime file, activate one release, verify auth,
  then remove the old value from the Volume and Bitwarden only after recovery evidence is current.
- **Application database role:** create the least-privilege replacement in PlanetScale, retain the
  database-wide Droplet `/32`, install the runtime file atomically, activate and verify readiness,
  pool/session timeouts, reads/writes, and denial of DDL/admin work, then terminate old backends and
  revoke the old role.
- **Migration database role:** rotate separately from runtime. Install only in the migration file,
  run a safe metadata/migration preflight, prove the application cannot read it, then revoke the old
  role. Never put it in the long-running container.
- **PlanetScale default near-superuser role:** keep only in Bitwarden. Rotate through the provider,
  verify database-wide `/32` restriction and recovery access, and do not install it on the Droplet
  unless a documented provider-only recovery task is separately authorized.
- **OpenRouter key:** create a dedicated replacement with the approved workspace/privacy settings,
  install the runtime file, activate, refresh metadata, run only the separately authorized minimal
  smoke, then revoke the old key.
- **Resend key:** create a send-only key restricted to `mail.capstone.com.ec`, install it, activate,
  send one controlled template, then revoke the old key. Reconfirm tracking is disabled.
- **New Relic credentials:** rotate Fastify's OTLP key and Fluent Bit's Log API key independently in
  their separate Volume directories. Verify traces/application metrics or logs and alerts before
  revoking the corresponding old key. DigitalOcean/PlanetScale metrics use neither credential.
- **GHCR pull credential:** rotate the dedicated deployment identity's classic PAT with only
  `read:packages`, update its isolated Docker configuration on the Volume, pull a protected digest,
  then revoke the old PAT. Record MFA/SSO and the deferred second recovery owner.
- **Caddy ACME account material:** normally let Caddy renew from its isolated encrypted state. For
  compromise, enter maintenance if required, replace/reissue through the audited Caddy service,
  verify the public chain and renewal, then remove superseded material.
- **SSH key:** add the replacement public key while the current key still works, confirm the named
  non-root operator can enter from the approved `/32` and only the audited sudo boundary, then
  remove the old key. No password/root SSH and no docker-group membership.
- **DigitalOcean, PlanetScale, GitHub, DNS, New Relic, Resend, OpenRouter, or Bitwarden account:**
  recover company ownership first, enable/test MFA and offline recovery, rotate sessions/tokens in
  the provider, then update Bitwarden. The one-owner Bitwarden posture remains a launch risk until a
  second independent owner is deliberately added and tested.

If compromise is suspected, revoke first when safe, terminate affected sessions/connections, enable
maintenance for a database-authority or write-integrity risk, and follow
[incident response](./incident-response.md). After every rotation, scan the root disk, container
metadata, logs, evidence, and process arguments for the retired value before closing the change.
