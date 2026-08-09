# Database recovery

Render PITR always creates a new isolated paid database. This procedure never restores over or
deletes the source. Creating and later deleting recovery resources requires immediate user approval.

The marker helper uses the configured `DATABASE_URL` and prints content-free JSON. Run the exact
commands from the repository root:

```sh
pnpm --filter @capstone/api recovery-marker create --kind pre
pnpm --filter @capstone/api recovery-marker create --kind post
pnpm --filter @capstone/api recovery-marker list
pnpm --filter @capstone/api recovery-marker delete --id "replace-with-marker-uuid"
```

After the disposable recovery resources have been accepted and removed, validate the content-free
JSON evidence before storing it outside the repository:

```sh
pnpm verify:recovery -- "replace-with-safe-evidence.json"
```

The validator recomputes the RPO/RTO limits, requires the current migration and release checks,
confirms the closed integrity/isolation/cleanup fields, and rejects extra fields. It does not run or
claim an external restore rehearsal.

## Rehearsal or incident recovery

1. Record source service/database, UTC incident/rehearsal start, release, migration version, and
   readiness. Create non-sensitive pre/post recovery markers using the approved operator helper.
2. Wait until the intended point is selectable. Choose a UTC restore time with an unambiguous marker
   boundary and an expected RPO no greater than 15 minutes.
3. Trigger seven-day PITR to a new paid database. Do not copy public access rules; keep its allowlist
   empty except for one explicitly approved, temporary validation path.
4. Attach only a disposable isolated validation application/operator command configured with fake
   model delivery and disabled email. Never contact OpenRouter or Resend during validation.
5. Validate PostgreSQL major version, migration ledger, workspace/membership counts, conversation
   constraints, selected leaves, drafts, search indexes, compactions, generations, reservations,
   budget totals, Better Auth tables, and the expected marker boundary. Record counts/status only.
6. Exercise liveness/readiness, dedicated recovery identity sign-in, one isolated fake read/write,
   and reconciliation. Measure observed RPO and elapsed RTO; targets are at most 15 minutes and four
   hours respectively.
7. For a real cutover only: enable maintenance mode, update the private database binding, deploy or
   restart, verify readiness and critical smoke, then disable maintenance mode.
8. If validation fails, leave production on the untouched source and try another restore point only
   with renewed approval.
9. Delete the recovery application/database only after evidence is accepted. Never delete the source
   until a real cutover has been independently accepted and its rollback window has passed.
