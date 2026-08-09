# Employee access

Administrators use `/admin/employees`; operator commands are the recovery path. Neither path can read
another employee's conversations.

## Approve or resend

```sh
pnpm identity:approve --workspace <identity> --email <employee-email> --role member
```

Use `--role admin` only for an explicitly authorized administrator. Approval is idempotent for the
same pending state and sends an invitation through the configured provider. After a delivery failure,
correct the provider and deliberately repeat the approved flow; there is no background retry. The
approval remains safe to repeat, but an ambiguous provider outcome followed by a new attempt can
deliver a duplicate invitation.

## Deactivate and revoke

```sh
pnpm identity:deactivate --workspace <identity> --email <employee-email>
```

Deactivation uses the same serialized employee-administration boundary as the browser: it blocks
authorization first, refuses to remove the final active administrator, then durably cancels the
employee's active chat and compaction work and revokes every database session. Verify the employee
is deactivated, active work is terminal, reservations are released or reconcilable, and sessions are
absent. Content and accounting follow their existing retention rules; do not delete conversations
as an access-control shortcut.

If the command exits nonzero with `"outcome":"access-blocked-cleanup-incomplete"`, access is
already blocked but cancellation or session cleanup did not finish. Correct the database/connectivity
failure and repeat the exact command until it reports `"outcome":"access-blocked"`. The cleanup is
durable and idempotent; it does not depend on reaching a particular API replica's in-memory stream
registry.

The UI and service prevent self-deactivation and removal of the last active administrator. Never
bypass those invariants with direct SQL.

## Administrator recovery

1. Recover the existing administrator mailbox/provider account using its external recovery method.
2. If another active administrator exists, use the ordinary UI to approve or restore authorized
   access.
3. If no administrator can act, use the existing idempotent operator command from the exact deployed
   checkout with private database access and an explicitly approved address.
4. Verify sign-up/fragment verification/sign-in and fresh-session administration, then remove the
   temporary database access immediately.
5. Record only address ownership confirmation, role, outcome, UTC time, and operator—not credentials
   or identity-action URLs.
