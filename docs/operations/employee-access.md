# Employee access

Administrators use `/admin/employees`; operator commands are the recovery path. Neither path can
read another employee's conversations. Production operator commands run from the exact deployed OCI
digest on the Droplet, use the encrypted migration/operator secret file, and connect from the
already approved PlanetScale `/32`. Never open PlanetScale to a laptop or pass a database URL on a
command line for employee administration.

## Approve or resend

Through the audited operator container boundary, run:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh identity-approve
```

Enter the workspace, employee email, and `member` role only at the helper's protected prompts. Use
`admin` only for an explicitly authorized administrator. Approval is idempotent for the
same pending state and sends through the configured provider. After a delivery failure, correct the
provider and deliberately repeat the approved flow; there is no background retry. An ambiguous
provider outcome followed by another attempt can deliver a duplicate invitation.

The email is operationally necessary and private: do not retain the prompt response in a
transcript, screenshot, or evidence. The helper keeps it out of shell history, Docker inspection,
and the journal; evidence records only role, safe outcome, UTC time, and operator.

## Deactivate and revoke

Through the same operator boundary, run:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh identity-deactivate
```

Enter the workspace and employee email only at the protected prompts.

Deactivation blocks authorization first, refuses to remove the final active administrator, then
durably cancels active chat/compaction work and revokes every database session. Verify access is
blocked, active work is terminal, reservations are released or reconcilable, and sessions are
absent. Content and accounting follow their existing retention rules; do not delete conversations
as an access-control shortcut.

If the command reports `access-blocked-cleanup-incomplete`, access is already blocked but cleanup
did not finish. Correct the bounded database/connectivity failure and repeat the exact operation
until it reports `access-blocked`. Never bypass self-deactivation or final-administrator protection
with direct SQL.

## Administrator recovery

1. Recover the administrator mailbox and Bitwarden owner account through their independent offline
   recovery methods. Record the single-owner risk if the ordinary owner is unavailable.
2. If another active application administrator exists, use the ordinary UI to approve authorized
   access.
3. If no administrator can act, run
   `sudo /opt/capstone-chat/bin/request-operator.sh identity-bootstrap` on the Droplet and answer
   its protected workspace, display-name, and email prompts. The supervisor uses the exact deployed
   image and an ephemeral composite containing the migration/operator database credential plus only
   the authentication and Resend keys. It never gives the command the application database role,
   model key, telemetry key, or default near-superuser credential.
4. Verify sign-up, fragment verification, sign-in, and fresh-session administration. No temporary
   public database rule is required because the command originates on the fixed-source Droplet.
5. Remove ephemeral input material and record only mailbox ownership confirmation, role, outcome,
   UTC time, revision/digest, and operator—not credentials, addresses, or identity-action URLs.
