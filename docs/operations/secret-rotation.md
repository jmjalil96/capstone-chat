# Secret rotation

Rotate one credential at a time, record only its owner/version and UTC completion, and verify the
affected boundary before removing the old value. Never expose values in commands, screenshots,
shell history, logs, or evidence.

## Order and impact

- **Better Auth secret:** schedule a maintenance window. Replacing it invalidates signed session
  cookies and cursor signatures; require all employees to sign in again. Deploy the new value once,
  verify auth, then revoke the old secret.
- **Database credential:** create/rotate through Render, update the private binding, deploy, verify
  migrations/readiness/pool health, then revoke the old credential. Never enable public access as a
  rotation shortcut.
- **OpenRouter key:** create a dedicated replacement with the approved workspace settings, update
  Render and operator storage, deploy, refresh safe metadata, run only the separately authorized
  minimal smoke, then revoke the old key.
- **Resend key:** create a send-only key restricted to `mail.capstone.com.ec`, update Render and the
  operator environment, deploy, send one controlled template, then revoke the old key. Reconfirm
  tracking is disabled.
- **New Relic license key:** replace the Render log-stream/metrics integration and OTLP header in a
  coordinated window, deploy, verify logs/metrics/traces and alerts, then revoke the old key.
- **Render/GitHub deploy access:** restore owner recovery access first, rotate the credential in the
  provider dashboard, verify checks-pass deployment with a no-op candidate, then revoke old access.

If compromise is suspected, revoke first when safe, terminate affected sessions, and follow
[incident response](./incident-response.md).
