# Employee access

Administrators use `/admin/employees` for ordinary employee lifecycle work. Fastify remains the
authorization boundary; an administrator cannot read another employee's conversations. App
Platform console commands are a rare recovery seam, not the routine administration interface.

There is no SSH or persistent operator filesystem. A separately authorized console operation must
resolve exactly one ready service instance, verify its deployment ID, immutable GHCR digest,
image-owned full revision, non-root UID 1000, and current database authority, then accept bounded
private input only through standard input with shell tracing/history disabled. The service has only
the application database role; it cannot run migrations or read recovery credentials.

## Approve, invite, or resend

Use `/admin/employees` with a session authenticated within the last 15 minutes:

1. Approve the normalized company email as `member`; use `admin` only under explicit authorization.
2. Send or resend deliberately through the configured Resend boundary. There is no background retry
   or delivery queue. A timeout with ambiguous provider outcome can make a deliberate retry send a
   duplicate message, but cannot duplicate approval or membership authority.
3. Record only role, safe outcome, UTC time, release revision, and operator. Never retain email,
   provider response, or the fragment-bearing action URL.

Approval is idempotent for the same pending state. A pending role can be corrected through the
approved flow; active/deactivated conflicts fail rather than silently changing access.

## First administrator invitation

Empty-database first provisioning deliberately creates the canonical pending administrator
approval without email while the health-only bootstrap still returns 404 for product routes. Only
after the final exact service is ready may a bounded application-role console command send the
initial invitation:

- it re-resolves the existing approval and never creates or changes authority;
- it accepts its at-most-32-KiB input through standard input;
- it uses only the final application role, Better Auth secret, public origin, sender, and Resend
  key; and
- it emits only a content-free sent/retry-safe outcome.

The temporary initialization job cannot send email and must already be absent, with its roles/key
revoked. Recovery or cold recreation of an initialized database never repeats initialization or
sends this initial invitation.

## Deactivate and revoke

Use the administrator UI. Deactivation blocks authorization first, refuses self-deactivation and
removal of the final active administrator, then durably cancels chat/compaction work and revokes
sessions. Verify access is blocked, work is terminal, reservations are settled/reconcilable, and
sessions are absent. Content and accounting retain their existing policies; conversation deletion
is not an access-control shortcut.

If the operation reports `access-blocked-cleanup-incomplete`, access is already blocked. Correct
the bounded database/provider problem and deliberately repeat until cleanup completes. Never use
direct SQL to bypass final-administrator protection.

## Administrator recovery

1. Recover the administrator mailbox and company Bitwarden owner through independent offline
   methods. Record the one-owner risk if the ordinary owner is unavailable.
2. If another active application administrator exists, use the ordinary UI to approve the
   authorized replacement.
3. If none can act, stop for action-specific authorization of the reviewed bounded identity
   recovery command on one verified ready App Platform instance. Do not rerun the first-
   initialization contract, alter the initialization latch, add an initialization job, or open
   PlanetScale to an operator laptop.
4. The recovery command may use only application identity/email authority required by its reviewed
   contract. It receives no migration, recovery, model, telemetry, GHCR, or DigitalOcean token and
   cannot perform DDL.
5. Verify sign-up, fragment verification, sign-in, fresh-session administration, and the canonical
   administrator count. Record only safe outcome, role, UTC time, deployment ID, revision/digest,
   and operator.

If no source-controlled command satisfies this boundary, recovery is blocked pending a reviewed
repository change; console improvisation or direct database mutation is prohibited.
