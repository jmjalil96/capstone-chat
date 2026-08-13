# Employee access

Administrators use `/admin/employees` for ordinary employee lifecycle work. Fastify remains the
authorization boundary; administrators cannot read another employee's conversations. App
Platform console commands are a rare separately authorized recovery seam, not a routine interface.

## Bounded production console

The old repository console wrapper is intentionally gone. For either approved command below, use
DigitalOcean's native console directly and do not improvise a second tunnel or helper:

1. Obtain separate, short-lived authorization for the named command. Mint a custom DigitalOcean
   token with exactly `app:access_console` and its required `app:read`, `regions:read`,
   `sizes:read`, and `actions:read` scopes. Do not add `app:update`, create, delete, database,
   registry, or account-wide write scope. Store it only in a temporary `doctl` context by running
   `doctl auth init --context capstone-production-console` and entering the token at the prompt;
   never pass the token as a command argument.
2. Resolve the accepted App and active deployment IDs through the dashboard or read-only provider
   evidence. Confirm the deployment is `ACTIVE`, both components report the accepted full source
   commit, and public `/api/health/ready` reports that same revision.
3. Open the service component from the exact deployment:

   ```sh
   doctl apps console "$DIGITALOCEAN_APP_ID" capstone-chat \
     --deployment "$EXPECTED_DEPLOYMENT_ID" \
     --context capstone-production-console
   ```

4. In the remote shell, first run `set +x` and `unset HISTFILE`. Run `id -u` and require exactly
   `1000`. Run `printf '%s\n' "$DEPLOYMENT_REVISION"` and require the accepted full source commit.
   Do not run `env`, `printenv`, shell tracing, a database client, or any command that prints
   credentials.
5. Require fresh accepted live-contract evidence for this deployment and fresh PlanetScale
   evidence that its `DATABASE_URL` role is the application role: not superuser, database creator,
   role creator, replication, or row-security bypass; no database or `public`-schema `CREATE`;
   restricted to both current Dedicated Egress `/32`s; and no migration or recovery authority. If
   that evidence is absent or predates the deployment or role change, stop. Do not inspect or print
   the URL to recreate the check from the console.
6. Run only the approved command below using the echo-safe wrapper shown there. The wrapper turns
   PTY echo off before Node reads the private JSON, restores it when Node exits, and reports only
   the exit status. Paste the JSON only after Node is waiting, then finish it with Control-D. If
   the command or connection is interrupted and the prompt remains visually blank, type
   `stty echo` and press Return even though those characters are not visible. Do not capture the
   terminal or copy its scrollback into evidence.
7. Type `exit`, revoke the DigitalOcean token immediately, run
   `doctl auth remove --context capstone-production-console`, and record only UTC time, deployment
   ID, source commit, command name, safe outcome, and operator.

The console is ephemeral and is never a place to create files or modify the running instance.

## Approve, invite, or resend

Use `/admin/employees` with a session authenticated within the last 15 minutes:

1. Approve the normalized company email as `member`; use `admin` only with explicit authorization.
2. Send or resend deliberately. There is no queue or background retry. An ambiguous timeout can
   cause duplicate mail on a deliberate retry, but cannot duplicate approval authority.
3. Record only role, safe outcome, UTC time, source revision, and operator. Never retain the email,
   provider body, or fragment-bearing action URL.

## First administrator invitation

First initialization creates one canonical pending administrator approval without sending email.
Final service readiness alone is insufficient. Only after every pre-invitation gate in
[Provision and deploy](./provision-and-deploy.md)—including the bounded production smokes,
Ecuador/browser/accessibility, aged isolated PITR, controlled cold recreation, and final
pre-invitation review—passes may the bounded application-role command send the owner invitation as
the final controlled email gate. It re-resolves existing authority, accepts at most 32 KiB through
standard input, cannot create or change membership, and emits only a content-free outcome. Prove
invitation, verification, and password-reset delivery before inviting a second employee. The
temporary initialization job must be absent and its roles/key revoked. Recovery never repeats
initialization or this invitation.

After completing the bounded-console checks above, run this exact single line in the remote shell:

```sh
stty -echo; trap 'stty echo' EXIT HUP INT TERM; node apps/api/dist/entrypoint.js invite-initial; capstone_status=$?; stty echo; trap - EXIT HUP INT TERM; printf '\ncommand-exit:%s\n' "$capstone_status"
```

Paste the same canonical production initialization JSON used by the completed initialization job,
then press Control-D. Require `command-exit:0`; the only successful application outcome is
`{"command":"invite-initial","outcome":"sent","retrySafe":true}`. A failure is not permission
to change membership or retry blindly; retain only its content-free error category and diagnose the
bounded cause.

## Deactivate and recover

Deactivation blocks authorization first, refuses self-deactivation and removal of the final active
administrator, then cancels work and revokes sessions. If cleanup is incomplete, access is already
blocked; correct the bounded failure and repeat. Never bypass the guard with direct SQL.

For administrator recovery, recover the mailbox and Bitwarden owner first. Prefer another active
administrator using the UI. If none can act, stop for explicit authorization of a reviewed bounded
identity command on one verified ready instance. Do not rerun initialization, alter its latch, add
an initialization job, or open PlanetScale to an operator laptop. If no source-controlled command
fits, recovery is blocked pending a reviewed repository change.
